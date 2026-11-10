# GitLab setup

Run AI code review on GitLab merge requests. The GitLab review provider
implements the full `IReviewProvider` contract — review, reply, and learn — and
works with both GitLab.com (SaaS) and self-hosted GitLab.

## Quick start

1. Copy [`examples/gitlab-ci.yml`](../examples/gitlab-ci.yml) into your project
   as `.gitlab-ci.yml` (or `include:` it from the reviewer project).
2. Set `AI_REVIEW_REPO` in the template to the reviewer project's clone URL and
   pin `AI_REVIEW_REF`. The template clones the reviewer with the job token
   (`CI_JOB_TOKEN`), so if the reviewer project is **private**, add this project
   to the reviewer's **Settings → CI/CD → Job token permissions** allowlist (or
   point the clone at a token-authenticated URL).
3. Add CI/CD variables under **Settings → CI/CD → Variables**:

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `ANTHROPIC_API_KEY` (or `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` / `MODELSTACK_API_KEY` / `OPENROUTER_API_KEY`) | yes | Key for whichever LLM `review.provider` / `reply.provider` use. Mark **Masked**. |
   | `GITLAB_TOKEN` | yes | Project/group access token with the `api` scope. Required for the write paths: posting notes, resolving discussions, and creating the learn branch/commit/MR. Mark **Masked**. |

4. Copy [`examples/ai-review.gitlab.yaml`](../examples/ai-review.gitlab.yaml) to
   `ai-review.config.yaml` (or point `--config` at it) and adjust the LLM
   provider/model.

GitLab auto-provides these on merge request pipelines — no setup needed:
`CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, `CI_SERVER_URL`, `CI_JOB_TOKEN`.

## Authentication

The provider resolves its token as `auth.gitlabToken` first, then
`GITLAB_TOKEN` → `CI_JOB_TOKEN` → `AI_REVIEW_TOKEN`.

| Token | HTTP header | Scope | When to use |
| --- | --- | --- | --- |
| `GITLAB_TOKEN` | `PRIVATE-TOKEN` | `api` (project/group access token) | **Required.** The write paths — posting review notes, resolving discussions, and creating the learn branch/commit/MR — need it. |
| `CI_JOB_TOKEN` | `JOB-TOKEN` | Auto-provided per job | Read-only for the APIs this tool uses. It clones the reviewer and reads MRs/diffs, but cannot post notes or create branches/commits/MRs. |
| `AI_REVIEW_TOKEN` | `PRIVATE-TOKEN` | `api` | Fallback name if your CI variables already use it. |

`CI_JOB_TOKEN` is **not** a zero-config substitute. GitLab grants job tokens only
`GET` on the Merge requests, Notes, Branches, and Commits APIs, so
`POST .../notes`, `/repository/branches`, `/repository/commits`, and
`/merge_requests` all return `401`/`403` with a job token. Supply `GITLAB_TOKEN`
so review, reply, and learn can write.

## Self-hosted GitLab

The base URL comes from `gitlab.baseUrl` in the config, then `CI_SERVER_URL`,
then `https://gitlab.com`:

```yaml
gitlab:
  baseUrl: https://gitlab.example.com
```

On self-hosted CI, `CI_SERVER_URL` is set automatically, so the config key is
only needed when running outside GitLab CI. `CI_PROJECT_ID` is the numeric
project id and is URL-safe as-is on GitLab.

## Merge request pipelines

The template gates review and reply on merge request pipelines:

```yaml
rules:
  - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

GitLab creates a merge request pipeline when rules reference
`merge_request_event`. Review and reply both run on every MR pipeline; reply
runs first (GitLab has no PR-comment trigger, so reply is re-evaluated on each
push — the same ordering the Bitbucket pipeline uses). The reply job is
**`allow_failure: true`**, so a reply error does not skip review.

The template also ships an `owlet-lens-review-tl` job (`when: manual`,
`allow_failure: true`). It is only used when `review.tlGate.enabled` is on —
see [tl-gate-gitlab-setup.md](./tl-gate-gitlab-setup.md). It is harmless
otherwise, since no job `needs:` it.

## Learn schedule

The `owlet-lens-learn` job runs on scheduled pipelines:

```yaml
rules:
  - if: $CI_PIPELINE_SOURCE == "schedule"
```

Create a pipeline schedule under **Settings → CI/CD → Pipeline schedules**
(recommended: every 2 weeks, target the default branch). The learn pass mines
`wontfix` signals from merged MRs and opens a proposal MR against
`review.learn.branchPrefix`. Nothing auto-merges. Because it creates a branch,
commit, and merge request, learn requires `GITLAB_TOKEN` — `CI_JOB_TOKEN`
cannot create them.

## Configuration reference

GitLab sits behind the `provider:` key, independent of the LLM provider:

```yaml
provider: gitlab

auth:
  # gitlabToken: ${GITLAB_TOKEN}   # required for writes (post notes, resolve
  #                                  discussions, learn); resolves from the
  #                                  GITLAB_TOKEN env var when unset
  anthropicKey: ${ANTHROPIC_API_KEY}

# gitlab:                          # self-hosted only; commented for gitlab.com
#   baseUrl: https://gitlab.example.com

review:
  provider: anthropic
  model: claude-opus-4-7

reply:
  provider: anthropic
  model: claude-haiku-4-5-20251001
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `AuthError: GitLab token missing` | No `GITLAB_TOKEN`/`CI_JOB_TOKEN`/`auth.gitlabToken` resolved | Add `GITLAB_TOKEN` as a CI/CD variable, or run inside GitLab CI so `CI_JOB_TOKEN` is present. |
| `401`/`403` when posting notes or running learn | Only `CI_JOB_TOKEN` is available | Supply `GITLAB_TOKEN` (access token with `api` scope); the job token is read-only for the Merge requests, Notes, Branches, and Commits APIs. |
| `ProviderError: GitLab project ID missing` | `CI_PROJECT_ID` unset (ran outside CI) and no `gitlab.projectId` | Run in a MR pipeline, or set `gitlab.projectId` in the config. |
| `ProviderError: GitLab MR iid missing` | `CI_MERGE_REQUEST_IID` unset | The pipeline must be a merge request pipeline; check the `rules:` gate. |
| `401` on every call | Token lacks the `api` scope, or is expired | Re-issue the access token with `api` scope. |
| Cannot resolve discussions | Using `CI_JOB_TOKEN` | Supply `GITLAB_TOKEN` (access token with `api` scope). |
| Reviewer project clone fails (`fatal: could not read Username`) | Consumer project not allowed to use the reviewer's job token | Add this project under the reviewer's **Settings → CI/CD → Job token permissions**, or authenticate the clone URL with a token. |
| Wrong host / `404` | Self-hosted base URL not set | Set `gitlab.baseUrl` or rely on `CI_SERVER_URL`. |

Exit codes: `0` = no activity, `1` = review activity → the job passes. Errors
(`2`-`7`) and the strict gate (`8`) fail the job. See the README for the full
table.
