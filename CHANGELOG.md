# pi-actions

## 0.3.2

### Patch Changes

- fb31db9: Warn instead of failing the review when the workflow token cannot resolve a
  verified review thread (`Resource not accessible by integration`). The fix
  explanation is still posted and the thread stays open. Other resolution
  failures still fail the job.

## 0.3.1

### Patch Changes

- 558b448: Update package metadata, workflow action paths, and documentation for the
  repository rename to `narumiruna/pi-actions`. Keep existing review comment
  markers unchanged.

## 0.3.0

### Minor Changes

- 4f20df2: Add opt-in OAuth credential persistence for review and triage through GitHub Actions environment secrets. Save refreshed credentials after Pi exits, including failures, while keeping the writer token separate from Pi and normal GitHub operations. Reuse an existing PAT_TOKEN for secret updates without a separate writer secret. Suppress OAuth error diagnostics that can contain tokens not yet saved by Pi. Document shared job serialization, setup, live verification, and recovery requirements.
- 7e21903: Add a standalone persist-auth action that validates private OAuth credential files and saves them to environment secrets with an existing PAT_TOKEN. Add an optional auth-output handoff to review and triage, including failed Pi exits and successful no-op tasks, while preserving the inline persistence interface. Document cleanup ownership, shared job locking, and the standalone post-publication failure window.

## 0.2.0

### Minor Changes

- 5aaa7e3: Add a rebase action that uses GitHub to rebase outdated pull request branches on base branch pushes, pull request events, or manual runs. Skip drafts, forks, and known merge conflicts without checking out pull request code.

## 0.1.0

### Minor Changes

- f62e24b: Recheck earlier unresolved Pi findings against the current diff. Post a short explanation in simple technical English before resolving each verified fix. Leave uncertain findings and other authors' threads unchanged, and avoid duplicate fix replies on same-commit retries.

### Patch Changes

- 7f63f7d: Improve review comment readability with summary-first content, finding counts, linked diff locations on separate lines, and short commit links in the footer.
- d139b10: Show inline findings in a Markdown table with severity, title, and a linked file name and line range. Keep full file paths in link tooltips and preserve inline comment text.

## 0.0.2

### Patch Changes

- 2b6c55e: Support fork pull request reviews through trusted `pull_request_target` workflows. Add a `pull-request` input for manual reviews through `workflow_dispatch`. Both paths review only the diff without checking out or running pull request code, and keep the stale-head check before publication.

## 0.0.1

### Patch Changes

- 7acb6fa: Move the pull request review action from the repository root to `review/action.yml`.
  Update workflows from `narumiruna/pi-actions@<ref>` to
  `narumiruna/pi-actions/review@<ref>`. The repository root is no longer an action entry point.
