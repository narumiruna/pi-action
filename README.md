# Pi Pull Request Review

Use [pi-coding-agent](https://github.com/earendil-works/pi) to review a pull request
diff and post a GitHub comment review. The action does not approve or reject pull
requests.

## Usage

Create `.github/workflows/review.yml`:

```yaml
name: PR Review

on:
  pull_request:
    branches:
      - main

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: pi-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: narumiruna/pi-action@main
        with:
          api-key: ${{ secrets.PI_API_KEY }}
          provider: openai
          model: gpt-6.1-sol
          thinking: medium
```

Pin the action to a commit SHA for production use. No checkout is needed with the
bundled prompt. The runner must provide Bash and GitHub CLI; `ubuntu-latest`
includes both. The action installs Node.js and Pi.

## Inputs

| Input       | Required             | Description                                                                                                            |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `auth-json` | One credential input | Contents of Pi's `auth.json`, including API keys or OAuth credentials.                                                 |
| `api-key`   | One credential input | API key for `provider`.                                                                                                |
| `base-url`  | No                   | API base URL override for an existing Pi provider. Its API protocol and model catalog stay unchanged.                  |
| `provider`  | No                   | Pi provider ID. Default: `openai`.                                                                                     |
| `model`     | No                   | Model ID in the selected provider's Pi catalog. Default: `gpt-6.1-sol`.                                                |
| `thinking`  | No                   | `off`, `minimal`, `low`, `medium` (default), `high`, `xhigh`, or `max`. Pi limits it to levels supported by the model. |
| `prompt`    | No                   | Markdown prompt file. Default: `.pi/prompts/review-pull-request.md`.                                                   |

Provide exactly one of `api-key` or `auth-json`. Store credentials in GitHub Actions
secrets. The workflow's `GITHUB_TOKEN` needs `contents: read` and
`pull-requests: write`.

### Pi auth.json

Run `/login` in Pi, then save the contents of `~/.pi/agent/auth.json` as the
`PI_AUTH_JSON` repository secret. Replace the action step with:

```yaml
- uses: narumiruna/pi-action@main
  with:
    auth-json: ${{ secrets.PI_AUTH_JSON }}
    provider: openai
    model: gpt-6.1-sol
    thinking: high
```

The JSON must contain a credential for `provider`. The action copies only that
credential to a temporary file with mode `0600` and removes it after success or
failure. Refreshed OAuth credentials are not saved back to the GitHub secret;
update the secret if the provider expires or rotates them.

### Review prompt

The action uses [`.pi/prompts/review-pull-request.md`](.pi/prompts/review-pull-request.md).
If that file exists in the workspace, it takes precedence over the bundled copy.
Other `prompt` paths must exist and are resolved relative to the workspace.

To supply a repository prompt, check out a trusted revision before the action and
set `prompt` to the Markdown file path. Do not load prompts from an untrusted pull
request head.

## Review limits

- Only `pull_request` events are supported. Fork workflows normally have no secrets
  and a read-only token, so the example cannot review fork pull requests.
- Reviews use the diff between the event's base and head commits and are attached
  to that head commit.
- Pi runs without tools, extensions, skills, project configuration, or session
  storage. It does not run pull request code or inspect files outside the diff.
- GitHub diff limits and model context limits apply. The review covers only the
  returned diff. Retrieval and model errors fail the action.
- Each run posts a new comment review. Findings do not fail the action.

## Development

```sh
npm ci
npm run ci
```
