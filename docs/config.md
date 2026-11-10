# Configuration reference

Per-key reference for `ai-review.config.yaml`. The reasons behind the design are in [`docs/adr/`](./adr/). Domain terms are defined in [`CONTEXT.md`](../CONTEXT.md).

## LLM providers

Six providers: `anthropic` (default), `gemini`, `deepseek`, `modelstack`, `openai`, and `openrouter`. `openai` is any OpenAI-compatible endpoint set with `review.apiBaseUrl`; it allows an empty `auth.openaiKey` for local models such as Ollama or LM Studio. Review and reply paths each pick a provider independently.

YAML:

```yaml
review:
  provider: anthropic        # anthropic | gemini | deepseek | modelstack | openai | openrouter
  model: claude-opus-4-7
  codingStandardsPath: ./examples/coding-standards-nestjs-react.md  # optional, see below
  severityThreshold: medium          # low|medium|high|critical, default medium — see Noise reduction
  testFileSeverityThreshold: high    # low|medium|high|critical, default high — see Noise reduction
  tokenBudget: 512000                # prompt token budget, default 512000 — see Prompt token budget
  noiseCategories: [style, naming]   # LOW severity in these categories dropped everywhere, default shown
  skipGeneratedFiles: true           # bypass migrations/fixtures/mocks/snapshots/dist/build/vendor/generated pre-LLM, default true
  skipUnchanged: true                # skip a push whose review fingerprint matches the last full review, default true — see Skip unchanged pushes
  reflection: true                   # second-pass LLM validation of findings, default true — see Reflection filter
  detectBreakingChanges: false       # when true, flags removed/renamed public APIs as HIGH/CRITICAL, default false
  contextPaths:                # optional, see below
    - ./CLAUDE.md
    - ./docs/architecture.md
  fallbackModels:              # optional model failover, see below
    - deepseek-v3.2
    - claude-sonnet-4-6
    - gemini:gemini-3.1-pro    # <provider>:<model> runs on another provider (needs its key)
reply:
  provider: anthropic
  model: claude-haiku-4-5-20251001
  fallbackModels:
    - deepseek-v3.2-flash

auth:
  anthropicKey: ${ANTHROPIC_API_KEY}
  geminiKey:    ${GEMINI_API_KEY}
  deepseekKey:  ${DEEPSEEK_API_KEY}
  modelstackKey: ${MODELSTACK_API_KEY}
  openrouterKey: ${OPENROUTER_API_KEY}

pricing:
  # Optional override of built-in pricing tables. Key = model name (global).
  claude-opus-4-7:
    inputPerMTok: 5
    outputPerMTok: 25
    # Optional. Cache-read rate; defaults to 0.1x inputPerMTok.
    cacheReadPerMTok: 0.5
```

Env-only override: `AI_REVIEW_LLM_PROVIDER`, `AI_REPLY_LLM_PROVIDER`. The GitHub Action exposes them as the `review-provider` / `reply-provider` inputs; the reusable workflow falls back to the caller repo variables of the same names (`vars.AI_REVIEW_LLM_PROVIDER`, `vars.AI_REPLY_LLM_PROVIDER`) when the input is empty. Required env per active provider: `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` / `MODELSTACK_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`. The GitHub Action takes the OpenRouter key as the `openrouter-api-key` input.

Inactive providers' keys not validated — only the active providers' keys must resolve at startup.

`modelstack` targets the ModelStack proxy (`https://api.modelstack.cc/v1/chat/completions`, OpenAI-compatible, `Bearer` auth). It fronts arbitrary upstream models, so the built-in pricing table is empty for it — supply rates under the `pricing:` block (keyed by the model name you route) for accurate cost. Unpriced models log a `level:warn` line and report `$0`.

### OpenRouter

`openrouter` targets OpenRouter (`https://openrouter.ai/api/v1/chat/completions`, OpenAI-compatible, `Bearer` auth). Model ids are OpenRouter slugs such as `z-ai/glm-5.3-flash`. It is meant for models the other providers can't reach. For Claude, use the native `anthropic` provider, which keeps prompt caching.

Routing lives in a top-level `openrouter:` block shared by review and reply:

