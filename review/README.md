# Pi Pull Request Review

Use Pi to review a pull request diff, post findings, and resolve verified fixes.
The action does not approve or reject pull requests.

## Usage

Save an API key for your provider as the `PI_API_KEY` GitHub Actions secret. Then
create `.github/workflows/review.yml`:

```yaml
name: PR Review

on:
  pull_request_target:
    branches:
      - main
  workflow_dispatch:
    inputs:
      pull-request:
        description: Pull request number to review
        required: true
        type: number

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: pi-review-${{ github.event.pull_request.number || inputs.pull-request }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: narumiruna/pi-actions/review@main
        with:
          pull-request: ${{ inputs.pull-request }}
          api-key: ${{ secrets.PI_API_KEY }}
          provider: openai
          model: gpt-6.1-sol
          thinking: medium
```

The example reviews pull requests that target `main`. Change the branch name if
needed. Pin the action to a trusted commit SHA for production use.

No checkout is needed with the bundled prompt. The runner must provide Bash and
GitHub CLI (`gh`); `ubuntu-latest` includes both. The action installs Node.js and Pi.

### Workflow security

`pull_request_target` uses the base repository's credentials and supports reviews
of fork pull requests. Keep the workflow, action code, and prompts trusted:

- Do not check out the pull request head.
- Do not execute pull request code or load prompts from it.
- If you need a checkout for a custom prompt, use a trusted revision.

The action also supports `pull_request`, but fork runs normally have no secrets
and a read-only `GITHUB_TOKEN`.

### Manual reviews

The example also supports `workflow_dispatch`. To review an existing pull request,
run the workflow from the trusted `main` branch:

```sh
gh workflow run review.yml --ref main -f pull-request=123
```

The `pull-request` input is required for manual runs. Pull request events use the
number from the event and ignore this input.

## Inputs

| Input              | Required             | Default                              | Description                                                                                                                       |
| ------------------ | -------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `pull-request`     | Manual runs only     | —                                    | Positive integer pull request number for `workflow_dispatch`. Ignored for pull request events.                                    |
| `api-key`          | One credential input | —                                    | API key for the selected provider.                                                                                                |
| `auth-json`        | One credential input | —                                    | Contents of Pi's `auth.json`, with an API key or OAuth credential for the selected provider.                                      |
| `auth-output`      | No                   | —                                    | Absolute private handoff path under `RUNNER_TEMP`. Requires OAuth `auth-json`; cannot be combined with inline persistence inputs. |
| `auth-secret`      | With persistence     | —                                    | Existing environment secret to update. Requires `auth-environment`, `auth-token`, and OAuth `auth-json`.                          |
| `auth-environment` | With persistence     | —                                    | Environment that owns the secret and is attached to the caller's job.                                                             |
| `auth-token`       | With persistence     | —                                    | GitHub token with repository `Environments: write` permission. An existing `PAT_TOKEN` can be reused.                             |
| `base-url`         | No                   | —                                    | HTTP or HTTPS API base URL override for an existing Pi provider. The API protocol and model catalog do not change.                |
| `provider`         | No                   | `openai`                             | Pi provider ID.                                                                                                                   |
| `model`            | No                   | `gpt-6.1-sol`                        | Model ID in the selected provider's Pi catalog.                                                                                   |
| `thinking`         | No                   | `medium`                             | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi limits the level to those supported by the model.                |
| `prompt`           | No                   | `.pi/prompts/review-pull-request.md` | Path to a Markdown system prompt, relative to the workspace. The default has a bundled copy.                                      |

Provide exactly one of `api-key` or `auth-json`, stored as a GitHub Actions secret.
The review workflow's `GITHUB_TOKEN` needs `contents: read` and
`pull-requests: write`.

### Use Pi credentials

Use `auth-json` instead of `api-key` and select the provider whose credential is
in the document. For an `openai-codex` login, use `provider: openai-codex` and a
model from that provider's Pi catalog.

For persistent OAuth credentials, follow the shared
[OAuth setup and migration guide](../docs/oauth.md). It includes a complete review
workflow for each persistence mode. Use a CI-only Pi login and an existing
environment secret in the caller repository. For inline persistence, supply all
three inputs: `auth-secret`, `auth-environment`, and `auth-token`.
Every consumer, including triage,
must use the same job environment and job-level concurrency group with
`cancel-in-progress: false`.

Do not activate these settings before owner setup and publication of the new
action revision. Pin that revision; older action revisions do not support these
inputs. Complete the guide's controlled GitHub checks before production use.

The action gives Pi only the selected provider's credential in a mode-`0600`
temporary file and removes it after success or failure. With inline persistence enabled,
it saves valid credential changes after every Pi exit, including failure, before
parsing results or publishing comments. Other providers and metadata are
preserved. A failed save fails the action before publication. Without persistence
settings, refreshed credentials are not saved; replace them manually when needed.

### Export credentials for a separate persistence step

