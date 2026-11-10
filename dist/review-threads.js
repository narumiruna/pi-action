import { findingMarker } from "./review-output.js";
function graphql(api, args) {
    const result = JSON.parse(api(["graphql", ...args]));
    if (result.errors?.length || !result.data) {
        throw new Error("GitHub GraphQL request failed.");
    }
    return result.data;
}
export function listFindingThreads(api, repository, number, head) {
    const [owner, name] = repository.split("/");
    const threads = [];
    const cursors = new Set();
    let cursor = null;
    do {
        const data = graphql(api, [
            "-f",
            `query=query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              nodes {
                id isResolved path line originalLine diffSide
                comments(first: 1) {
                  nodes {
                    fullDatabaseId body diffHunk originalCommit { oid }
                    author { __typename login }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
            "-F",
            `number=${number}`,
            ...(cursor ? ["-f", `cursor=${cursor}`] : []),
        ]);
        const page = data.repository?.pullRequest?.reviewThreads;
        if (!page)
            throw new Error("GitHub did not return the pull request review threads.");
        for (const thread of page.nodes) {
            const comment = thread.comments.nodes[0];
            const commentId = typeof comment?.fullDatabaseId === "string" && /^[1-9]\d*$/.test(comment.fullDatabaseId)
                ? Number(comment.fullDatabaseId)
                : Number.NaN;
            if (thread.isResolved ||
                comment?.author?.__typename !== "Bot" ||
                !["github-actions", "github-actions[bot]"].includes(comment.author.login) ||
                !comment.body.startsWith(findingMarker) ||
                !Number.isSafeInteger(commentId) ||
                !comment.originalCommit ||
                comment.originalCommit.oid === head) {
                continue;
            }
            threads.push({
                id: thread.id,
                comment_id: commentId,
                path: thread.path,
                line: thread.line,
                original_line: thread.originalLine,
                side: thread.diffSide,
                body: comment.body,
                original_diff_hunk: comment.diffHunk,
                original_commit: comment.originalCommit.oid,
            });
        }
        if (!page.pageInfo.hasNextPage)
            break;
        if (!page.pageInfo.endCursor || cursors.has(page.pageInfo.endCursor)) {
            throw new Error("GitHub returned an invalid review thread cursor.");
        }
        cursor = page.pageInfo.endCursor;
        cursors.add(cursor);
    } while (cursor);
    return threads;
}
const permissionDenied = "Resource not accessible by integration";
/**
 * Whether resolving a thread failed because the workflow token cannot resolve review threads, such as a
 * read-only token on a fork pull request. Rerunning cannot fix this, unlike transient failures.
 */
export function isResolutionPermissionError(error) {
    return error instanceof Error && error.message.includes(permissionDenied);
}
export function resolveFindingThread(api, id) {
    const data = graphql(api, [
        "-f",
        `query=mutation($id: ID!) {
      resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
    }`,
        "-f",
        `id=${id}`,
    ]);
    const thread = data.resolveReviewThread?.thread;
    if (thread?.id !== id || thread.isResolved !== true) {
        throw new Error("GitHub did not resolve the review thread.");
    }
}
