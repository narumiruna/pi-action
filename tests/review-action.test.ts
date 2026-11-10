import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, test } from "vitest"

const actionPath = resolve("review")
const manifest = readFileSync(join(actionPath, "action.yml"), "utf8")
const runCommand = manifest.match(/^ {6}run: (node .+)$/m)?.[1]
const roots: string[] = []
const base = "a".repeat(40)
const head = "b".repeat(40)
const pullRequest = {
  base: { sha: base, repo: { full_name: "owner/repo" } },
  head: { sha: head, repo: { full_name: "contributor/fork" } },
}
const diff =
  "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n"

const summaryMarker = "<!-- pi-action:summary -->"
const noFindings = { summary: "No actionable findings found in the supplied diff.", findings: [] }
const finding = {
  severity: "high",
  title: "Preserve the expected behavior",
  body: "The changed line breaks the existing behavior. Restore the original behavior.",
  location: { path: "example.ts", line: 1, side: "RIGHT" },
}
const inlineBody = `<!-- pi-action:finding -->\n**High: ${finding.title}**\n\n${finding.body}`
const bot = { login: "github-actions[bot]", type: "Bot" }
const withFinding = JSON.stringify({ summary: "One issue found.", findings: [finding] })
const previousThread = {
  id: "PRRT_1",
  isResolved: false,
  path: "example.ts",
  line: null,
  originalLine: 1,
  diffSide: "RIGHT",
  comments: {
    nodes: [
      {
        fullDatabaseId: "41",
        body: inlineBody,
        diffHunk: diff,
        originalCommit: { oid: base },
        author: { __typename: "Bot", login: "github-actions" },
      },
    ],
  },
}
const reason = "The new guard rejects missing values before they are used."
const fixedReview = JSON.stringify({
  ...noFindings,
  resolved_threads: [{ id: previousThread.id, reason }],
})

