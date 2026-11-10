# Usage reference

Details moved out of the README: provider setup, CLI, strict mode, exit codes, state model, Action inputs/outputs, and token permissions. For a 5-minute setup see the [README](../README.md).

## Review provider (GitHub, Bitbucket, GitLab, or Azure DevOps)

The review provider (where PRs and comments live) is separate from the LLM provider. Four are supported:

```yaml
provider: bitbucket   # github (default) | bitbucket | gitlab | azure-devops | auto
```

- **GitHub** (default): set `auth.token: ${GITHUB_TOKEN}`. Required env: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_PR_NUMBER`. Auto-detected on GitHub Actions (`GITHUB_ACTIONS=true`).
- **Bitbucket Cloud**: set `auth.bitbucketToken: ${BITBUCKET_TOKEN}` (a repository/workspace **access token**, sent as Bearer). Required env:
  - `BITBUCKET_TOKEN`
  - `BITBUCKET_WORKSPACE` + `BITBUCKET_REPO_SLUG` (or `BITBUCKET_REPO_FULL_NAME` as `workspace/slug`)
  - `BITBUCKET_PR_ID`

  Auto-detected on Bitbucket Pipelines (`BITBUCKET_PIPELINE_UUID`). Bitbucket **Cloud only** — Server / Data Center is not supported.
- **GitLab**: set `auth.gitlabToken: ${GITLAB_TOKEN}` (project/group access token with the `api` scope). Required env: `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, `GITLAB_TOKEN`. The auto-provided `CI_JOB_TOKEN` is read-only for the write APIs (it only clones the reviewer), so it is not a substitute. Self-hosted GitLab resolves its host from `CI_SERVER_URL` (set automatically on GitLab CI) or `gitlab.baseUrl`, defaulting to `https://gitlab.com`.

  Auto-detected on GitLab CI (`GITLAB_CI=true`). GitLab.com and self-hosted are both supported. See [GitLab setup](./gitlab-setup.md).
