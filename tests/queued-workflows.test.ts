import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { describe, expect, test } from "vitest"

const workflows = Object.fromEntries(
  ["review", "triage"].map((action) => [
    action,
    readFileSync(new URL(`../.github/workflows/${action}.yml`, import.meta.url), "utf8"),
  ]),
)

function runCheck(
  action: string,
  event: unknown,
  response: unknown,
  options: { manual?: boolean; failApi?: boolean; malformedResponse?: boolean } = {},
) {
  const script = workflows[action].match(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/m)?.[1]
  expect(script).toBeDefined()
  const root = mkdtempSync(join(tmpdir(), "pi-queue-test-"))
  const eventPath = join(root, "event.json")
  const outputPath = join(root, "output")
  const callsPath = join(root, "calls")
  try {
    writeFileSync(eventPath, JSON.stringify(event))
    writeFileSync(outputPath, "")
    writeFileSync(
      join(root, "gh"),
      `#!/bin/sh
printf '%s\\n' "$@" > "$MOCK_CALLS"
if [ "$MOCK_FAILURE" = "true" ]; then
  echo "API unavailable" >&2
  exit 1
fi
printf '%s' "$MOCK_RESPONSE"
`,
      { mode: 0o755 },
    )
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-e",
        "-o",
        "pipefail",
        "-c",
        script?.replace(/^ {10}/gm, "") ?? "",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
          GH_TOKEN: "test-token",
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_EVENT_NAME: options.manual
            ? "workflow_dispatch"
            : action === "review"
              ? "pull_request_target"
              : "issues",
          GITHUB_EVENT_PATH: options.manual ? join(root, "missing-event.json") : eventPath,
          GITHUB_OUTPUT: outputPath,
          MOCK_CALLS: callsPath,
          MOCK_FAILURE: String(options.failApi ?? false),
          MOCK_RESPONSE: options.malformedResponse ? "invalid JSON" : JSON.stringify(response),
        },
      },
    )
    return {
      result,
      output: readFileSync(outputPath, "utf8"),
      calls: existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n") : [],
      injected: existsSync(join(root, "injected")),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const head = "a".repeat(40)
const pullRequestEvent = { number: 41, pull_request: { head: { sha: head } } }
const issue = { number: 42, state: "open", title: "Issue title", body: "Issue body" }
const issueEvent = { action: "edited", issue }

describe("queued pull request checks", () => {
  test.each([
    ["current", head, "true"],
    ["superseded", "b".repeat(40), "false"],
  ])("handles a %s head before Pi runs", (_name, currentHead, expected) => {
    const { result, output, calls } = runCheck("review", pullRequestEvent, {
      head: { sha: currentHead },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(output).toBe(`current=${expected}\n`)
    expect(calls).toEqual(["api", "repos/owner/repo/pulls/41"])
  })

  test("keeps manual dispatch independent of the event file and API check", () => {
    const { result, output, calls } = runCheck("review", {}, {}, { manual: true, failApi: true })
    expect(result.status, result.stderr).toBe(0)
    expect(output).toBe("current=true\n")
    expect(calls).toEqual([])
  })

  test("fails before Pi if the event head is missing", () => {
    const { result, output, calls } = runCheck("review", { number: 41 }, {})
    expect(result.status).not.toBe(0)
    expect(output).toBe("")
    expect(calls).toEqual([])
  })
})

describe("queued issue checks", () => {
  test.each([
    ["current content", issue, "true"],
    ["superseded title", { ...issue, title: "New title" }, "false"],
    ["superseded body", { ...issue, body: "New body" }, "false"],
    ["closed issue", { ...issue, state: "closed" }, "false"],
    ["label and timestamp changes", { ...issue, labels: [], updated_at: "later" }, "true"],
  ])("handles %s before Pi runs", (_name, currentIssue, expected) => {
    const { result, output, calls } = runCheck("triage", issueEvent, currentIssue)
    expect(result.status, result.stderr).toBe(0)
    expect(output).toBe(`current=${expected}\n`)
    expect(calls).toEqual(["api", "repos/owner/repo/issues/42"])
  })

  test.each([
    [null, ""],
    ["", null],
  ])("treats event body %s and current body %s as the same content", (eventBody, currentBody) => {
    const { result, output } = runCheck(
      "triage",
      { issue: { ...issue, body: eventBody } },
      { ...issue, body: currentBody },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(output).toBe("current=true\n")
  })

  test("treats issue content as data, not shell commands", () => {
    const content = { ...issue, title: "$(touch injected)", body: '"\n`touch injected`\n\\' }
    const { result, output, injected } = runCheck("triage", { issue: content }, content)
    expect(result.status, result.stderr).toBe(0)
    expect(output).toBe("current=true\n")
    expect(injected).toBe(false)
  })
})

for (const action of ["review", "triage"]) {
  describe(`${action} queue protection`, () => {
    test("checks inside the shared job before the producer and persistence", () => {
      const workflow = workflows[action]
      const producer = workflow.indexOf(`        id: ${action}\n`)
      const check = workflow.slice(workflow.indexOf("      - name: Check queued event"), producer)
      expect(check).toContain("        id: current\n")
      expect(check).toContain("        shell: bash\n")
      expect(check).toContain(`          GH_TOKEN: \${{ github.token }}\n`)
      expect(check).not.toMatch(/PAT_TOKEN|PI_AUTH_JSON|actions\/checkout/)
      expect(workflow).toContain(
        `        id: ${action}\n        if: steps.current.outputs.current == 'true'\n`,
      )
      expect(workflow).toContain(`if: always() && steps.${action}.outcome != 'skipped'`)
      expect(workflow.indexOf("      queue: max\n")).toBeLessThan(
        workflow.indexOf("      - name: Check queued event"),
      )
    })

    test("fails closed when the API request fails", () => {
      const { result, output } = runCheck(
        action,
        action === "review" ? pullRequestEvent : issueEvent,
        {},
        { failApi: true },
      )
      expect(result.status).not.toBe(0)
      expect(output).toBe("")
      expect(result.stderr).toContain("API unavailable")
    })

    test("fails closed when the API response is not JSON", () => {
      const { result, output } = runCheck(
        action,
        action === "review" ? pullRequestEvent : issueEvent,
        {},
        { malformedResponse: true },
      )
      expect(result.status).not.toBe(0)
      expect(output).toBe("")
    })
  })
}
