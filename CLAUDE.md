# CLAUDE.md

Project guidance for Claude Code. Multi-provider AI code review CLI (GitHub, Bitbucket Cloud, GitLab, Azure DevOps).

- Domain terms (Review pass, Coverage, Action plan): [`CONTEXT.md`](./CONTEXT.md)
- Architectural decisions and their reasons: [`docs/adr/`](./docs/adr/)
- Per-key config reference: [`docs/config.md`](./docs/config.md)

---

## What this is

Three subcommands:

- `review`: fetch the PR diff, ask the LLM for findings, reconcile against existing threads, post/reply/reopen/close, and upsert a sticky summary comment. A push whose review fingerprint matches the last full review (e.g. a merge from the target branch) is skipped ([ADR-0015](./docs/adr/0015-skip-unchanged-review-fingerprint.md)).
- `reply`: for each AI thread a dev replied to, assemble context (thread transcript, ±5 lines of code at HEAD, file diff slice) and ask a small model for a `fixed | wontfix | active` verdict ([ADR-0007](./docs/adr/0007-llm-reply-verdict.md)).
- `learn`: mine `wontfix` verdicts from merged PRs and propose coding-standards rules via a PR (see Self-learning below).

Cross-run identity lives in comment markers, not a state file ([ADR-0001](./docs/adr/0001-marker-based-state-no-state-file.md)).

---

## Commands

```bash
npm install
npm run review                  # one-shot review
npm run reply                   # evaluate dev replies
npm run learn                   # propose coding-standards updates; add -- --dry-run to print only
npm test                        # node:test runner, full suite
node --test pipelines/scripts/__tests__/<file>.test.js   # single test file
node pipelines/scripts/ai-review.js review --config=path --provider=github
```

Required env (GitHub): `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_PR_NUMBER`, plus the active LLM provider's key (e.g. `ANTHROPIC_API_KEY`). Other providers: see [`docs/config.md`](./docs/config.md).

---

## Architecture

```
pipelines/scripts/
  ai-review.js        # entrypoint: runReview, runReply (runLearn re-exported from lib/learn/runner.js)
  lib/
    args.js           # CLI flag parsing
    review-pass.js    # runReviewPass: diffs + threads -> action plan
    action-poster.js  # postActionPlan: post / reply / reopen / close the action plan
    run-lifecycle.js  # repo resolution, state-store append, audit-log write, error -> exit code
    review-llm.js     # review LLM call: submit_findings tool, JSON extraction, one re-prompt
    reconcile.js      # toPost / toReply / toReopen / toClose
    markers.js, marker-codec.js, fingerprint.js   # wire markers + fingerprints
    config-loader.js  # loadConfig: config-merge.js -> config-validate.js
    config-merge.js   # defaults, YAML + ${ENV} interpolation, env/CLI layering
    config-validate.js # field validation + normalization, active-key gate
    openrouter-config.js # `openrouter:` routing block validation (ADR-0020)
    prompt-builder.js, context-loader.js          # system + user prompt, token budget
    pr-description.js # PR description -> prompt-safe context (strip, redact, cap)
    noise-filter.js, file-size-filter.js, finding-validator.js   # bypasses + finding filters
    log-safe.js       # secret redaction; errors.js: typed errors
    llm/              # LLM adapters (anthropic, gemini, deepseek, modelstack, openrouter, openai-base) + pricing + model-ref/model-fallback (cross-provider chain, ADR-0021)
    providers/        # review providers (github, bitbucket, gitlab, azure-devops) behind IReviewProvider
    port/             # cross-cutting wrappers over providers: summary, dismissal, reply context/evaluator, learn, state, strict
    learn/            # runner.js (learn subcommand) + harvester -> clusterer -> threshold -> dedup -> standards-block
```

**Review pass**: `runReview` loads config and prompt context, calls `runReviewPass`, then posts the returned action plan. Everything between "what changed" and "what to post / reply / reopen / close" lives behind that one interface and is tested there (`__tests__/review-pass.test.js`, scripted fake LLM, no provider mocks).

**Layering rule**: `ai-review.js` orchestrates; `lib/port/*` wraps providers for cross-cutting concerns; `lib/providers/*` is the only place that knows a platform API. Don't leak Octokit/Bitbucket/GitLab/Azure types upward. Credentials, CI env and bot identity stay in each provider; only the HTTP status-to-error table is shared, in `providers/http-error.js` ([ADR-0012](./docs/adr/0012-providers-own-platform-concerns.md)).

