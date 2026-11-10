import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { escapeCommand, withPi } from "./pi.js"
import { buildReview, summaryMarker } from "./review-output.js"
import {
  isResolutionPermissionError,
  listFindingThreads,
  resolveFindingThread,
} from "./review-threads.js"

type GitHubComment = {
  id: number
  user?: { login?: string } | null
  body?: string | null
  path?: string
  line?: number | null
  original_line?: number | null
  side?: string | null
  start_line?: number | null
  original_start_line?: number | null
  start_side?: string | null
  original_commit_id?: string
  in_reply_to_id?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function commitIds(pullRequest: unknown) {
  const base =
    isObject(pullRequest) && isObject(pullRequest.base) ? pullRequest.base.sha : undefined
  const head =
    isObject(pullRequest) && isObject(pullRequest.head) ? pullRequest.head.sha : undefined
  if (
    typeof base !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(base) ||
    typeof head !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(head)
  ) {
    throw new Error("The pull request must contain valid base/head commit IDs.")
  }
  return { base, head }
}

function reviewPullRequest() {
  const env = process.env
  const eventName = env.GITHUB_EVENT_NAME
  if (!["pull_request", "pull_request_target", "workflow_dispatch"].includes(eventName ?? "")) {
    throw new Error(
      "This action requires a pull_request, pull_request_target, or workflow_dispatch event.",
    )
  }

  const manual = eventName === "workflow_dispatch"
  let event: unknown
  if (!manual) {
    const eventPath = env.GITHUB_EVENT_PATH
    if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required.")
    event = JSON.parse(readFileSync(eventPath, "utf8"))
  }
  const input = env.PI_PULL_REQUEST?.trim() ?? ""
  const number = manual
    ? /^[1-9]\d*$/.test(input)
      ? Number(input)
      : undefined
    : isObject(event)
      ? event.number
      : undefined
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("A positive safe integer pull request number is required.")
  }
  const eventCommits = manual
    ? undefined
    : commitIds(isObject(event) ? event.pull_request : undefined)

  withPi(".pi/prompts/review-pull-request.md", ({ directory, options, run }) => {
    const repository = `repos/${env.GITHUB_REPOSITORY}`
    const api = (args: string[]) => execFileSync("gh", ["api", ...args], options).trim()
    const { base, head } =
      eventCommits ??
      commitIds(JSON.parse(execFileSync("gh", ["api", `${repository}/pulls/${number}`], options)))
    const diff = execFileSync(
      "gh",
      [
        "api",
        `${repository}/compare/${base}...${head}`,
        "--header",
        "Accept: application/vnd.github.diff",
      ],
      options,
    )
    if (!diff.trim()) throw new Error("The pull request diff is empty.")
    const threads = listFindingThreads(api, env.GITHUB_REPOSITORY ?? "", number, head)
    const inputPath = join(directory, threads.length ? "review-input.json" : "diff.patch")
    writeFileSync(
      inputPath,
      threads.length ? JSON.stringify({ diff, unresolved_threads: threads }) : diff,
    )

    const review = run(
      inputPath,
      "Review the attached current pull request diff and recheck any supplied unresolved findings.",
    )
    if (!review) throw new Error("Pi returned an empty review.")
    const pullRequestUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/pull/${number}`
    const report = buildReview(
      review,
      diff,
      head,
      pullRequestUrl,
      threads.map((thread) => thread.id),
    )
    const list = (endpoint: string): GitHubComment[] =>
      (JSON.parse(api([endpoint, "--paginate", "--slurp"])) as GitHubComment[][]).flat()
    const request = (
      method: "PATCH" | "POST",
      endpoint: string,
      payload: Record<string, unknown>,
    ) => {
      const requestPath = join(directory, "request.json")
      writeFileSync(requestPath, JSON.stringify(payload))
      return JSON.parse(api(["--method", method, endpoint, "--input", requestPath])) as {
        html_url: string
      }
    }
    const isPiBot = (comment: GitHubComment) => comment.user?.login === "github-actions[bot]"
    const commentKey = (comment: Partial<GitHubComment>) =>
      JSON.stringify([
        comment.path,
        comment.original_line ?? comment.line,
        comment.side,
        comment.original_start_line ?? comment.start_line ?? null,
        comment.start_side ?? null,
        comment.body,
      ])

    const summaries = list(`${repository}/issues/${number}/comments`)
    const previous = summaries.find(
      (comment) => isPiBot(comment) && comment.body?.startsWith(summaryMarker),
    )
    const inlineComments =
      report.comments.length || report.resolvedThreads.length
        ? list(`${repository}/pulls/${number}/comments`)
        : []
    const published = new Set(
      inlineComments
        .filter((comment) => isPiBot(comment) && comment.original_commit_id === head)
        .map(commentKey),
    )
    const comments = report.comments.filter((comment) => {
      const key = commentKey(comment)
      if (published.has(key)) return false
      published.add(key)
      return true
    })

    const assertHead = () => {
      if (api([`${repository}/pulls/${number}`, "--jq", ".head.sha"]) !== head) {
        throw new Error("The pull request head changed during review. Rerun on the latest commit.")
      }
    }
    assertHead()
    const summary = request(
      previous ? "PATCH" : "POST",
      previous
        ? `${repository}/issues/comments/${previous.id}`
        : `${repository}/issues/${number}/comments`,
      { body: report.body },
    )
    console.log(`Summary ${previous ? "updated" : "posted"}: ${summary.html_url}`)

    if (comments.length) {
      const posted = request("POST", `${repository}/pulls/${number}/reviews`, {
        body: `Inline findings for [\`${head.slice(0, 7)}\`](${pullRequestUrl}/commits/${head}). See the [Pi review summary](${summary.html_url}).`,
        event: "COMMENT",
        commit_id: head,
        comments,
      })
      console.log(`Review posted: ${posted.html_url}`)
    }

    for (const thread of threads) {
      const resolution = report.resolvedThreads.find((item) => item.id === thread.id)
      if (!resolution) continue
      assertHead()
      const marker = `<!-- pi-action:resolution:${head} -->`
      const explained = inlineComments.some(
        (comment) =>
          isPiBot(comment) &&
          comment.in_reply_to_id === thread.comment_id &&
          comment.body?.startsWith(`${marker}\n`),
      )
      if (!explained) {
        request("POST", `${repository}/pulls/${number}/comments/${thread.comment_id}/replies`, {
          body: `${marker}\nFixed in [\`${head.slice(0, 7)}\`](${pullRequestUrl}/commits/${head}): ${resolution.reason}`,
        })
      }
      assertHead()
      try {
        resolveFindingThread(api, thread.id)
      } catch (error) {
        if (!isResolutionPermissionError(error)) throw error
        // The fix explanation is already posted; only the thread state could not change.
        console.log(
          `::warning::${escapeCommand(`The workflow token cannot resolve review threads, so ${pullRequestUrl}#discussion_r${thread.comment_id} stays open. The fix explanation was posted.`)}`,
        )
        continue
      }
      console.log(`Thread resolved: ${pullRequestUrl}#discussion_r${thread.comment_id}`)
    }
  })
}

try {
  reviewPullRequest()
} catch (error) {
  console.error(`::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
}