```yaml
openrouter:
  dataCollection: deny        # allow | deny, default deny
  zdr: false                  # zero-data-retention providers only, default false
  models:                     # keyed by exact model id; applied to the model being called
    z-ai/glm-5.3-flash:
      only: [open-inference/fp4]   # pin providers
      allowFallbacks: false        # never route outside `only` / `order`
      reasoning: { enabled: true } # enabled, effort (low|medium|high), maxTokens
      maxOutputTokens: 32000       # max_tokens cap for this model, default 64000
    qwen/qwen3-coder:
      order: [cerebras, groq]
```

- Per-model keys: `only`, `ignore`, `order`, `quantizations` (string arrays); `allowFallbacks`, `zdr` (booleans); `dataCollection` (`allow|deny`); `sort` (`price|throughput|latency`); `reasoning`; `maxOutputTokens`.
- A per-model value beats the global one, and the global one beats the built-in default (`dataCollection: deny`).
- Any other key is a config error (exit 2). The block's shape is checked on every run, even when `openrouter` is not active.
- When `openrouter` is active, a `models` key that matches none of `review.model`, `reply.model` or their `fallbackModels` logs a warning. A typo would otherwise silently drop the pin.
- JSON-mode calls also send `provider.require_parameters: true`, so only upstreams that honor `response_format` are used.
- Each `fallbackModels` entry uses its own `models` entry, including an `openrouter:<model>` fallback on another provider. Failover stays client-side ([ADR-0005](./adr/0005-model-failover-single-attempt-per-model.md)). A routing failure stops the chain instead of failing over ([ADR-0021](./adr/0021-fallback-on-any-failure-across-providers.md)).
- Cost: a `pricing:` entry for the model wins. Otherwise the run reports OpenRouter's billed `usage.cost` as the total. Otherwise it reports unpriced.
- These errors are terminal (exit 5), with no retry and no failover, and the message names `openrouter.models["<id>"]`:
  - a 404 because no provider is eligible under the routing
  - `context_length_exceeded`

  A pinned provider that is down (429 / 5xx) stays retryable.

Why routing defaults to `deny` and why these errors are terminal: [ADR-0020](./adr/0020-openrouter-privacy-default-routing.md).


### Where the configuration file may send data

The configuration file is part of the code under review: on a pull request it is the version written by the author of that pull request. So it cannot decide where a secret goes. Two rules apply when the file is loaded ([ADR-0019](./adr/0019-config-cannot-redirect-secrets.md)):

- **Secret variables only under `auth.*`.** A `${VAR}` whose name looks like a secret is read only in a field under `auth.`. That is any name that contains `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `PRIVATE`, or that has `KEY` or `PAT` as a whole word (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `AWS_CREDENTIALS`, `AZURE_PAT`). The match is deliberately wide: a harmless name caught by mistake (`MY_PRIVATE_CONFIG`) costs one clear error and a rename, a secret that slips through costs the secret. Anywhere else the load stops with a `ConfigError` that names the field and the variable, never the value.
- **URLs that receive data need an approved host.** `review.apiBaseUrl`, `reply.apiBaseUrl` and `review.exportWebhookUrl` must point at an approved host. The hosts of the built-in providers (`api.anthropic.com`, `api.deepseek.com`, `generativelanguage.googleapis.com`, `api.modelstack.cc`, `api.openai.com`) are approved for `apiBaseUrl`. Any other host, and every webhook host, must be listed by the workflow, not by the file:

```yaml
- uses: openwt-vn/owlet-lens@v1
  with:
    allowed-hosts: llm.corp.example hooks.corp.example   # comma or space separated, exact host names
```

The reusable workflow takes the same `allowed-hosts` input. The list is read from `AI_REVIEW_ALLOWED_HOSTS`, which only the action input sets. Use it for the `openai` provider with a self-hosted endpoint (Ollama, LM Studio, a company gateway) and for export webhooks.

Not covered: `gitlab.baseUrl` and `azure.orgUrl` can still be set by the file. They matter only for the GitLab and Azure DevOps providers.

### Model failover

`review.fallbackModels` / `reply.fallbackModels` (string arrays, default `[]`) list alternate models to try in order after the primary model. Each model gets one attempt ([ADR-0005](./adr/0005-model-failover-single-attempt-per-model.md)).

```yaml
review:
  provider: deepseek
  model: deepseek-v4-pro
  fallbackModels:
    - deepseek-flash                 # bare id: same provider (deepseek)
    - anthropic:claude-sonnet-5-5    # <provider>:<model>: runs on anthropic with ANTHROPIC_API_KEY