**Reconcile**: reopen needs only a fingerprint match; close needs every guard. Don't relax the close guards without reading [ADR-0002](./docs/adr/0002-asymmetric-reconcile-guards.md).

---

## Review providers

| Provider | Client | Selected when |
|---|---|---|
| `github` | Octokit REST + GraphQL | `--provider=github`, `config.provider: github`, or auto via `GITHUB_ACTIONS=true` |
| `bitbucket` | native `fetch` (Bitbucket Cloud REST 2.0) | `--provider=bitbucket`, `config.provider: bitbucket`, or auto via `BITBUCKET_PIPELINE_UUID` / `BITBUCKET_BUILD_NUMBER` |
| `gitlab` | native `fetch` (GitLab REST v4) | `--provider=gitlab`, `config.provider: gitlab`, or auto via `GITLAB_CI=true` |
| `azure-devops` | native `fetch` (Azure DevOps REST) | `--provider=azure-devops`, `config.provider: azure-devops`, or auto via `TF_BUILD=True` |

---

## Self-learning (learn)

Pipeline: **harvest** bot-authored, fingerprinted `wontfix` threads from merged PRs in `lookbackDays` → **cluster** with the review LLM → **threshold** by `minWontfix` and `minDistinctAuthors` → **dedup** against the LEARNED block and `ignorePath` → **render** into the LEARNED block of `codingStandardsPath` → **propose** via `provider.proposeStandardsChange` on branch `<branchPrefix>-YYYY-MM-DD` (e.g. `owlet-lens/learn-2026-09-25`).

- Security findings are harvested like any other category ([ADR-0004](./docs/adr/0004-learn-harvests-security-findings.md)). The proposal PR review is the only safeguard.
- Nothing auto-merges. Human-authored rules go above the LEARNED start delimiter and the pipeline never touches them.
- The branch name carries a date, not a timestamp: two `learn` runs on the same day land on the same branch, and every provider treats "branch already exists" as reuse (`github.js`, `gitlab.js`, `azure-devops.js`, `bitbucket.js`), so a same-day rerun updates that branch instead of opening a second PR.
- Provider methods: `listMergedPRs`, `listThreadsForPR`, `proposeStandardsChange`, gated by `capabilities.canProposeChanges` (all four providers: `true`).
- Trigger: Bitbucket Pipelines `custom: learn` on a biweekly schedule, or manually.

Config keys and the LEARNED block format: [`docs/config.md`](./docs/config.md#self-learning-reviewlearn).

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No activity |
| 1 | Review activity (post/reply/reopen/close happened); or learn PR proposed |
| 2 | Config error |
| 3 | Auth error |
| 4 | Provider/HTTP error |
| 5 | LLM error |
| 6 | Partial failure (some posts/replies failed) |
| 7 | Validation error |
| 8 | Strict gate triggered (≥1 blocking-severity finding posted/reopened) |

8 takes precedence over 6: a run with a blocking finding fails CI even if a write also failed.

`learn`: 0 = no proposal (nothing to propose, dry-run, or no `canProposeChanges`); 1 = PR proposed; 2/3/4/5 = shared errors. CI gates downstream jobs on the `exit_code` step output.

---

## Conventions

- **Immutability**: never mutate findings/threads in place; new objects only.
- **No `as any`**: typedef'd JSDoc shapes throughout. Narrow envelope types at port boundary.
- **Error handling**: structured stderr JSON for failures (`{level, msg, errName, errMessage, ...}`). User-friendly stdout JSON on success.
- **Testing**: node:test built-in, no jest. Tests live under `pipelines/scripts/__tests__/`, named `*.test.js`.
- **File size**: <500 lines.
- **Secrets**: no tokens in logs (use `log-safe.js`).

## Pre-commit

- `npm test` green
- No `console.log` (use stderr JSON)
- No hardcoded tokens / API keys
- Files <500 lines

---

## Release / shipping

**Version bumps are explicit only**. Never bump automatically. When the user says "ship it" / "merge PR", **ask first whether to bump the version, and if so minor or major**. Do not merge or ship without asking. On a yes, bump `package.json` + `package-lock.json` (`npm version <minor|major> --no-git-tag-version`), commit `chore: bump version to X.Y.Z`, tag `vX.Y.Z`, and push the tag. The Release workflow builds `dist/`, commits it to the tag, and force-updates the major-version tag (`v2`).

**Never commit `dist/`** in feature branches or PRs ([ADR-0006](./docs/adr/0006-dist-built-only-by-release.md)).

---

## Agent skills

- **Issue tracker**: local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.
- **Triage labels**: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- **Domain docs**: single-context, root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