- **Azure DevOps**: set `auth.azureToken: ${AZURE_DEVOPS_TOKEN}` (a PAT, sent as Basic with an empty username) or use the pipeline `SYSTEM_ACCESSTOKEN` (Bearer). Required env: `AZURE_DEVOPS_ORG_URL` (or `SYSTEM_COLLECTIONURI` on Pipelines), `SYSTEM_TEAMPROJECT`, `BUILD_REPOSITORY_ID` (or `BUILD_REPOSITORY_NAME`), `SYSTEM_PULLREQUEST_PULLREQUESTID`.

  Auto-detected on Azure Pipelines (`TF_BUILD=True`). Outside Pipelines — locally or on another CI — set `AZURE_DEVOPS_ORG_URL` explicitly, since `SYSTEM_COLLECTIONURI` is absent. The `azure.*` config keys (`orgUrl`, `project`, `repoId`, `prId`, `tokenType`) take precedence over the env vars; see the [configuration reference](./config.md#azure-devops).

Select explicitly with `--provider=github|bitbucket|gitlab|azure-devops` or `provider:` in config; leave `provider: auto` (or omit) to detect from the CI environment.

## Noise reduction

Three knobs reduce non-actionable findings on test files and boilerplate content:

```yaml
review:
  testFileSeverityThreshold: high      # low|medium|high|critical, default high
  noiseCategories: [style, naming]     # LOW severity in these categories dropped everywhere
  skipGeneratedFiles: true             # bypass migrations/fixtures/mocks/snapshots/dist/vendor/etc. before the LLM sees them
```

- `testFileSeverityThreshold` (default `high`): findings on test files (matched by the same convention as `*.test.*`/`*.spec.*`/`__tests__/**`/`*_test.go`/etc.) below this rank are dropped. Default drops LOW and MEDIUM, keeps HIGH/CRITICAL — set to `medium` to restore the pre-1.4 behavior of only dropping LOW.
- `noiseCategories` (default `[style, naming]`): LOW-severity findings whose `category` is in this list are dropped on any file, test or not. Set to `[]` to disable.
- `skipGeneratedFiles` (default `true`): bypasses files under `dist/`, `build/`, `vendor/`, `generated/`, `__mocks__/`, `mocks/`, `fixtures/`, `migrations/`, `__snapshots__/`, or matching `*.lock`/`*.min.*`/`*.generated.*` before they're sent to the LLM — saves tokens in addition to noise. Set to `false` to review these files normally. Note this bypasses `migrations/` and `mocks/`/`__mocks__/` by default too, not just obviously-inert content like `dist/`/`vendor/` — teams relying on AI review of migration files or hand-written mock/fixture logic should set `skipGeneratedFiles: false` or otherwise be aware these paths won't be reviewed. Also note: on the first run after adopting these noise-reduction defaults, existing bot threads that now fall under `testFileSeverityThreshold` / `noiseCategories` / `skipGeneratedFiles` suppression will get closed as "fixed" by the normal reconcile mechanism — they aren't actually fixed, just newly suppressed; this is expected, one-time behavior.

## CLI

```
node pipelines/scripts/ai-review.js review [--config=path] [--provider=github]
node pipelines/scripts/ai-review.js reply  [--config=path] [--provider=github]
```

## Strict mode

Pass `--strict` to fail CI when the AI posts findings at or above `review.severityThreshold` (default `medium`). Exit code is `8` when triggered. The check stays red on every later push while such a thread is still open: it clears when the finding is fixed or a reply argues it to `wontfix`, not when someone presses Resolve ([ADR-0016](./adr/0016-strict-gate-counts-open-blocking-threads.md)).

CLI:

```bash
node pipelines/scripts/ai-review.js review --strict
```

Action:

```yaml
- uses: openwt-vn/owlet-lens@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    subcommand: review
    strict: 'true'
    severity-threshold: 'high'
```

Severity ladder: `low < medium < high < critical`. Findings with unknown or missing severity never block.

Outputs:

- `strict-triggered`: `'true'` when exit code is 8.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No activity (no findings posted/replied/reopened/closed) |
| 1 | Review activity occurred |
| 2 | Config error |
| 3 | Auth error |
| 4 | Provider/HTTP error |
| 5 | LLM error |
| 6 | Partial failure (some posts/replies failed) |
| 7 | Validation error |
| 8 | Strict gate triggered (≥1 blocking-severity finding posted/reopened) |

When both 6 and 8 apply, **8 wins** — a run that failed a write while holding a blocking finding must still fail CI, otherwise `--strict` could be bypassed by an unrelated write error.

## State model

Per-run state is written to `<root>/<sha-slug>/state.json`. `<root>` is `AI_REVIEW_STATE_ROOT` when set, else `$RUNNER_TEMP/ai-review` on a GitHub Actions runner, else `/tmp/ai-review`. `actions/cache` stores a path outside the workspace relative to it, so `/tmp/ai-review` would restore to a missing directory on a self-hosted runner whose workspace sits at another depth (`tar: Cannot mkdir`); `RUNNER_TEMP` is the same offset from the workspace on every runner.

When the action runs in a GitHub Actions environment with `actions/cache` available, the state file is restored at the start of each run and saved at the end (in `try/finally`). This lets the summary comment show **Cumulative cost: $X.XXXX over N run(s)** across multiple workflow invocations on the same PR.

Dismissal state still lives in thread markers, so it survives independently of the cache.

Cache key shape: `ai-review-state-v1-<repoId>-pr-<prNum>-<runId>`. Restore uses the prefix so the most recent run wins. Cache misses (first run on a PR, cache eviction) silently start from $0; failures during save are warn-logged and never change the exit code.


## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic-api-key` | yes | — | Anthropic API key |
| `github-token` | no | `${{ github.token }}` | GitHub token |
| `subcommand` | no | `review` | `review` or `reply` |
| `config-path` | no | `ai-review.config.yaml` | Path to YAML config |
| `provider` | no | `github` | Provider name |
| `dry-run` | no | `false` | Print intent, don't post |
| `pr-number` | no | (from event) | Override PR number |
| `repository` | no | `${{ github.repository }}` | owner/repo override |
| `severity-threshold` | no | (from config) | Override threshold |
| `strict` | no | `false` | Exit non-zero (code 8) on blocking-severity findings |
| `review-model` | no | (from config) | Override review model |
| `reply-model` | no | (from config) | Override reply model; also sets the review-path reflection model |
| `review-provider` | no | (from config) | Override review LLM provider (`anthropic` \| `gemini` \| `deepseek` \| `modelstack` \| `openai` \| `openrouter`); sets `AI_REVIEW_LLM_PROVIDER` |
| `reply-provider` | no | (from config) | Override reply LLM provider; sets `AI_REPLY_LLM_PROVIDER` |

## Outputs

| Output | Description |
|---|---|
| `exit-code` | CLI exit code (0 = no activity, 1 = activity, 8 = strict gate, etc.) |
| `strict-triggered` | `'true'` if strict gate fired (exit code 8) |

## Pinning

- `@v1` — auto-update within v1.x.x (recommended)
- `@v1.0.0` — pin exact version

## Limitations / token permissions

`resolveReviewThread` and `unresolveReviewThread` GraphQL mutations require the `repo` OAuth scope. The default `GITHUB_TOKEN` (with `pull-requests: write`) cannot call them, so the GitHub UI "Resolved" flag is not flipped programmatically.

A token **with** the close permission is expected. A token without it is a setup mistake, so there is no special handling beyond the warning below.

This is **not a correctness issue for reconciliation**. The marker reply (`<!-- ai-review:v1:fixed -->` / `<!-- ai-review:v1:active -->`) still posts on every transition, and the marker is the canonical source for cross-run reconciliation. When the token lacks scope, the resolve/unresolve step soft-skips and emits a `level: warn` log line — the run does not exit 6 for this case.

It does mean the thread stays open on screen. Each `review` run retries the resolve on its own for any thread whose marker says `fixed`/`wontfix` while the platform still shows it open, so granting the scope later fixes threads that are already stuck. Until then the retry warns on every run.

To enable the UI flag flip, supply a PAT with `repo` scope:

```yaml
- uses: openwt-vn/owlet-lens@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    resolve-token: ${{ secrets.AI_REVIEW_RESOLVE_TOKEN }}  # PAT with repo scope, used only to resolve threads
```

## Troubleshooting

**`LLM call failed (status unknown): fetch failed [CODE]`** — the request never reached the LLM API (no HTTP status). `[CODE]` and the `errCode` / `errCause` log fields give the real reason:

| Code | Meaning | Check |
|---|---|---|
| `ENOTFOUND`, `EAI_AGAIN` | DNS cannot resolve the API host | runner DNS / network |
| `ECONNREFUSED`, `ETIMEDOUT` | connection blocked or dropped | firewall, outbound allowlist, proxy |
| `UND_ERR_CONNECT_TIMEOUT` | no connection within the timeout | same as above |
| `CERT_*`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN` | TLS inspection / custom CA | set `NODE_EXTRA_CA_CERTS` |

Model failover helps only when `fallbackModels` names a model on another provider (`<provider>:<model>`, [ADR-0021](./adr/0021-fallback-on-any-failure-across-providers.md)); models on the same provider share one endpoint. Test from the runner with `curl -sv <api-url>`.