```

- **What moves to the next model** ([ADR-0021](./adr/0021-fallback-on-any-failure-across-providers.md)): in the review path, any failed attempt. That means an error, an empty answer, or no JSON object with a `findings` array. Every attempt after the first uses the stricter JSON-only prompt. In the reply, reflection and learn paths, any error moves on.
- **What does not**: an auth error skips the rest of that provider's models and moves to the next provider. An OpenRouter routing failure ([ADR-0020](./adr/0020-openrouter-privacy-default-routing.md)) stops the chain.
- **No fallback configured**: unchanged. Bad output gets one stricter re-prompt on the same model, and errors throw.
- **Provider prefix**: applies to `fallbackModels` entries only. The primary `model` is always a plain id on `provider`. Allowed prefixes are `anthropic`, `gemini`, `deepseek`, `modelstack`, `openai` and `openrouter`, placed before the first colon. Any other prefix is part of the model id, so `meta-llama/llama-3-8b:free` stays a bare id. A gateway id that itself starts with a provider name (for example a ModelStack id `anthropic:claude-x`) now routes to that provider. To keep it on the kind's own provider, prefix it with that provider: `modelstack:anthropic:claude-x`. Each prefixed provider needs its key (env or `auth.*`), or the config fails with exit 2. With the GitHub Action, pass the matching `*-api-key` input. `apiBaseUrl` applies to the kind's own provider only. So when `provider` is not `openai`, an `openai:` fallback targets api.openai.com and needs a non-empty key. A prefix that names the kind's own provider is the same as a bare id: same adapter, same `apiBaseUrl`, same key rules.
- **Logs**: the review path logs `llm.model.failover` (`reason`: `error` | `empty` | `no-findings-json`). The other paths log `llm model failover`. Both name the provider and model on each side.
- **Cost**: attributed to the model that answered (`usage.models`), so every fallback model needs a `pricing:` entry unless the built-in table has it.

Wiring: `buildModelChain` (`lib/llm/model-ref.js`), `makeLLMProvider` (`lib/llm/index.js`), `wrapModelFallback` (`lib/llm/model-fallback.js`) and `callForFindings` (`lib/review-llm.js`).

### Large-file bypass

`review.maxFileBytes` (positive integer or `null`, default `null` = off) caps the size of any single file's diff sent to the LLM. Size is the **UTF-8 byte length of the unified-diff patch** (`diffs[].patch`) — what actually hits the prompt — not the full file or the changed-line count. Files whose patch exceeds the cap are bypassed in the review pass via `lib/file-size-filter.js` `partitionBySize(diffs, maxFileBytes)` **before prompt-building** — ahead of `buildPrompt`'s global token-budget skip — so a single oversized file is dropped even when the budget has room. (Annotation is computed once for all changed files in the review pass and simply not forwarded for bypassed ones.) Every uncovered file (bypassed, budget-dropped, or in a failed chunk) is listed in one `prompt.files.skipped` warn log, and its existing threads are never auto-closed (see Coverage in `CONTEXT.md`). A missing/non-string patch counts as 0 bytes and is always kept; `null`/`0`/negative disables the cap. Validated at load — non-positive or non-integer values raise `ConfigError`.

### Prompt token budget

`review.tokenBudget` (positive integer, default `512000`) is the hard prompt-token ceiling for the main review call and, after the reserved system prompt, each overflow chunk (`lib/prompt-builder.js` and `lib/chunk-diffs.js`). A file that does not fit the main call's remaining budget is moved to an overflow chunk. Traced imports ride the main call only and are dropped when they do not fit the remaining budget — they never push a diff into overflow — with a `review.imports.dropped` warn log.

Set it **below the smallest context window among `review.model` and `review.fallbackModels`**, leaving headroom for the estimate's error: token counts are approximated at 4 chars per token, and the prompt also carries a small amount of framing text (the PR header, per-file `=== path ===` markers, and the skipped-file list). A budget above a model's window means a large PR is sent whole and rejected with a non-retryable 400 instead of being chunked.

Because each overflow chunk and each failover model sees the same budget, a value safe for the smallest model in the failover chain is safe for all of them. `runReviewPass` falls back to `CONFIG.tokenBudget` (512000) only when no value is supplied.

### Noise reduction

`review.severityThreshold` (default `medium`) drops any finding ranked below it, repo-wide, before it reaches the action plan — enforced in `filterFindings` (`lib/review-pass.js`), right after the gates below. It also gates `--strict`'s exit-8 decision (`computeStrictDecision`, [ADR-0017](./adr/0017-severity-threshold-filters-findings.md)): both read the same config value, so a finding that never posts can never trigger strict either. Strict also counts bot threads from earlier runs that are still `active` at or above the threshold, so the check stays red until each one is fixed or argued to `wontfix` ([ADR-0016](./adr/0016-strict-gate-counts-open-blocking-threads.md)).

`review.testFileSeverityThreshold` (default `high`) drops findings on test files (matched by the `isTestFile` convention in `lib/finding-validator.js`) ranked below the threshold — default drops LOW and MEDIUM, keeps HIGH/CRITICAL. `review.noiseCategories` (default `[style, naming]`) drops LOW-severity findings in listed categories on any file. Both gates are enforced in `lib/noise-filter.js`'s `shouldDropAsNoise`, called by the review pass right after `validateFindings` — the prompt (`prompt-builder.js`) is updated to match the defaults as a token-saving hint, but `shouldDropAsNoise` is authoritative.

`review.skipGeneratedFiles` (default `true`) bypasses boilerplate-path diffs (`lib/noise-filter.js`'s `isBoilerplateFile` — migrations/fixtures/mocks/snapshots/dist/build/vendor/generated dirs, plus `*.lock`/`*.min.*`/`*.generated.*`) before `buildPrompt`, in the review pass alongside the existing `maxFileBytes` bypass — both merge into the same `prompt.files.skipped` warn log.

### Skip unchanged pushes

`review.skipUnchanged` (boolean, default `true`) skips a `review` run when nothing the review depends on changed since the last full review — typically a push that only merged the target branch in. The run makes no LLM call, reads no threads, writes nothing to the PR, prints `{"skipped":"no-net-change","fingerprint":"…"}` and exits `0`. The skip is recorded in the audit log and state store at `costUsd: 0`.

"Nothing changed" means the **review fingerprint** matches ([ADR-0015](./adr/0015-skip-unchanged-review-fingerprint.md)). It hashes:

- each reviewable file's path, change status, rename source, and its added and removed lines in order — hunk headers and context lines are left out, so a merge that only shifts line numbers matches. Files the LLM never sees (`paths.exclude`, `maxFileBytes`, `skipGeneratedFiles`) are left out too;
- the effective config, minus `auth`;
- the documents the prompt carries: coding standards, learned suppressions and `contextPaths` documents. Traced import bodies are left out on purpose: a target merge usually changes them.

A full review stamps the fingerprint into the summary comment as a hidden `reviewed-<hash>` key marker, but only when every file was reviewed and every write landed (a run that ends in exit `6` is retried by the next push). Only the bot's own, unedited comment counts (GitLab and Azure DevOps cannot report an edit, see the ADR). A missing marker or a failed lookup means "review".

A run a person asked for always reviews: a **button run** (GitHub re-run, GitLab manual job, a step that sets `AI_REVIEW_TL_PRESSED` — the shipped templates already do), `--force-review`, or `AI_REVIEW_FORCE=1`. `--dry-run` previews what this run would do, so on a matching fingerprint it reports the skip; add `--force-review` to preview the full review.

Known limits: a target merge can break lines the PR did not change (a renamed function the PR still calls), and the skip will not catch it — build and tests do. In `summary.mode: append`, any earlier summary counts, so reverting a PR to an exact earlier state skips until the next real change.

### Reflection filter

`review.reflection` (boolean, default `true`) enables a second-pass LLM validation of findings using the reply model (typically Haiku). After the review LLM returns findings and they pass noise filtering, the reflection filter sends them in batches to the reply model with a "skeptical senior engineer" prompt that challenges each finding's factual accuracy and actionability.

CRITICAL-severity findings bypass reflection entirely (hardcoded) — false negatives on CRITICAL are too costly. Findings are batched (≤20 per call, split into ~15-sized chunks above that). The response maps verdicts by array index: `keep` or `drop` with a reason. Fail-open on any error: LLM failure, unparseable JSON, or missing verdict indices all default to `keep`.

The reflection cost is tracked separately as `reflectionCost` in the summary and rolled into `totalCost`. The summary comment shows `X dropped by reflection`. Per-finding drop logs emit `finding.dropped.reflection` with `{file, line, severity, category, reason}`.

Disable with `review.reflection: false`. The reply model is configured via `reply.provider` / `reply.model`, and on a `review` run the `reply-model` action input (or `AI_REPLY_MODEL`) overrides it — so a workflow that sets `reply-model` for the `reply` job must set it on `review` and `review-on-demand` too, or reflection silently runs on the config value. Because reflection fails open, a model name the provider rejects (e.g. a non-retryable 400 `Invalid model specified`) keeps every finding and only shows up in the CI log as `reflection.chunk.failed` and a non-zero `failed` in `reflection.summary`.

### Breaking-change detection

`review.detectBreakingChanges` (default `false`) appends a breaking-change detection block to the system prompt. When enabled, removed or renamed public APIs (exported functions, classes, routes, CLI flags, config keys, DB columns visible in entity/model diffs) are flagged as HIGH severity with a `BREAKING:` prefix, upgraded to CRITICAL when the PR lacks a migration guide, changelog entry, or deprecation notice. Internal/private changes and additive-only changes are excluded.

### Coding standards

`review.codingStandardsPath` points at a markdown file whose contents are injected into the system prompt as the project's coding-standards block. Path is resolved relative to the CWD when not absolute. Unset / empty / unreadable → soft-fall back to a generic "apply language-idiomatic best practices" placeholder (warning logged on unreadable, not fatal).

Pre-v1.1 the prompt was hardcoded NestJS + TypeORM backend and React + Zustand frontend. Those rules are preserved verbatim as an importable example at [`examples/coding-standards-nestjs-react.md`](./examples/coding-standards-nestjs-react.md). Adopters of that stack can point `codingStandardsPath` at it (or a copy in their own repo) and get identical review behaviour; everyone else writes their own.

### Language-aware coding standards (v1.6)

`review.codingStandards: Array<{ glob, path }>` enables per-language rule injection. Only rules whose glob matches at least one file in the diff are injected into the review prompt. Uses `minimatch` with `matchBase: true` — `*.ts` matches `src/deep/file.ts`.

```yaml
review:
  codingStandardsPath: rules/general.md   # also the learn read/write target
  codingStandards:
    - glob: "*.java"
      path: rules/java.md
    - glob: "*.ts"
      path: rules/typescript.md
    - glob: "*.py"
      path: rules/python.md
