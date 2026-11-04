import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function escapeCommand(value) {
    return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
function maskSecrets(value) {
    if (typeof value === "string" && value) {
        console.log(`::add-mask::${escapeCommand(value)}`);
    }
    else if (value && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
            if (key !== "type")
                maskSecrets(entry);
        }
    }
}
export function withPi(defaultPrompt, task) {
    const env = process.env;
    const provider = env.PI_PROVIDER?.trim();
    const model = env.PI_MODEL?.trim();
    const thinking = env.PI_THINKING?.trim() || "medium";
    const apiKey = env.PI_API_KEY || "";
    const authJson = env.PI_AUTH_JSON || "";
    const baseUrl = env.PI_BASE_URL?.trim();
    if (!provider || !model)
        throw new Error("provider and model are required.");
    if (!thinkingLevels.includes(thinking))
        throw new Error("Invalid thinking level.");
    if (Boolean(apiKey) === Boolean(authJson)) {
        throw new Error("Provide exactly one of api-key or auth-json.");
    }
    if (baseUrl && !["http:", "https:"].includes(new URL(baseUrl).protocol)) {
        throw new Error("base-url must use HTTP or HTTPS.");
    }
    let credential = { type: "api_key", key: apiKey };
    if (authJson) {
        let auth;
        try {
            auth = JSON.parse(authJson);
        }
        catch {
            throw new Error("auth-json must contain valid JSON.");
        }
        const selected = isObject(auth) ? auth[provider] : undefined;
        if (!isObject(selected) || (selected.type !== "api_key" && selected.type !== "oauth")) {
            throw new Error("auth-json must contain an API key or OAuth credential for provider.");
        }
        credential = selected;
        if (credential.type === "api_key" && (typeof credential.key !== "string" || !credential.key)) {
            throw new Error("The selected auth-json API key must be a non-empty string.");
        }
    }
    maskSecrets(credential);
    const workspace = env.GITHUB_WORKSPACE;
    const runnerTemp = env.RUNNER_TEMP;
    if (!workspace || !runnerTemp) {
        throw new Error("GITHUB_WORKSPACE and RUNNER_TEMP are required.");
    }
    const prompt = env.PI_PROMPT || defaultPrompt;
    let promptPath = resolve(workspace, prompt);
    if (prompt === defaultPrompt && !existsSync(promptPath)) {
        promptPath = fileURLToPath(new URL(`../${defaultPrompt}`, import.meta.url));
    }
    if (!existsSync(promptPath))
        throw new Error("The prompt file does not exist.");
    const directory = mkdtempSync(join(runnerTemp, "pi-action-"));
    try {
        writeFileSync(join(directory, "auth.json"), JSON.stringify({ [provider]: credential }), {
            mode: 0o600,
        });
        if (baseUrl) {
            writeFileSync(join(directory, "models.json"), JSON.stringify({ providers: { [provider]: { baseUrl } } }));
        }
        const commandEnv = { ...env };
        delete commandEnv.PI_API_KEY;
        delete commandEnv.PI_AUTH_JSON;
        const options = {
            encoding: "utf8",
            env: commandEnv,
            maxBuffer: 20 * 1024 * 1024,
        };
        const piEnv = {
            ...commandEnv,
            PI_CODING_AGENT_DIR: directory,
            PI_SKIP_VERSION_CHECK: "1",
        };
        delete piEnv.GH_TOKEN;
        delete piEnv.GITHUB_TOKEN;
        const run = (inputPath, instruction) => execFileSync("pi", [
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
            `@${inputPath}`,
            instruction,
        ], { ...options, env: piEnv, cwd: directory }).trim();
        return task({ directory, options, run });
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
