import { spawnSync } from "node:child_process"
import {
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

const script = resolve("scripts/review.mjs")
const roots: string[] = []
const base = "a".repeat(40)
const head = "b".repeat(40)
const diff =
  "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n"

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
if (command === "gh" && !args.includes("POST")) {
  fail("fetch");
  process.stdout.write(env.MOCK_EMPTY_DIFF ? "" : env.MOCK_DIFF);
} else if (command === "gh") {
  fail("post");
  const request = readFileSync(args[args.indexOf("--input") + 1], "utf8");
  writeFileSync(join(env.MOCK_ROOT, "posted.json"), request);
  console.log("https://github.com/owner/repo/pull/42#pullrequestreview-1");
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
  process.stdout.write(env.MOCK_EMPTY_REVIEW ? "" : "No actionable findings found in the supplied diff.");
}
`

function runAction(overrides: Record<string, string> = {}, promptPath?: string) {
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
  writeFileSync(
    eventPath,
    JSON.stringify({ number: 42, pull_request: { base: { sha: base }, head: { sha: head } } }),
  )
  if (promptPath) {
    const fullPath = join(workspace, promptPath)
    mkdirSync(resolve(fullPath, ".."), { recursive: true })
    writeFileSync(fullPath, "Custom review instructions.")
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "github-token",
      GITHUB_TOKEN: "alternate-github-token",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runner,
      PI_PROVIDER: "openai",
      PI_MODEL: "gpt-6.1-sol",
      PI_API_KEY: "test-api-key",
      PI_AUTH_JSON: "",
      PI_BASE_URL: "",
      PI_THINKING: "medium",
      PI_PROMPT: ".pi/prompts/review-pull-request.md",
      MOCK_ROOT: root,
      MOCK_DIFF: diff,
      ...overrides,
    },
  })
  const json = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"))
  expect(readdirSync(runner)).toEqual([])
  return { result, root, workspace, json }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("reviews the event's exact commits with the API key and bundled prompt", () => {
  const { result, json, root } = runAction()
  expect(result.status, result.stderr).toBe(0)
  const commands = readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect.soft(commands[0]).toEqual({
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
  expect.soft(pi.args).toContain("--no-tools")
  expect(pi.args).toEqual(
    expect.arrayContaining([
      "--print",
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
  expect.soft(json("posted.json")).toEqual({
    body: "## Pi review\n\nNo actionable findings found in the supplied diff.",
    event: "COMMENT",
    commit_id: head,
  })
  expect(result.stdout).toContain("Review posted: https://github.com/owner/repo/pull/42")
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
  [{ GITHUB_EVENT_NAME: "pull_request_target" }, "pull_request event"],
])("rejects invalid inputs %j before invoking commands", (overrides, message) => {
  const { result, root } = runAction(overrides)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(message)
  expect(result.stderr).not.toContain("invalid-secret-json")
  expect(existsSync(join(root, "commands.jsonl"))).toBe(false)
})

test.each(["fetch", "pi", "post"])("cleans credentials after a %s failure", (stage) => {
  const { result, root } = runAction({ MOCK_FAILURE: stage })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`mock ${stage} failure`)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test.each([
  [{ MOCK_EMPTY_DIFF: "1" }, "diff is empty"],
  [{ MOCK_EMPTY_REVIEW: "1" }, "empty review"],
])("does not post an empty result %j", (overrides, message) => {
  const { result, root } = runAction(overrides)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(message)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})