```

**Backward compatible**: plain string `codingStandardsPath` still works — internally wrapped as `[{ glob: "*", path }]`. When both keys are set, `codingStandardsPath` is prepended as a `glob: "*"` catch-all to the array. Deduplicated by resolved absolute path.

**Matching semantics**: all-match union — a `.ts` file gets rules from every matching glob (e.g. both `*.ts` and `*`). Concatenation follows array order (general first, specific last). Files matching zero globs get the generic fallback text.

**Learn pipeline**: `codingStandardsPath` remains the exclusive learn read/write target and suppression-rule source. Users who only set `codingStandards` (array) get review but not learn/suppression. See [ADR-0010](./adr/0010-dual-key-coding-standards.md).

**Reply path**: uses `codingStandardsPath` content only (catch-all). No glob matching in replies.

### Project context paths

`review.contextPaths: string[]` (default `[]`) is an ordered list of markdown/text files concatenated into the system prompt under labeled `=== <path> ===` headers, prepended above the review instructions. Use it to feed architecture docs, domain glossaries, or repo-wide guidance (e.g. `./CLAUDE.md`, `./docs/architecture.md`) without inlining everything into `codingStandardsPath`.

Each entry is resolved relative to CWD when not absolute. Unreadable entries log a `level: warn` line and are skipped at read time — never fatal. Empty-string entries are silently dropped at read time. Non-string entries (e.g. `[./a.md, 42]`) raise `ConfigError` at load time so typos surface immediately instead of being masked. Content sits inside the cached system prompt, so adding context paths is essentially free on cache-read hits.

Order matters: earlier paths appear first in the prompt. Prepend the most generally-applicable doc, append the most specific.

### Anthropic prompt caching

The Anthropic adapter sends `system` as an array with `cache_control: { type: 'ephemeral' }` and the `anthropic-beta: prompt-caching-2024-07-31` header. The system prompt (coding standards + review instructions) is stable across runs in a PR, so subsequent calls within the 5-minute cache TTL pay 0.10× input price on cache reads and 1.25× input price on cache writes. `calculateCost` returns `cacheCreationCost` and `cacheReadCost` alongside `inputCost` / `outputCost` / `totalCost`. `ai-review.js` logs `cacheCreationInputTokens` and `cacheReadInputTokens` from `usage`.

Gemini and DeepSeek paths are unaffected — they ignore the cache fields.

### Anthropic structured output (tool-use)

`AnthropicProvider` sets `supportsTools = true`. When the review pass (`lib/review-llm.js`) issues a review call, it forwards a `submit_findings` tool with an `input_schema` (enum-constrained `severity` and `category`, required `findings` array) and `tool_choice: { type: 'tool', name: 'submit_findings' }`. The adapter pulls the `tool_use` block's `input` and JSON-stringifies it into the response `text` field, so the existing `extractClaudeJson` parser keeps working without branching. Gemini and the OpenAI-compatible adapters (`openai-base.js`: DeepSeek, ModelStack, OpenAI) also set `supportsTools = true`; the OpenAI-compatible base only switches on JSON mode and does not enforce the schema, so `extractClaudeJson` still parses their text.

### TL gate (`review.tlGate`)

```yaml
review:
  tlGate:
    enabled: false                  # default: today's behaviour, the AI reviews every push
    leads: ["12345"]                # durable user ids, not usernames