const mockCommand = String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const env = process.env;
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
appendFileSync(join(env.MOCK_ROOT, "commands.jsonl"), JSON.stringify({ command, args }) + "\n");
function fail(stage) {
  if (env.MOCK_FAILURE === stage) {
    console.error("mock " + stage + " failure");
    process.exit(1);
  }
}
if (command === "gh") {
  const endpoint = args.find(value => value.startsWith("repos/"));
  const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
  if (args[1] === "graphql") {
    const query = args.find(value => value.startsWith("query="));
    if (query.includes("resolveReviewThread")) {
      fail("resolve");
      if (env.MOCK_RESOLVE_FORBIDDEN) {
        console.error("gh: Resource not accessible by integration");
        process.exit(1);
      }
      if (env.MOCK_GRAPHQL_ERRORS) {
        console.log(JSON.stringify({ errors: [{ message: "Resolution denied." }] }));
      } else {
        const id = args.find(value => value.startsWith("id=")).slice(3);
        appendFileSync(join(env.MOCK_ROOT, "resolved.jsonl"), JSON.stringify({ id }) + "\n");
        console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } }));
      }
    } else {
      fail("list-threads");
      console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: JSON.parse(env.MOCK_THREADS),
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } }));
    }
  } else if (endpoint.includes("/compare/")) {
    fail("fetch");
    process.stdout.write(env.MOCK_EMPTY_DIFF ? "" : env.MOCK_DIFF);
  } else if (method === "GET" && endpoint.endsWith("/issues/42/comments")) {
    fail("list-summaries");
    process.stdout.write(env.MOCK_SUMMARIES);
  } else if (method === "GET" && endpoint.endsWith("/pulls/42/comments")) {
    fail("list-inline");
    process.stdout.write(env.MOCK_INLINE_COMMENTS);
  } else if (method === "GET" && endpoint.endsWith("/pulls/42")) {
    const checkingHead = args.includes("--jq");
    fail(checkingHead ? "head" : "metadata");
    if (checkingHead && env.MOCK_HEADS) {
      const heads = JSON.parse(env.MOCK_HEADS);
      const counter = join(env.MOCK_ROOT, "head-checks");
      const index = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
      writeFileSync(counter, String(index + 1));
      process.stdout.write(heads[Math.min(index, heads.length - 1)]);
    } else {
      process.stdout.write(checkingHead ? env.MOCK_CURRENT_HEAD : env.MOCK_PULL_REQUEST);
    }
  } else if (method === "POST" && endpoint.endsWith("/replies")) {
    fail("reply");
    const payload = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    appendFileSync(join(env.MOCK_ROOT, "replies.jsonl"), JSON.stringify({ endpoint, ...payload }) + "\n");
    console.log(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#discussion_r43" }));
  } else if (method === "POST" && endpoint.endsWith("/reviews")) {
    fail("review");
    writeFileSync(join(env.MOCK_ROOT, "posted.json"), readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    console.log(JSON.stringify({ id: 1, html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-1" }));
  } else if ((method === "POST" && endpoint.endsWith("/issues/42/comments")) ||
    (method === "PATCH" && endpoint.includes("/issues/comments/"))) {
    fail("summary");
    writeFileSync(join(env.MOCK_ROOT, "summary.json"), readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    const id = method === "PATCH" ? Number(endpoint.split("/").pop()) : 99;
    console.log(JSON.stringify({ id, html_url: "https://github.com/owner/repo/pull/42#issuecomment-" + id }));
  } else {
    throw new Error("Unexpected GitHub request: " + JSON.stringify(args));
  }
} else {
  const directory = env.PI_CODING_AGENT_DIR;
  const modelPath = join(directory, "models.json");
  writeFileSync(join(env.MOCK_ROOT, "pi.json"), JSON.stringify({
    args,
    cwd: process.cwd(),
    directory,
    auth: JSON.parse(readFileSync(join(directory, "auth.json"), "utf8")),
    mode: statSync(join(directory, "auth.json")).mode & 0o777,
    models: existsSync(modelPath) ? JSON.parse(readFileSync(modelPath, "utf8")) : null,
    diff: readFileSync(args.find(value => value.startsWith("@")).slice(1), "utf8"),
    githubToken: env.GH_TOKEN,
    alternateToken: env.GITHUB_TOKEN,
    apiKeyInput: env.PI_API_KEY,
    authJsonInput: env.PI_AUTH_JSON,
  }));
  fail("pi");
  process.stdout.write(env.MOCK_EMPTY_REVIEW ? "" : env.MOCK_REVIEW);
}
`

function runAction(
  overrides: Record<string, string> = {},
  promptPath?: string,
  event: unknown = { number: 42, pull_request: pullRequest },
) {
  const root = mkdtempSync(join(tmpdir(), "pi-review-test-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const runner = join(root, "runner")
  const bin = join(root, "bin")
  for (const directory of [workspace, runner, bin]) mkdirSync(directory)
  for (const command of ["gh", "pi"]) {
    writeFileSync(join(bin, command), mockCommand, { mode: 0o755 })
  }
  const eventPath = join(root, "event.json")
  writeFileSync(eventPath, JSON.stringify(event))
  if (promptPath) {
    const fullPath = join(workspace, promptPath)
    mkdirSync(resolve(fullPath, ".."), { recursive: true })
    writeFileSync(fullPath, "Custom review instructions.")
  }
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", runCommand ?? "exit 1"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: "github-token",
        GITHUB_TOKEN: "alternate-github-token",
        GITHUB_ACTION_PATH: actionPath,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runner,
        PI_PROVIDER: "openai",
        PI_MODEL: "gpt-6.1-sol",
        PI_PULL_REQUEST: "",
        PI_API_KEY: "test-api-key",
        PI_AUTH_JSON: "",
        PI_BASE_URL: "",
        PI_THINKING: "medium",
        PI_PROMPT: ".pi/prompts/review-pull-request.md",
        MOCK_ROOT: root,
        MOCK_DIFF: diff,
        MOCK_REVIEW: JSON.stringify(noFindings),
        MOCK_SUMMARIES: "[[]]",
        MOCK_INLINE_COMMENTS: "[[]]",
        MOCK_THREADS: "[]",
        MOCK_CURRENT_HEAD: head,
        MOCK_PULL_REQUEST: JSON.stringify(pullRequest),
        ...overrides,
      },
    },
  )
  expect(result.error).toBeUndefined()
  const json = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"))
  expect(readdirSync(runner)).toEqual([])
  return { result, root, workspace, json }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function copyDistribution() {
  const root = mkdtempSync(join(tmpdir(), "pi-review-dist-"))
  roots.push(root)
  const directory = join(root, "action distribution")
  for (const path of ["dist", ".pi/prompts", "package.json"]) {
    cpSync(resolve(path), join(directory, path), { recursive: true })
  }
  mkdirSync(join(directory, "review"))
  return directory
}

test("the review manifest launches the compiled entry point from its action directory", () => {
  expect(runCommand).toBe('node "$GITHUB_ACTION_PATH/../dist/review.js"')
  expect(manifest).toContain(`PI_PULL_REQUEST: \${{ inputs.pull-request }}`)
})

test("runs the manifest from a distribution-only action directory with spaces", () => {
  const directory = copyDistribution()
  expect(readdirSync(directory).sort()).toEqual([".pi", "dist", "package.json", "review"])
  const { result, json } = runAction({ GITHUB_ACTION_PATH: join(directory, "review") })
  expect(result.status, result.stderr).toBe(0)
  const args = json("pi.json").args
  expect(args[args.indexOf("--system-prompt") + 1]).toBe(
    join(directory, ".pi/prompts/review-pull-request.md"),
  )
})

test.each([
  ["dist/pi.js", "ERR_MODULE_NOT_FOUND"],
  ["dist/oauth-secret.js", "ERR_MODULE_NOT_FOUND"],
  ["dist/auth.js", "ERR_MODULE_NOT_FOUND"],
  ["dist/auth-file.js", "ERR_MODULE_NOT_FOUND"],
  ["dist/review-threads.js", "ERR_MODULE_NOT_FOUND"],
  [".pi/prompts/review-pull-request.md", "The prompt file does not exist."],
])("fails safely when the distribution is missing %s", (path, message) => {
  const directory = copyDistribution()
  rmSync(join(directory, path))
  const { result, root } = runAction({ GITHUB_ACTION_PATH: join(directory, "review") })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(message)
  expect(existsSync(join(root, "commands.jsonl"))).toBe(false)
})

test.each(["pull_request", "pull_request_target"])(
  "reviews the exact %s commits with the API key and bundled prompt",
  (eventName) => {
    const { result, json, root } = runAction({
      GITHUB_EVENT_NAME: eventName,
      PI_PULL_REQUEST: "99",
    })
    expect(result.status, result.stderr).toBe(0)
    const commands = readFileSync(join(root, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(commands[0]).toEqual({
      command: "gh",
      args: [
        "api",
        `repos/owner/repo/compare/${base}...${head}`,
        "--header",
        "Accept: application/vnd.github.diff",
      ],
    })
    const pi = json("pi.json")
    expect(pi.auth).toEqual({ openai: { type: "api_key", key: "test-api-key" } })
    expect(pi.mode).toBe(0o600)
    expect(pi.cwd).toBe(pi.directory)
    expect(pi.models).toBeNull()
    expect(pi.diff).toBe(diff)
    expect(pi.args).toEqual(
      expect.arrayContaining([
        "--print",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--provider",
        "openai",
        "--model",
        "gpt-6.1-sol",
        "--thinking",
        "medium",
        resolve(".pi/prompts/review-pull-request.md"),
      ]),
    )
    for (const name of ["githubToken", "alternateToken", "apiKeyInput", "authJsonInput"]) {
      expect(pi[name]).toBeUndefined()
    }
    const summary = json("summary.json")
    expect(summary).toEqual({ body: expect.stringContaining(summaryMarker) })
    expect(summary.body).toContain(noFindings.summary)
    expect(summary.body).toContain(head)
    expect(summary.body).toContain("This review covers only the supplied diff.")
    expect(existsSync(join(root, "posted.json"))).toBe(false)
    expect(result.stdout).toContain(
      "Summary posted: https://github.com/owner/repo/pull/42#issuecomment-99",
    )
  },
)

test("reviews the current pull request commits for a manual dispatch", () => {
  const { result, root, json } = runAction({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_EVENT_PATH: "",
    PI_PULL_REQUEST: " 42 ",
  })
  expect(result.status, result.stderr).toBe(0)
  expect(commands(root).slice(0, 2)).toEqual([
    { command: "gh", args: ["api", "repos/owner/repo/pulls/42"] },
    {
      command: "gh",
      args: [
        "api",
        `repos/owner/repo/compare/${base}...${head}`,
        "--header",
        "Accept: application/vnd.github.diff",
      ],
    },
  ])
  expect(json("summary.json").body).toContain(head)
  expect(json("pi.json").args).toContain("--no-tools")
  expect(json("pi.json").githubToken).toBeUndefined()
})

test.each(["", "0", "-1", "1.5", "1e2", "42/../43", "9007199254740992"])(
  "rejects an invalid manual pull request number %j before invoking commands",
  (input) => {
    const { result, root } = runAction({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      PI_PULL_REQUEST: input,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("positive safe integer pull request number")
    expect(existsSync(join(root, "commands.jsonl"))).toBe(false)
  },
)

test.each([
  null,
  {},
  { number: 0, pull_request: pullRequest },
  { number: "42", pull_request: pullRequest },
  { number: 42, pull_request: { base: { sha: "invalid" }, head: { sha: head } } },
])("rejects malformed pull request target metadata %j", (event) => {
  const { result, root } = runAction({ GITHUB_EVENT_NAME: "pull_request_target" }, undefined, event)
  expect(result.status).toBe(1)
  expect(existsSync(join(root, "commands.jsonl"))).toBe(false)
})

test.each([null, {}, { base: { sha: base }, head: { sha: "invalid" } }])(
  "rejects invalid manual pull request metadata %j before running Pi",
  (metadata) => {
    const { result, root } = runAction({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      PI_PULL_REQUEST: "42",
      MOCK_PULL_REQUEST: JSON.stringify(metadata),
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("valid base/head commit IDs")
    expect(commands(root)).toEqual([{ command: "gh", args: ["api", "repos/owner/repo/pulls/42"] }])
    expect(existsSync(join(root, "summary.json"))).toBe(false)
  },
)

test("cleans credentials without publishing when manual metadata retrieval fails", () => {
  const { result, root } = runAction({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    PI_PULL_REQUEST: "42",
    MOCK_FAILURE: "metadata",
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("mock metadata failure")
  expect(commands(root)).toHaveLength(1)
  expect(existsSync(join(root, "summary.json"))).toBe(false)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test("loads only the selected OAuth credential from auth-json", () => {
  const credential = {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 9999999999999,
  }
  const { result, json } = runAction({
    PI_API_KEY: "",
    PI_AUTH_JSON: JSON.stringify({
      openai: credential,
      "unused-provider": { type: "api_key", key: "unused-key" },
    }),
    PI_PROVIDER: "openai",
    PI_MODEL: "gpt-6.1-sol",
    PI_THINKING: "high",
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("pi.json").auth).toEqual({ openai: credential })
  expect(json("pi.json").args).toEqual(expect.arrayContaining(["openai", "gpt-6.1-sol", "high"]))
  expect(result.stdout).toContain("::add-mask::access-token")
  expect(result.stdout).toContain("::add-mask::refresh-token")
  expect(result.stdout).not.toContain("unused-key")
})

test("loads an API key credential from auth-json", () => {
  const credential = { type: "api_key", key: "stored-api-key" }
  const { result, json } = runAction({
    PI_API_KEY: "",
    PI_AUTH_JSON: JSON.stringify({ openai: credential }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("pi.json").auth).toEqual({ openai: credential })
})

test.each(["", 123])("rejects an invalid auth-json API key %j", (key) => {
  const { result, root } = runAction({
    PI_API_KEY: "",
    PI_AUTH_JSON: JSON.stringify({ openai: { type: "api_key", key } }),
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("non-empty string")
  expect(existsSync(join(root, "commands.jsonl"))).toBe(false)
})

test("sets the provider base URL without replacing its model catalog", () => {
  const { result, json } = runAction({ PI_BASE_URL: "https://proxy.example.com/v1" })
  expect(result.status, result.stderr).toBe(0)
  expect(json("pi.json").models).toEqual({
    providers: { openai: { baseUrl: "https://proxy.example.com/v1" } },
  })
})

test.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
  "passes thinking=%s to Pi",
  (thinking) => {
    const { result, json } = runAction({ PI_THINKING: thinking })
    expect(result.status, result.stderr).toBe(0)
    const args = json("pi.json").args
    expect(args[args.indexOf("--thinking") + 1]).toBe(thinking)
  },
)

test.each(["custom prompt.md", ".pi/prompts/review-pull-request.md"])(
  "loads the workspace prompt at %s",
  (prompt) => {
    const { result, json, workspace } = runAction({ PI_PROMPT: prompt }, prompt)
    expect(result.status, result.stderr).toBe(0)
    expect(json("pi.json").args).toContain(join(workspace, prompt))
  },
)

test.each([
  [{ PI_API_KEY: "" }, "Provide exactly one"],
  [{ PI_AUTH_JSON: "{}" }, "Provide exactly one"],
  [{ PI_API_KEY: "", PI_AUTH_JSON: "invalid-secret-json" }, "valid JSON"],
  [{ PI_API_KEY: "", PI_AUTH_JSON: "{}" }, "credential for provider"],
  [{ PI_PROVIDER: "" }, "provider and model"],
  [{ PI_MODEL: "" }, "provider and model"],
  [{ PI_THINKING: "invalid" }, "Invalid thinking"],
  [{ PI_BASE_URL: "file:///tmp/model" }, "HTTP or HTTPS"],
  [{ PI_PROMPT: "missing.md" }, "prompt file does not exist"],
  [
    { GITHUB_EVENT_NAME: "push" },
    "requires a pull_request, pull_request_target, or workflow_dispatch event",
  ],
  [{ GITHUB_EVENT_PATH: "" }, "GITHUB_EVENT_PATH is required"],
  [{ GITHUB_WORKSPACE: "" }, "GITHUB_WORKSPACE and RUNNER_TEMP are required"],
  [{ RUNNER_TEMP: "" }, "GITHUB_WORKSPACE and RUNNER_TEMP are required"],
])("rejects invalid inputs %j before invoking commands", (overrides, message) => {
  const { result, root } = runAction(overrides)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(message)
  expect(result.stderr).not.toContain("invalid-secret-json")
  expect(existsSync(join(root, "commands.jsonl"))).toBe(false)
})

test.each(["fetch", "list-threads", "pi", "list-summaries", "head", "summary"])(
  "cleans credentials after a %s failure",
  (stage) => {
    const { result, root } = runAction({ MOCK_FAILURE: stage })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`mock ${stage} failure`)
    expect(existsSync(join(root, "summary.json"))).toBe(false)
    expect(existsSync(join(root, "posted.json"))).toBe(false)
  },
)

test.each([
  [{ MOCK_EMPTY_DIFF: "1" }, "diff is empty"],
  [{ MOCK_EMPTY_REVIEW: "1" }, "empty review"],
])("does not post an empty result %j", (overrides, message) => {
  const { result, root } = runAction(overrides)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(message)
  expect(existsSync(join(root, "summary.json"))).toBe(false)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

function commands(root: string) {
  return readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

test("creates the summary before submitting inline comments at the exact head", () => {
  const { result, json, root } = runAction({ MOCK_REVIEW: withFinding })
  expect(result.status, result.stderr).toBe(0)
  const posted = json("posted.json")
  expect(posted).toEqual({
    body: `Inline findings for [\`bbbbbbb\`](https://github.com/owner/repo/pull/42/commits/${head}). See the [Pi review summary](https://github.com/owner/repo/pull/42#issuecomment-99).`,
    event: "COMMENT",
    commit_id: head,
    comments: [{ path: "example.ts", line: 1, side: "RIGHT", body: inlineBody }],
  })
  const calls = commands(root)
  const writes = calls.filter((call) => call.args.includes("POST"))
  expect(writes.map((call) => call.args[3])).toEqual([
    "repos/owner/repo/issues/42/comments",
    "repos/owner/repo/pulls/42/reviews",
  ])
  for (const endpoint of ["issues/42/comments", "pulls/42/comments"]) {
    expect(calls).toContainEqual({
      command: "gh",
      args: ["api", `repos/owner/repo/${endpoint}`, "--paginate", "--slurp"],
    })
  }
})

test.each(["https://github.com", "https://github.example.com"])(
  "uses %s and the base repository for review links",
  (serverUrl) => {
    const { result, json } = runAction({
      GITHUB_SERVER_URL: serverUrl,
      MOCK_REVIEW: withFinding,
    })
    expect(result.status, result.stderr).toBe(0)
    const pullRequestUrl = `${serverUrl}/owner/repo/pull/42`
    const summary = json("summary.json").body
    expect(summary).toContain(`[\`bbbbbbb\`](${pullRequestUrl}/commits/${head})`)
    expect(summary).toContain(
      `[\`example.ts:1\`](${pullRequestUrl}/files/${head}#diff-c2367a00abc15282c1e43ae86544aef6825813116411291ec398336737cee78cR1 "example.ts")`,
    )
    expect(summary).not.toContain("contributor/fork")
    expect(json("posted.json").body).toContain(`[\`bbbbbbb\`](${pullRequestUrl}/commits/${head})`)
  },
)

test("updates the first Pi summary across paginated comments and preserves other authors", () => {
  const pages = [
    [
      { id: 1, user: { login: "owner", type: "User" }, body: summaryMarker },
      { id: 2, user: { login: "other[bot]", type: "Bot" }, body: summaryMarker },
      { id: 3, user: bot, body: "Another workflow comment." },
    ],
    [
      { id: 4, user: bot, body: `${summaryMarker}\nOld finding.` },
      { id: 5, user: bot, body: `${summaryMarker}\nDuplicate old summary.` },
    ],
  ]
  const { result, root, json } = runAction({ MOCK_SUMMARIES: JSON.stringify(pages) })
  expect(result.status, result.stderr).toBe(0)
  const writes = commands(root).filter(
    (call) => call.args.includes("PATCH") || call.args.includes("POST"),
  )
  expect(writes).toHaveLength(1)
  expect(writes[0].args.slice(0, 4)).toEqual([
    "api",
    "--method",
    "PATCH",
    "repos/owner/repo/issues/comments/4",
  ])
  expect(json("summary.json").body).not.toContain("Old finding.")
  expect(result.stdout).toContain("Summary updated:")
})

test("does not replace a human or another bot comment that contains the summary marker", () => {
  const pages = [
    [
      { id: 1, user: { login: "owner", type: "User" }, body: summaryMarker },
      { id: 2, user: { login: "other[bot]", type: "Bot" }, body: summaryMarker },
    ],
  ]
  const { result, root } = runAction({ MOCK_SUMMARIES: JSON.stringify(pages) })
  expect(result.status, result.stderr).toBe(0)
  expect(commands(root).some((call) => call.args.includes("PATCH"))).toBe(false)
  expect(result.stdout).toContain("Summary posted:")
})

test("posts multiline and deleted-line findings using GitHub review coordinates", () => {
  const rangedDiff = [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -8,2 +8,3 @@",
    " context",
    "-removed",
    "+first",
    "+second",
    "",
  ].join("\n")
  const { result, json } = runAction({
    MOCK_DIFF: rangedDiff,
    MOCK_REVIEW: JSON.stringify({
      summary: "Two issues found.",
      findings: [
        { ...finding, location: { path: "example.ts", line: 10, start_line: 9, side: "RIGHT" } },
        { ...finding, location: { path: "example.ts", line: 9, side: "LEFT" } },
      ],
    }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("posted.json").comments).toEqual([
    {
      path: "example.ts",
      line: 10,
      side: "RIGHT",
      start_line: 9,
      start_side: "RIGHT",
      body: inlineBody,
    },
    { path: "example.ts", line: 9, side: "LEFT", body: inlineBody },
  ])
})

test("keeps an out-of-diff finding in the summary without posting an invalid inline review", () => {
  const { result, json, root } = runAction({
    MOCK_REVIEW: JSON.stringify({
      summary: "One issue found.",
      findings: [{ ...finding, location: { ...finding.location, line: 999 } }],
    }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("summary.json").body).toContain(finding.body)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

const postedFinding = {
  user: bot,
  commit_id: head,
  original_commit_id: head,
  path: "example.ts",
  line: null,
  original_line: 1,
  side: "RIGHT",
  start_line: null,
  original_start_line: null,
  start_side: null,
  body: inlineBody,
}

test("updates the summary but skips identical inline findings already posted at the same head", () => {
  const { result, root } = runAction({
    MOCK_REVIEW: withFinding,
    MOCK_INLINE_COMMENTS: JSON.stringify([[], [postedFinding]]),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(root, "summary.json"))).toBe(true)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test("uses the original commit and coordinates when GitHub remaps an existing finding", () => {
  const { result, root } = runAction({
    MOCK_REVIEW: withFinding,
    MOCK_INLINE_COMMENTS: JSON.stringify([
      [{ ...postedFinding, commit_id: base, line: 42, original_line: 1 }],
    ]),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(root, "summary.json"))).toBe(true)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test.each([
  { original_commit_id: base },
  { user: { login: "other[bot]", type: "Bot" } },
  { body: "A different finding." },
  { original_line: 2 },
])("does not suppress a new inline finding because of a different comment %j", (override) => {
  const { result, json } = runAction({
    MOCK_REVIEW: withFinding,
    MOCK_INLINE_COMMENTS: JSON.stringify([[{ ...postedFinding, ...override }]]),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("posted.json").comments).toHaveLength(1)
})

test("does not submit duplicate inline findings in the same batch", () => {
  const { result, json } = runAction({
    MOCK_REVIEW: JSON.stringify({ summary: "One issue found.", findings: [finding, finding] }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("posted.json").comments).toHaveLength(1)
})

test.each(["pull_request", "pull_request_target", "workflow_dispatch"])(
  "does not publish a stale summary or inline review for %s if the head changes",
  (eventName) => {
    const { result, root } = runAction({
      GITHUB_EVENT_NAME: eventName,
      PI_PULL_REQUEST: "42",
      MOCK_REVIEW: withFinding,
      MOCK_CURRENT_HEAD: base,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("head changed")
    expect(existsSync(join(root, "summary.json"))).toBe(false)
    expect(existsSync(join(root, "posted.json"))).toBe(false)
  },
)

test("rejects invalid model output before making comment API requests", () => {
  const { result, root } = runAction({ MOCK_REVIEW: "Not JSON." })
  expect(result.status).toBe(1)
  const calls = commands(root).filter((call) => call.command === "gh")
  expect(calls).toHaveLength(2)
  expect(calls.every((call) => !call.args.includes("--method"))).toBe(true)
  expect(existsSync(join(root, "summary.json"))).toBe(false)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test("cleans credentials without writes when listing inline comments fails", () => {
  const { result, root } = runAction({ MOCK_REVIEW: withFinding, MOCK_FAILURE: "list-inline" })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("mock list-inline failure")
  expect(existsSync(join(root, "summary.json"))).toBe(false)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

function jsonLines(root: string, name: string) {
  return readFileSync(join(root, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

function resolutionCalls(root: string) {
  return commands(root).filter((call) =>
    call.args.some((argument: string) => argument.startsWith("query=mutation")),
  )
}

test("posts a short fix explanation before resolving a verified Pi finding", () => {
  const { result, root, json } = runAction({
    MOCK_THREADS: JSON.stringify([previousThread]),
    MOCK_REVIEW: fixedReview,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(json("pi.json").diff)).toEqual({
    diff,
    unresolved_threads: [
      {
        id: previousThread.id,
        comment_id: 41,
        path: "example.ts",
        line: null,
        original_line: 1,
        side: "RIGHT",
        body: inlineBody,
        original_diff_hunk: diff,
        original_commit: base,
      },
    ],
  })
  expect(jsonLines(root, "replies.jsonl")).toEqual([
    {
      endpoint: "repos/owner/repo/pulls/42/comments/41/replies",
      body: `<!-- pi-action:resolution:${head} -->\nFixed in [\`bbbbbbb\`](https://github.com/owner/repo/pull/42/commits/${head}): ${reason}`,
    },
  ])
  expect(jsonLines(root, "resolved.jsonl")).toEqual([{ id: previousThread.id }])
  const calls = commands(root)
  const summaryIndex = calls.findIndex((call) => call.args.includes("POST"))
  const replyIndex = calls.findIndex((call) =>
    call.args.includes("repos/owner/repo/pulls/42/comments/41/replies"),
  )
  const resolveIndex = calls.findIndex((call) => call.args.includes(`id=${previousThread.id}`))
  expect(summaryIndex).toBeLessThan(replyIndex)
  expect(replyIndex).toBeLessThan(resolveIndex)
  expect(calls[resolveIndex - 1].args).toContain(".head.sha")
  expect(existsSync(join(root, "posted.json"))).toBe(false)
  expect(result.stdout).toContain(
    "Thread resolved: https://github.com/owner/repo/pull/42#discussion_r41",
  )
})

test.each([noFindings, { ...noFindings, resolved_threads: [] }, JSON.parse(withFinding)])(
  "keeps earlier findings open when the model does not verify a fix: %j",
  (review) => {
    const { result, root } = runAction({
      MOCK_THREADS: JSON.stringify([previousThread]),
      MOCK_REVIEW: JSON.stringify(review),
    })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(root, "replies.jsonl"))).toBe(false)
    expect(resolutionCalls(root)).toEqual([])
  },
)

test("resolves only the supplied thread selected by the model", () => {
  const second = {
    ...previousThread,
    id: "PRRT_2",
    comments: { nodes: [{ ...previousThread.comments.nodes[0], fullDatabaseId: "42" }] },
  }
  const { result, root } = runAction({
    MOCK_THREADS: JSON.stringify([previousThread, second]),
    MOCK_REVIEW: fixedReview,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(jsonLines(root, "replies.jsonl")).toHaveLength(1)
  expect(jsonLines(root, "resolved.jsonl")).toEqual([{ id: previousThread.id }])
})

test("does not recheck a finding first posted at the current head", () => {
  const sameHead = {
    ...previousThread,
    comments: { nodes: [{ ...previousThread.comments.nodes[0], originalCommit: { oid: head } }] },
  }
  const { result, root, json } = runAction({ MOCK_THREADS: JSON.stringify([sameHead]) })
  expect(result.status, result.stderr).toBe(0)
  expect(json("pi.json").diff).toBe(diff)
  expect(resolutionCalls(root)).toEqual([])
})

test.each(["PRRT_unknown", "PRRT_human"])(
  "rejects resolution of an ineligible thread %s before any writes",
  (id) => {
    const humanThread = {
      ...previousThread,
      id: "PRRT_human",
      comments: {
        nodes: [
          {
            ...previousThread.comments.nodes[0],
            author: { __typename: "User", login: "owner" },
          },
        ],
      },
    }
    const { result, root } = runAction({
      MOCK_THREADS: JSON.stringify([previousThread, humanThread]),
      MOCK_REVIEW: JSON.stringify({ ...noFindings, resolved_threads: [{ id, reason }] }),
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("invalid or unknown thread resolution")
    expect(existsSync(join(root, "summary.json"))).toBe(false)
    expect(existsSync(join(root, "replies.jsonl"))).toBe(false)
    expect(resolutionCalls(root)).toEqual([])
  },
)

const resolutionReply = {
  id: 43,
  user: bot,
  in_reply_to_id: 41,
  body: `<!-- pi-action:resolution:${head} -->\nAn explanation already posted before a failed resolution.`,
}

test("reuses an existing same-head explanation when retrying a failed resolution", () => {
  const { result, root } = runAction({
    MOCK_THREADS: JSON.stringify([previousThread]),
    MOCK_REVIEW: fixedReview,
    MOCK_INLINE_COMMENTS: JSON.stringify([[], [resolutionReply]]),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(root, "replies.jsonl"))).toBe(false)
  expect(jsonLines(root, "resolved.jsonl")).toEqual([{ id: previousThread.id }])
})

test.each([
  { user: { login: "owner" } },
  { in_reply_to_id: 99 },
  { body: `<!-- pi-action:resolution:${base} -->\nA fix at an older commit.` },
])("does not reuse an unrelated explanation: %j", (override) => {
  const { result, root } = runAction({
    MOCK_THREADS: JSON.stringify([previousThread]),
    MOCK_REVIEW: fixedReview,
    MOCK_INLINE_COMMENTS: JSON.stringify([[{ ...resolutionReply, ...override }]]),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(jsonLines(root, "replies.jsonl")).toHaveLength(1)
  expect(jsonLines(root, "resolved.jsonl")).toEqual([{ id: previousThread.id }])
})

test.each(["list-inline", "reply", "resolve"])(
  "fails safely when the %s stage fails during thread resolution",
  (stage) => {
    const { result, root } = runAction({
      MOCK_THREADS: JSON.stringify([previousThread]),
      MOCK_REVIEW: fixedReview,
      MOCK_FAILURE: stage,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`mock ${stage} failure`)
    expect(existsSync(join(root, "summary.json"))).toBe(stage !== "list-inline")
    expect(existsSync(join(root, "replies.jsonl"))).toBe(stage === "resolve")
    expect(existsSync(join(root, "resolved.jsonl"))).toBe(false)
    expect(resolutionCalls(root)).toHaveLength(stage === "resolve" ? 1 : 0)
  },
)

test("warns and succeeds when the workflow token cannot resolve review threads", () => {
  const second = {
    ...previousThread,
    id: "PRRT_2",
    comments: { nodes: [{ ...previousThread.comments.nodes[0], fullDatabaseId: "42" }] },
  }
  const { result, root } = runAction({
    MOCK_THREADS: JSON.stringify([previousThread, second]),
    MOCK_REVIEW: JSON.stringify({
      ...noFindings,
      resolved_threads: [
        { id: previousThread.id, reason },
        { id: second.id, reason },
      ],
    }),
    MOCK_RESOLVE_FORBIDDEN: "1",
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(root, "summary.json"))).toBe(true)
  expect(jsonLines(root, "replies.jsonl")).toHaveLength(2)
  expect(existsSync(join(root, "resolved.jsonl"))).toBe(false)
  expect(resolutionCalls(root)).toHaveLength(2)
  expect(result.stdout).toContain(
    "::warning::The workflow token cannot resolve review threads, so https://github.com/owner/repo/pull/42#discussion_r41 stays open.",
  )
  expect(result.stdout).toContain("pull/42#discussion_r42 stays open.")
  expect(result.stdout).not.toContain("Thread resolved:")
})

test("reports GraphQL resolution errors even when GitHub CLI exits successfully", () => {
  const { result, root } = runAction({
    MOCK_THREADS: JSON.stringify([previousThread]),
    MOCK_REVIEW: fixedReview,
    MOCK_GRAPHQL_ERRORS: "1",
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("GitHub GraphQL request failed")
  expect(jsonLines(root, "replies.jsonl")).toHaveLength(1)
  expect(existsSync(join(root, "resolved.jsonl"))).toBe(false)
})

test.each([
  { heads: [base], summary: false, reply: false },
  { heads: [head, base], summary: true, reply: false },
  { heads: [head, head, base], summary: true, reply: true },
])("keeps the thread open when the head changes: %j", ({ heads, summary, reply }) => {
  const { result, root } = runAction({
    MOCK_THREADS: JSON.stringify([previousThread]),
    MOCK_REVIEW: fixedReview,
    MOCK_HEADS: JSON.stringify(heads),
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("head changed")
  expect(existsSync(join(root, "summary.json"))).toBe(summary)
  expect(existsSync(join(root, "replies.jsonl"))).toBe(reply)
  expect(resolutionCalls(root)).toEqual([])
})

test("cleans credentials and reports failure if inline submission fails after the summary update", () => {
  const { result, root } = runAction({ MOCK_REVIEW: withFinding, MOCK_FAILURE: "review" })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("mock review failure")
  expect(existsSync(join(root, "summary.json"))).toBe(true)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})
