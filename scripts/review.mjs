import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const defaultPrompt = ".pi/prompts/review-pull-request.md"
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

function escapeCommand(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
}

function maskSecrets(value) {
  if (typeof value === "string" && value) {
    console.log(`::add-mask::${escapeCommand(value)}`)
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "type") maskSecrets(entry)
    }
  }
}

function reviewPullRequest() {
  const env = process.env
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    throw new Error("This action requires a pull_request event.")
  }

  const provider = env.PI_PROVIDER?.trim()
  const model = env.PI_MODEL?.trim()
  const thinking = env.PI_THINKING?.trim() || "medium"
  const apiKey = env.PI_API_KEY || ""
  const authJson = env.PI_AUTH_JSON || ""
  const baseUrl = env.PI_BASE_URL?.trim()
  if (!provider || !model) throw new Error("provider and model are required.")
  if (!thinkingLevels.includes(thinking)) throw new Error("Invalid thinking level.")
  if (Boolean(apiKey) === Boolean(authJson)) {
    throw new Error("Provide exactly one of api-key or auth-json.")
  }
  if (baseUrl && !["http:", "https:"].includes(new URL(baseUrl).protocol)) {
    throw new Error("base-url must use HTTP or HTTPS.")
  }

  let credential = { type: "api_key", key: apiKey }
  if (authJson) {
    let auth
    try {
      auth = JSON.parse(authJson)
    } catch {
      throw new Error("auth-json must contain valid JSON.")
    }
    credential = auth?.[provider]
    if (!credential || !["api_key", "oauth"].includes(credential.type)) {
      throw new Error("auth-json must contain an API key or OAuth credential for provider.")
    }
    if (credential.type === "api_key" && (typeof credential.key !== "string" || !credential.key)) {
      throw new Error("The selected auth-json API key must be a non-empty string.")
    }
  }
  maskSecrets(credential)

  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
  const number = event.number
  const base = event.pull_request?.base?.sha
  const head = event.pull_request?.head?.sha
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[a-f0-9]{40,64}$/.test(base || "") ||
    !/^[a-f0-9]{40,64}$/.test(head || "")
  ) {
    throw new Error("The pull request event must contain a number and base/head commit IDs.")
  }

  const prompt = env.PI_PROMPT || defaultPrompt
  let promptPath = resolve(env.GITHUB_WORKSPACE, prompt)
  if (prompt === defaultPrompt && !existsSync(promptPath)) {
    promptPath = fileURLToPath(new URL(`../${defaultPrompt}`, import.meta.url))
  }
  if (!existsSync(promptPath)) throw new Error("The prompt file does not exist.")

  const directory = mkdtempSync(join(env.RUNNER_TEMP, "pi-review-"))
  try {
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ [provider]: credential }), {
      mode: 0o600,
    })
    if (baseUrl) {
      writeFileSync(
        join(directory, "models.json"),
        JSON.stringify({
          providers: { [provider]: { baseUrl } },
        }),
      )
    }

    const commandEnv = { ...env }
    delete commandEnv.PI_API_KEY
    delete commandEnv.PI_AUTH_JSON
    const options = { encoding: "utf8", env: commandEnv, maxBuffer: 20 * 1024 * 1024 }
    const repository = `repos/${env.GITHUB_REPOSITORY}`
    const diff = execFileSync(
      "gh",
      [
        "api",
        `${repository}/compare/${head}...${base}`,
        "--header",
        "Accept: application/vnd.github.diff",
      ],
      options,
    )
    if (!diff.trim()) throw new Error("The pull request diff is empty.")
    const diffPath = join(directory, "diff.patch")
    writeFileSync(diffPath, diff)

    const piEnv = { ...commandEnv, PI_CODING_AGENT_DIR: directory, PI_SKIP_VERSION_CHECK: "1" }
    delete piEnv.GH_TOKEN
    delete piEnv.GITHUB_TOKEN
    const review = execFileSync(
      "pi",
      [
        "--print",
        "--mode",
        "text",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        thinking,
        "--system-prompt",
        promptPath,
        `@${diffPath}`,
        "Review the attached pull request diff.",
      ],
      { ...options, env: piEnv, cwd: directory },
    ).trim()
    if (!review) throw new Error("Pi returned an empty review.")
    const body = `## Pi review\n\n${review}`
    if (body.length > 65536) throw new Error("The review exceeds GitHub's comment size limit.")

    const requestPath = join(directory, "review.json")
    writeFileSync(requestPath, JSON.stringify({ body, event: "COMMENT", commit_id: base }))
    const url = execFileSync(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `${repository}/pulls/${number}/reviews`,
        "--input",
        requestPath,
        "--jq",
        ".html_url",
      ],
      options,
    ).trim()
    console.log(`Review posted: ${url}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

try {
  reviewPullRequest()
} catch (error) {
  console.error(`::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
}
