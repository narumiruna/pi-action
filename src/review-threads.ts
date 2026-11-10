import { findingMarker } from "./review-output.js"

type GitHubApi = (args: string[]) => string

export type FindingThread = {
  id: string
  comment_id: number
  path: string
  line: number | null
  original_line: number | null
  side: string
  body: string
  original_diff_hunk: string
  original_commit: string
}

type ThreadPage = {
  nodes: {
    id: string
    isResolved: boolean
    path: string
    line: number | null
    originalLine: number | null
    diffSide: string
    comments: {
      nodes: {
        fullDatabaseId: string | null
        body: string
        diffHunk: string
        originalCommit: { oid: string } | null
        author: { __typename: string; login: string } | null
      }[]
    }
  }[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

type ThreadQuery = {
  repository: { pullRequest: { reviewThreads: ThreadPage } | null } | null
}

function graphql<Result>(api: GitHubApi, args: string[]): Result {
  const result = JSON.parse(api(["graphql", ...args])) as {
    data?: Result
    errors?: unknown[]
  }
  if (result.errors?.length || !result.data) {
    throw new Error("GitHub GraphQL request failed.")
  }
  return result.data
}

export function listFindingThreads(
  api: GitHubApi,
  repository: string,
  number: number,
  head: string,
): FindingThread[] {
  const [owner, name] = repository.split("/")
  const threads: FindingThread[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const data: ThreadQuery = graphql(api, [
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
    ])
    const page: ThreadPage | undefined = data.repository?.pullRequest?.reviewThreads
    if (!page) throw new Error("GitHub did not return the pull request review threads.")
    for (const thread of page.nodes) {
      const comment = thread.comments.nodes[0]
      const commentId =
        typeof comment?.fullDatabaseId === "string" && /^[1-9]\d*$/.test(comment.fullDatabaseId)
          ? Number(comment.fullDatabaseId)
          : Number.NaN
      if (
        thread.isResolved ||
        comment?.author?.__typename !== "Bot" ||
        !["github-actions", "github-actions[bot]"].includes(comment.author.login) ||
        !comment.body.startsWith(findingMarker) ||
        !Number.isSafeInteger(commentId) ||
        !comment.originalCommit ||
        comment.originalCommit.oid === head
      ) {
        continue
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
      })
    }
    if (!page.pageInfo.hasNextPage) break
    if (!page.pageInfo.endCursor || cursors.has(page.pageInfo.endCursor)) {
      throw new Error("GitHub returned an invalid review thread cursor.")
    }
    cursor = page.pageInfo.endCursor
    cursors.add(cursor)
  } while (cursor)
  return threads
}

const permissionDenied = "Resource not accessible by integration"

/**
 * Whether resolving a thread failed because the workflow token cannot resolve review threads, such as a
 * read-only token on a fork pull request. Rerunning cannot fix this, unlike transient failures.
 */
export function isResolutionPermissionError(error: unknown) {
  return error instanceof Error && error.message.includes(permissionDenied)
}

export function resolveFindingThread(api: GitHubApi, id: string) {
  const data = graphql<{
    resolveReviewThread: { thread: { id: string; isResolved: boolean } } | null
  }>(api, [
    "-f",
    `query=mutation($id: ID!) {
      resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
    }`,
    "-f",
    `id=${id}`,
  ])
  const thread = data.resolveReviewThread?.thread
  if (thread?.id !== id || thread.isResolved !== true) {
    throw new Error("GitHub did not resolve the review thread.")
  }
}