Use `auth-output` with [persist-auth](../persist-auth/README.md) instead of the
three inline persistence inputs. Inside the protected job from the
[shared guide](../docs/oauth.md#standalone-review-githubworkflowsreviewyml), use:

```yaml
- name: Review pull request
  id: review
  uses: narumiruna/pi-actions/review@<PUBLISHED_COMMIT_SHA>
  with:
    auth-json: ${{ secrets.PI_AUTH_JSON }}
    provider: openai-codex
    model: gpt-6.1-sol
    auth-output: ${{ runner.temp }}/pi-review-auth/auth.json

- name: Persist refreshed credentials
  if: always() && steps.review.outcome != 'skipped'
  uses: narumiruna/pi-actions/persist-auth@<PUBLISHED_COMMIT_SHA>
  with:
    auth-file: ${{ runner.temp }}/pi-review-auth/auth.json
    auth-json: ${{ secrets.PI_AUTH_JSON }}
    token: ${{ secrets.PAT_TOKEN }}
```

Replace both placeholders with the same published, reviewed full commit SHA.
Keep the shared job environment and lock with `cancel-in-progress: false`.
Pass `PAT_TOKEN` only to the consumer's `token` input, not review. Use the known
absolute path in both steps, not a failed-step output. Do not add
`continue-on-error`.

The producer reserves a new `0600` file in a `0700` parent under `RUNNER_TEMP`
and validates the entire original document before Pi. After every Pi invocation,
even a failed exit, it merges only the selected OAuth credential into that full
document before returning or throwing. Successful no-ops export the original
unchanged document. Later result or publication failures retain a valid handoff.
Invalid post-Pi credentials remove the incomplete handoff rather than restore a
possibly consumed refresh token.

The consumer deletes the validated private input on handled success, failure,
or an unchanged result. It rejects unsafe paths or ownership without deleting
arbitrary files. Empty parent directories may remain; it never recursively
deletes caller directories. These new modes require POSIX ownership and private
permissions on Linux or macOS and fail closed when these cannot be established.

Unlike inline persistence, standalone preflight occurs after Pi. A save failure
fails the job but cannot undo comments already published. Runner loss or forced
cancellation can still prevent writeback and cleanup. Complete the shared guide's
owner setup and live checks before activation.

### Use a custom review prompt

The default prompt is
[`.pi/prompts/review-pull-request.md`](../.pi/prompts/review-pull-request.md).
A copy at that path in the workspace takes precedence over the bundled copy.
Other prompt paths must exist in the workspace.

To use a repository prompt, check out a trusted revision before the action and
set `prompt` to the Markdown file path. Never load a prompt from an untrusted pull
request head.

When earlier unresolved Pi findings are available, the input is a JSON object
with `diff` and `unresolved_threads`. Each thread includes its ID, finding, file
location, original diff hunk, and original commit. Otherwise, the input is the raw
diff.

Custom prompts must return only a JSON object with `summary` and `findings`, using
the schema in the bundled prompt:

- `summary` is a non-empty string.
- `findings` is an array. Use `[]` when there are no findings.
  - Each finding has `severity`, `title`, `body`, and `location`.
  - `severity` is `critical`, `high`, `medium`, or `low`.
  - `title` and `body` are non-empty strings.
  - `location` has a repository-relative `path`, a file `line` number, and a
    `side`: `LEFT` for removed lines or `RIGHT` for new-side lines.
    - For a multiline range, add `start_line`. The range must be on one side
      within one diff hunk, and `line` is its last line.
    - Use `location: null` when there is no exact location in the diff.

The optional `resolved_threads` array identifies verified fixes. Each entry must
have exactly `id` and `reason`:

- `id` must identify a supplied unresolved thread and must not be repeated.
- `reason` must be a non-empty string of at most 300 characters. Use one short
  sentence in simple technical English. Explain the code change and why it fixes
  the issue; the action posts this text before resolving the thread.

Omit `resolved_threads` or return `[]` to leave all earlier threads open. Existing
custom prompts that return only `summary` and `findings` remain valid.

Other fields, Markdown fences, and prose outside the JSON object are not
supported. The finding body can contain Markdown.

## Review comments

### Summary comment

The first run creates a Pi summary comment in the pull request conversation.
Later runs update the same comment with the current summary, findings, and
reviewed commit. The action updates only its marked `github-actions[bot]`
comments; it does not edit user comments or historical review bodies.

The summary starts with the review result. Finding sections show their counts:

- **Inline findings** appear in a table with severity, title, and a linked file
  name and line range. Links open the reviewed diff; tooltips show full file paths.
- **Summary-only findings** include the full explanation when no valid diff
  location is available.

A footer links to the reviewed commit. With no findings, the comment contains
only the summary and footer, without an empty findings table.

The comment keeps its original position. GitHub does not let the action move it
to the top of the conversation.

### Inline review threads

Findings with valid diff locations are submitted together as a `COMMENT` review
at the reviewed head commit. Single lines, multiline ranges, and removed lines
are supported. The action does not submit an empty review.

Identical findings at the same commit are not posted twice. A new commit can
create new threads. Old threads are not deleted.

### Automatic resolution

On later reviews, Pi rechecks unresolved threads started by its marked
`github-actions[bot]` findings from earlier commits. It resolves a thread only
when the current diff shows a concrete change that fixes that specific issue.

Before resolving the thread, the action posts a reply with the reviewed commit
and a short explanation in simple technical English. If the reply fails, the
thread stays open.

If GitHub rejects the resolution with `Resource not accessible by integration`,
the workflow token is not allowed to resolve review threads. For example, a
fork pull request can receive a read-only token. The action logs a warning,
keeps the posted explanation, leaves the thread open, and does not fail the
job, because a rerun cannot fix a permission problem. Other resolution failures
still fail the job, so a rerun can retry them.

The action leaves a thread open when the evidence is incomplete. An outdated
comment, a finding absent from the new review, or a reply that says "Fixed" is not
proof of a fix. Findings first posted at the current head are not rechecked.
Already resolved threads and threads started by humans or other bots are not
changed.

## Review limits and failures

- **Diff-only code context:** Pi receives the current diff and any eligible
  earlier Pi findings with their original diff hunks. It does not inspect other
  repository files or run pull request code. A fix outside the supplied current
  diff cannot be verified. GitHub diff limits and model context limits apply.
- **Isolated Pi run:** Tools, extensions, skills, project configuration, and
  session storage are disabled. GitHub tokens are not passed to Pi.
- **Commit selection:** Pull request events use their base and head commits.
  Manual runs fetch the current commit IDs from GitHub before reading the diff.
- **Changed pull request:** The action checks the current head before initial
  publication, before each fix reply, and before resolving each thread. A
  mismatch stops further writes. These checks are not atomic with GitHub writes;
  rerun on the latest commit.
- **Action failures:** Diff retrieval errors, empty diffs, model errors, invalid
  model output, oversized comments, and GitHub API errors fail the action.
  Findings alone do not fail it.
- **Partial publication:** The summary is saved before inline submission and
  thread resolution. A failed run can leave a summary, inline findings, or fix
  replies already posted. Rerun to complete publication. A same-head retry reuses
  an existing fix reply instead of posting another one.

## Troubleshooting

### Credential or provider errors

For `Provide exactly one of api-key or auth-json.`, check that the selected
secret exists and is available to the workflow. Do not pass both inputs.

For provider authentication errors, check that the credential matches
`provider`. Use a `model` from that provider's Pi catalog; changing `base-url`
does not add models or change the API protocol.

For `refresh_token_reused` or lost OAuth state, stop every consumer and follow
[OAuth recovery](../docs/oauth.md#recovery-and-rollback). Obtain a fresh CI-only
login and replace the environment secret; retrying the old token cannot repair
it. For preflight or save failures, check the environment, secret name, and the
writer token's `Environments: write` permission before restarting jobs.

### GitHub permission errors and fork pull requests

For GitHub `403` errors, check that the job's `GITHUB_TOKEN` has
`contents: read` and `pull-requests: write`. Repository and organization
Actions policies can also restrict writes.

Fork runs with `pull_request` normally have no secrets and a read-only token.
Use the trusted `pull_request_target` workflow from
[Workflow security](#workflow-security). Do not check out or execute the pull
request head to obtain access to secrets.

### Missing prompt or invalid model output

For `The prompt file does not exist.`, check the workspace-relative `prompt`
path. A repository prompt needs a checkout of a trusted revision.

For JSON parsing or review schema errors, follow the
[custom prompt contract](#use-a-custom-review-prompt). Return only the supported
JSON object, without Markdown fences or prose outside it. Invalid output fails
before the action publishes comments.

### The pull request changed or has an empty diff

If the head changed during review, start a run for the latest commit. Use a new
pull request event or a [manual review](#manual-reviews). Rerunning an old pull
request event still uses its original base and head commits.

For `The pull request diff is empty.`, confirm that the pull request has changes
against its base branch. The action cannot review an empty diff.

### Output limits or partial publication

For model context limits, reduce the pull request size or select a supported
model with a larger context window. For an oversized review body, use a custom
prompt that returns shorter summaries and finding explanations, or split the
pull request.

A failed run can leave comments or fix replies already posted. Fix the reported
error before retrying. At an unchanged head, the action does not post identical
inline findings again and reuses existing fix replies. If the head changed,
start a run for the latest commit instead.

## Verify in GitHub

Local tests mock Pi and GitHub. They do not verify live model output, GitHub
permissions, or rendered comments. OAuth persistence also requires the
[external verification handoff](../docs/oauth.md#external-verification-handoff),
including queued secret-loading timing and a failure after refresh.
After publishing an action revision, use a test pull request to check:

1. Add known findings on an added line, a removed line, and a multiline range.
   Run a trusted workflow with the new action revision. Check the summary and
   inline thread locations.
2. Run it again at the same head commit. Check that the summary comment ID is
   unchanged and identical inline findings are not duplicated.
3. Push a new commit. Check that the same summary shows the new head and that new
   inline comments are attached to it. Keep intentionally broken test pull
   requests as drafts.
4. Fix one earlier finding with a change visible in the current diff, but leave
   another finding unfixed. Check that the next review posts a short fix reply
   and resolves only the fixed thread. Rerun and check that the reply is not
   duplicated.