```

With `enabled: true`, a pull request gets **no AI review at all** until a team lead listed in `leads` presses the platform's "turn the AI on" button for that PR. After that the AI reviews every push, as it normally would. There is no turn-off.

| Run | What happens | Exit |
|---|---|---|
| Switch off (the default) | Reviews as before. Nothing else changes. | unchanged |
| On, no press, no note yet | No LLM call. The bot's own gate comment says the AI is waiting and how a lead turns it on. | 0 |
| Press by a listed lead | Reviews as before, then writes the "AI on" note (who + when) as a sticky comment. | unchanged |
| Press by someone else | No LLM call. The comment says who pressed and that the id is not on the list. | 0 |
| The "AI on" note is already on the PR | Reviews as before. | unchanged |

Three rules make the gate trustworthy, and they are the whole design ([ADR-0014](./adr/0014-tl-gate-reads-the-target-branch.md)):

1. **The switch and the list are read from the PR's target branch**, via `provider.getFileContent(configPath, meta.targetSha)` — never from the working folder. In CI the working folder *is* the PR checkout, so reading it there would let a PR switch its own gate off. The filename is resolved the same way: the candidate names (`ai-review.config.yaml`, then `.yml`, or `--config=`) are probed against the target branch, so a PR cannot add or delete a candidate file to steer the gate onto a path that is not there — that read would 404 and look like "no config". This is also why these two keys get **no `${VAR}` interpolation and no env or CLI override**, unlike every other config key.
2. **The "AI on" state is the bot's own comment** ([ADR-0001](./adr/0001-marker-based-state-no-state-file.md)) — not the summary comment, because in append mode every run adds a new one. The PR carries exactly one gate comment, under the marker key `tl-gate`, updated in place; the "AI on" state inside it is a second marker, `tl-on`, so the bot's own "still waiting" comment can never be read back as permission. On GitHub a note someone else edited afterwards is ignored (GraphQL `IssueComment.editor`).
3. **Only a button press turns the AI on**, and only from a listed lead. A push never can, and `reply` is not gated.

Edge cases: `enabled: true` with an empty `leads` list is a `ConfigError` (exit 2) — nobody could open the gate. A missing `tlGate` block, no config file on the target branch, or a target-branch config that will not parse all leave the gate **off**, so a repository that never asked for this behaves exactly as before.

Per-platform button setup: [GitHub](./tl-gate-github-setup.md) · [GitLab](./tl-gate-gitlab-setup.md) · [Bitbucket](./tl-gate-bitbucket-setup.md) · [Azure DevOps](./tl-gate-azure-devops-setup.md). `leads` holds each platform's durable id — a GitHub numeric user id (`GET /user/{account_id}`), a GitLab numeric user id, a Bitbucket account UUID (with its braces), or the Azure DevOps identity GUID.

## Review providers (Bitbucket, GitLab and Azure DevOps)

### Bitbucket

Bitbucket Cloud only (Server/Data Center not supported). Required env: `BITBUCKET_TOKEN` (Bearer access token), `BITBUCKET_WORKSPACE` + `BITBUCKET_REPO_SLUG` (or `BITBUCKET_REPO_FULL_NAME` as `workspace/slug`), `BITBUCKET_PR_ID`. The provider constructor enforces the token (`auth.bitbucketToken` mirrors GitHub's `auth.token`), not `config-loader`. `unified-diff-split.js` splits the combined-diff API response into per-file `DiffFile[]`. Comment resolution uses `POST/DELETE .../comments/{id}/resolve`. A 401/403 there is soft-skipped (the marker reply stays canonical), the same as on GitHub. Marker style: [ADR-0003](./adr/0003-bitbucket-marker-style-probe.md).

### GitLab

GitLab.com and self-hosted. Required env: `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, and `GITLAB_TOKEN` (access token with the `api` scope, sent as `PRIVATE-TOKEN`); `AI_REVIEW_TOKEN` is a fallback name. The auto-provided `CI_JOB_TOKEN` (sent as `JOB-TOKEN`) is read-only for the APIs this tool writes to — it clones the reviewer and reads MRs/diffs, but cannot post notes or create branches/commits/MRs. The base URL resolves from `gitlab.baseUrl`, then `CI_SERVER_URL`, then `https://gitlab.com`. When running outside GitLab CI, `gitlab.projectId` and `gitlab.mrIid` stand in for `CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID`. Auto-detected on GitLab CI (`GITLAB_CI=true`). CI/CD wiring (`.gitlab-ci.yml` template, schedules, token trade-offs): [gitlab-setup.md](./gitlab-setup.md).

