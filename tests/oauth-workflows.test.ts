import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
}

function yamlExamples(document: string): string[] {
  return [...document.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((match) => match[1])
}

const guide = read("docs/oauth.md")
const examples = yamlExamples(guide)
const persistenceReadme = read("persist-auth/README.md")

function expectProtectedJob(example: string, action: string): void {
  expect(example).toContain(`  ${action}:\n`)
  expect(example).toContain("    environment: pi-oauth\n")
  expect(example).toContain(
    "    concurrency:\n      group: pi-oauth-auth-json\n      cancel-in-progress: false\n",
  )
  expect(example).not.toMatch(/^concurrency:|cancel-in-progress: true|^ {4}env:/m)
  expect(example).not.toMatch(/uses:\s+actions\/checkout@|github\.event\.pull_request\.head/)
  expect(example).not.toMatch(/secrets: write|environments: write|write-all/i)
  for (const step of example.split(/^ {6}- name:/m)) {
    if (!step.startsWith(" Check queued event\n")) {
      expect(step).not.toMatch(/GH_TOKEN:|GITHUB_TOKEN:/i)
    }
  }
  expect(example).toContain(action === "review" ? "  pull-requests: write" : "  issues: write")
  if (action === "review") {
    expect(example).toContain("  pull_request_target:")
    expect(example).not.toContain("\n  pull_request:")
    expect(example).toContain("  contents: read")
  }
}

function expectStandaloneSteps(
  example: string,
  action: string,
  revision = "<PUBLISHED_COMMIT_SHA>",
): void {
  const consumerStart = example.indexOf("- name: Persist refreshed credentials")
  expect(consumerStart).toBeGreaterThan(0)
  const producer = example.slice(0, consumerStart)
  const consumer = example.slice(consumerStart)
  const path = `\${{ runner.temp }}/pi-${action}-auth/auth.json`

  expect(producer).toContain(`id: ${action}`)
  expect(producer).toContain(`pi-actions/${action}@${revision}`)
  expect(producer).toContain(`auth-json: \${{ secrets.PI_AUTH_JSON }}`)
  expect(producer).toContain(`auth-output: ${path}`)
  expect(producer).not.toMatch(/PAT_TOKEN|auth-token:|auth-secret:|auth-environment:/)
  expect(consumer).toContain(`if: always() && steps.${action}.outcome != 'skipped'`)
  expect(consumer).toContain(`pi-actions/persist-auth@${revision}`)
  expect(consumer).toContain(`auth-file: ${path}`)
  expect(consumer).toContain(`auth-json: \${{ secrets.PI_AUTH_JSON }}`)
  expect(consumer).toContain(`token: \${{ secrets.PAT_TOKEN }}`)
  // The documented defaults must select the protected job's environment and secret.
  expect(consumer).not.toMatch(/\n\s+(environment|secret-name):/)
  expect(example.match(/secrets\.PAT_TOKEN/g)).toHaveLength(1)
  expect(example).not.toMatch(/continue-on-error:|steps\.(review|triage)\.outputs\.|auth-token:/)
}

for (const action of ["review", "triage"]) {
  describe(`${action} OAuth configuration`, () => {
    const manifest = read(`${action}/action.yml`)
    const readme = read(`${action}/README.md`)
    const workflow = read(`.github/workflows/${action}.yml`)
    const actionExamples = examples.filter((value) => value.includes(`pi-actions/${action}@`))
    const inline = actionExamples.filter((value) => value.includes("auth-token:"))
    const standalone = actionExamples.filter((value) => value.includes("auth-output:"))

    test("exposes optional inline and handoff inputs only to the runtime step", () => {
      for (const [input, variable] of [
        ["auth-secret", "PI_AUTH_SECRET"],
        ["auth-environment", "PI_AUTH_ENVIRONMENT"],
        ["auth-token", "PI_AUTH_TOKEN"],
        ["auth-output", "PI_AUTH_OUTPUT"],
      ]) {
        expect(manifest).toMatch(
          new RegExp(`^  ${input}:\\n    description: .+\\n    required: false$`, "m"),
        )
        expect(manifest).toContain(`${variable}: \${{ inputs.${input} }}`)
        expect(readme).toContain(`\`${input}\``)
        const setup = manifest.slice(0, manifest.indexOf("      env:"))
        expect(setup).not.toContain(`\${{ inputs.${input} }}`)
        expect(setup).not.toContain(`${variable}:`)
      }
      expect(readme).toContain("../docs/oauth.md")
      expect(readme).toContain("../persist-auth/README.md")
    })

    test("retains serialized inline migration examples", () => {
      expect(inline.length).toBeGreaterThan(0)
      for (const example of inline) {
        expectProtectedJob(example, action)
        expect(example).toContain(`pi-actions/${action}@<PUBLISHED_OAUTH_PERSISTENCE_COMMIT_SHA>`)
        expect(example).toContain(`auth-json: \${{ secrets.PI_AUTH_JSON }}`)
        expect(example).toContain("auth-secret: PI_AUTH_JSON")
        expect(example).toContain("auth-environment: pi-oauth")
        expect(example).toContain(`auth-token: \${{ secrets.PAT_TOKEN }}`)
        expect(example).not.toMatch(/auth-output:|pi-actions\/persist-auth@/)
      }
    })

    test("documents independent persistence with matching paths and no producer PAT", () => {
      expect(standalone.length).toBeGreaterThan(0)
      for (const example of standalone) {
        expectProtectedJob(example, action)
        expectStandaloneSteps(example, action)
      }
      const snippets = yamlExamples(readme).filter((value) => value.includes("auth-output:"))
      expect(snippets.length).toBeGreaterThan(0)
      for (const snippet of snippets) expectStandaloneSteps(snippet, action)
    })

    test("uses pinned standalone persistence in the repository workflow", () => {
      const revision = workflow.match(
        new RegExp(`pi-actions/${action}@([a-f0-9]{40})\\s*$`, "m"),
      )?.[1]
      expect(revision).toBeDefined()
      expectProtectedJob(workflow, action)
      expectStandaloneSteps(workflow, action, revision)
      expect(workflow).not.toMatch(/auth-secret:|auth-environment:|auth-token:/)
    })

    test("retains pending jobs in the shared OAuth concurrency group", () => {
      expect(workflow).toContain(
        "    concurrency:\n      group: pi-oauth-auth-json\n      cancel-in-progress: false\n      queue: max\n",
      )
    })

    test("selects the OpenAI subscription OAuth provider in the repository workflow", () => {
      expect(workflow).toMatch(/^\s+provider: openai$/m)
      expect(workflow).not.toContain("provider: openai-codex")
    })

    test("keeps the API-key usage independent of OAuth persistence", () => {
      const usage = yamlExamples(readme)[0] ?? ""
      expect(usage).toContain(`api-key: \${{ secrets.PI_API_KEY }}`)
      expect(usage).toContain("cancel-in-progress: true")
      expect(usage).not.toMatch(
        /auth-secret:|auth-environment:|auth-token:|auth-output:|pi-actions\/persist-auth@/,
      )
    })

    test("keeps publication on the regular workflow token", () => {
      expect(manifest).toContain(`GH_TOKEN: \${{ github.token }}`)
    })
  })
}

describe("standalone persistence action", () => {
  const manifest = read("persist-auth/action.yml")

  test("declares required inputs, defaults, and runtime mappings", () => {
    for (const input of ["auth-file", "token"]) {
      expect(manifest).toMatch(
        new RegExp(`^  ${input}:\\n    description: .+\\n    required: true$`, "m"),
      )
    }
    for (const [input, value] of [
      ["environment", "pi-oauth"],
      ["secret-name", "PI_AUTH_JSON"],
    ]) {
      expect(manifest).toMatch(
        new RegExp(
          `^  ${input}:\\n    description: .+\\n    required: false\\n    default: ${value}$`,
          "m",
        ),
      )
    }
    expect(manifest).toMatch(/^ {2}auth-json:\n {4}description: .+\n {4}required: false$/m)
    for (const [input, variable] of [
      ["auth-file", "PI_AUTH_FILE"],
      ["token", "PI_AUTH_TOKEN"],
      ["environment", "PI_AUTH_ENVIRONMENT"],
      ["secret-name", "PI_AUTH_SECRET"],
      ["auth-json", "PI_AUTH_JSON"],
    ]) {
      expect(manifest).toContain(`${variable}: \${{ inputs.${input} }}`)
      expect(persistenceReadme).toContain(`\`${input}\``)
    }
  })

  test("runs the compiled action on Node.js 26 without Pi or checkout", () => {
    expect(manifest).toContain("using: composite")
    expect(manifest).toMatch(/uses: actions\/setup-node@\S+/)
    expect(manifest).toContain("node-version: 26")
    expect(manifest).toContain('run: node "$GITHUB_ACTION_PATH/../dist/persist-auth.js"')
    expect(manifest).not.toMatch(/npm install|actions\/checkout@|pi-coding-agent|outputs:/)
    const setup = manifest.slice(0, manifest.indexOf("      env:"))
    expect(setup).not.toContain("inputs.token")
    expect(setup).not.toContain("PI_AUTH_TOKEN:")
  })

  test("documents the public action and safe standalone usage", () => {
    const readme = read("README.md")
    expect(readme).toContain("`narumiruna/pi-actions/persist-auth`")
    expect(readme).toContain("persist-auth/README.md")
    expect(persistenceReadme).toContain("../docs/oauth.md")
    const snippet = yamlExamples(persistenceReadme).find((value) => value.includes("auth-output:"))
    expectStandaloneSteps(snippet ?? "", "review")
  })
})

test("reuses PAT_TOKEN without requiring another token secret", () => {
  expect(guide).toContain("No additional token secret is required.")
  expect(guide).toContain("Classic PATs need the `repo` scope")
  expect(guide).toContain("require revoking a shared `PAT_TOKEN` that other workflows still use.")
  expect(guide).toContain("rotate it if compromised")
  expect(guide).not.toMatch(/PI_AUTH_WRITER_TOKEN|PI_AUTH_UPDATE_TOKEN/)
})

test("retains explicit activation, live verification, and recovery gates", () => {
  expect(guide).toContain("## Activation gate")
  expect(guide).toContain("## Owner setup")
  expect(guide).toContain("## External verification handoff")
  expect(guide).toContain("## Recovery and rollback")
  expect(guide).toContain("Environments: read and write")
  expect(guide).toContain("These live checks remain outstanding")
  expect(guide).toContain("CI-only")
  expect(guide).toContain("refresh_token_reused")
  expect(guide).toContain("remove the `persist-auth` step and `auth-output`")
  expect(guide).toContain("preflight cannot prevent an earlier rotation")
  expect(guide).toContain("write failure cannot undo")
})

test("documents private file ownership, full-document validation, and cleanup limits", () => {
  for (const document of [guide, persistenceReadme]) {
    expect(document).toContain("0600")
    expect(document).toContain("0700")
    expect(document).toContain("RUNNER_TEMP")
    expect(document).toContain("Linux and macOS")
    expect(document).toContain("fail closed")
    expect(document).toMatch(/semantically/i)
    expect(document).toContain("48 KB")
    expect(document).toMatch(/never (?:follows|follow)/i)
    expect(document).toMatch(/Empty private\s+handoff and cleanup directories may\s+remain/)
    expect(document).toMatch(/recursively delete/)
  }
  expect(guide).toContain("whole original document before any Pi invocation")
  expect(guide).toContain(
    "unsupported triage activities, closed issues, and repositories without labels",
  )
  expect(guide).toContain("including rejected updates")
  expect(persistenceReadme).toContain("handled success, unchanged results, or failure")
})