### Azure DevOps

Azure DevOps Services and Server. Auth: `AZURE_DEVOPS_TOKEN` (a PAT, sent as Basic with an empty username) or `SYSTEM_ACCESSTOKEN` (the pipeline build token, sent as Bearer); `AI_REVIEW_TOKEN` is a fallback name. The provider constructor enforces the token (`auth.azureToken` mirrors GitHub's `auth.token`), not `config-loader`.

Identifiers resolve from `azure.*` first, then the CI environment:

| Config key | Env fallbacks | Meaning |
|---|---|---|
| `azure.orgUrl` | `AZURE_DEVOPS_ORG_URL`, `SYSTEM_COLLECTIONURI` | Organization / collection URL, e.g. `https://dev.azure.com/acme` |
| `azure.project` | `SYSTEM_TEAMPROJECT` | Team project name |
| `azure.repoId` | `BUILD_REPOSITORY_ID`, `BUILD_REPOSITORY_NAME` | Repository id or name |
| `azure.prId` | `SYSTEM_PULLREQUEST_PULLREQUESTID` | Pull request id |
| `azure.tokenType` | — | `pat` (default) or `bearer` |

On Azure Pipelines these are set automatically (`TF_BUILD=True` auto-detects the provider). Outside Azure Pipelines — locally or on another CI — set `AZURE_DEVOPS_ORG_URL` explicitly, since `SYSTEM_COLLECTIONURI` is absent; the org URL is no longer read from `auth.azureOrgUrl`. Azure DevOps has no unified-diff API, so `getDiff` synthesises a per-file patch from the source commit's file content.

## Self-learning (`review.learn`)

### Config

```yaml
review:
  learn:
    lookbackDays: 45          # rolling window for merged-PR harvest
    minWontfix: 2             # minimum wontfix occurrences to promote a cluster
    minDistinctAuthors: 1     # minimum distinct PR authors across those occurrences
    maxPrs: 200               # cap on merged PRs fetched per run
    branchPrefix: owlet-lens/learn   # proposal branch is `<branchPrefix>-YYYY-MM-DD`
    ignorePath: null          # optional path to a file listing ignored rule fingerprints (one per line)
```

### LEARNED block format

The machine-managed section in `codingStandardsPath` is delimited by HTML comments:

```
<!-- ai-review:learned:start v1 -->
...rules appended by the learn pipeline...
<!-- ai-review:learned-rule=<16hex> -->
<!-- ai-review:learned:end -->
```

Each rule carries a `<!-- ai-review:learned-rule=<16hex> -->` fingerprint marker so dedup is stable across reformats. Human-authored rules go **above** the start delimiter and are never touched by the pipeline.

The proposal branch is `<branchPrefix>-YYYY-MM-DD`, so two `learn` runs on the same day share a branch and the second one updates it rather than opening a second PR.
