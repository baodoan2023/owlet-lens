# LLM Provider Data Policies

How each supported LLM provider handles code sent during AI code review.

## What is sent

### Review path (`npm run review`)

The tool sends **unified diff patches** (changed lines with surrounding context), annotated diffs (line-numbered source with `+`/`-`/` ` markers), and a system prompt containing review instructions, the contents of `review.codingStandardsPath` (read in full), and any files listed in `review.contextPaths` (each read in full). Diff patches alone do not constitute full files, but large diffs may expose substantial portions of a file.

It also sends **traced imports** — the files that the changed files import. For each changed file the tool extracts relative `import`/`require` specifiers from added lines, resolves them to files in the repo, and appends up to 10 of those files in full, capped at 32 KB each (about 80k tokens in the worst case). Files already in the diff set are skipped, and files matching `paths.exclude` are skipped too, so an excluded file never re-enters the prompt through an import. Traced imports are read-only context: the model is told not to review them, and they are not sent with overflow chunks. They are kept inside `review.tokenBudget`.

### Reply path (`npm run reply`)

For each AI thread that a developer has replied to, the tool sends: the full bot↔developer thread transcript, a ±5-line code snippet from HEAD around the finding location, and the file's diff slice. Threads without a developer reply are not evaluated. The code snippet is read from the current HEAD — it may include lines outside the PR diff.

### Learn path (`npm run learn`)

The learn pipeline (run on schedule or manually) harvests wontfix thread items from merged PRs and sends them — including PR thread transcripts with code context and file/line references — to the LLM for clustering into candidate coding-standards rules. This path only runs when explicitly triggered, not during normal review/reply.

## Providers

### Anthropic (Claude)

- **Training**: API inputs/outputs are NOT used for model training by default.
- **Retention**: Inputs and outputs are retained for up to 30 days for safety/abuse monitoring, then deleted. Content flagged during trust & safety review may be retained longer per Anthropic's usage policy.
- **Compliance**: SOC 2 Type II certified. GDPR-compliant (EU data processing addendum available).
- **Docs**: https://www.anthropic.com/policies

### Google Gemini

- **Training**: Paid API tier (Vertex AI / API key billing) does NOT use data for training. **Free/unpaid tier: content submitted may be used by Google to improve products and services (i.e. effectively used for training)** — do not use the free tier with proprietary or sensitive code. See [Google AI Terms](https://ai.google.dev/terms) §4 for details.
- **Retention**: Paid tier retains inputs for safety monitoring per Google Cloud terms.
- **Compliance**: Google Cloud SOC 2 / ISO 27001 certified. GDPR DPA available.
- **Docs**: https://ai.google.dev/terms

### DeepSeek

- **Training**: API terms state inputs may be used to improve services unless opted out.
- **Retention**: Check current terms — retention period not explicitly published as of this writing.
- **Compliance**: Review current DeepSeek API terms before use with sensitive code.
- **Docs**: https://platform.deepseek.com/

### ModelStack (proxy)

- **Training**: ModelStack is a routing proxy — data handling depends on the upstream model provider.
- **Retention**: ModelStack may log requests per their terms. The upstream provider's policy also applies.
- **Failover**: The tool supports `review.fallbackModels` / `reply.fallbackModels`. On any failed attempt, the request moves to the next model in the list (a structured `level: warn` log with `fromProvider`/`fromModel`/`toProvider`/`toModel`/`status` is emitted on each switch). An entry such as `anthropic:claude-sonnet-4-6` sends the request to another LLM provider ([ADR-0021](./adr/0021-fallback-on-any-failure-across-providers.md)), and even a bare entry may be served by a different upstream provider with different data guarantees. **Audit every entry in `fallbackModels` against this data-policy table**, not just the primary model.
- **Compliance**: Assess both ModelStack and the upstream model's policies.
- **Docs**: https://modelstack.cc

### OpenRouter (proxy)

- **Training**: OpenRouter routes each request to one of several upstream providers. This tool sends `provider.data_collection: "deny"` by default, so only providers that do not store or train on prompts are eligible ([ADR-0020](./adr/0020-openrouter-privacy-default-routing.md)).
- **Retention**: Set `openrouter.zdr: true` (globally or per model) to require zero-data-retention endpoints. It shrinks the provider pool.
- **Compliance**: Pin providers per model with `openrouter.models["<id>"].only` and `allowFallbacks: false` when a specific upstream policy is required.
- **Docs**: https://openrouter.ai/docs/features/privacy-and-logging

## Recommendations

1. For sensitive/regulated codebases, use **Anthropic** (clearest no-training guarantee on paid API). For the strongest guarantee, Anthropic offers zero-data-retention (ZDR) agreements for eligible enterprise customers — no inputs are retained even for safety monitoring.
2. Review each provider's current terms before deployment — policies change.
3. Use `review.contextPaths` and `review.codingStandardsPath` conservatively — their contents are read in full and sent to the LLM. Along with the dismissed-context and suppression blocks, they are sent without a pre-send secret scan, so a credential committed to a standards/context file is sent as-is.
4. **Pre-send redaction (`redactDiffSecrets`, SEC-4).** Every LLM-bound payload that carries raw source code or raw developer text is scanned for secret-shaped content and has matches replaced with `[REDACTED]` before the request is made. The count is logged as `diff.secrets.redacted` (review diffs), `imports.secrets.redacted` (traced imports), `reply.secrets.redacted` (reply path) or `learn.secrets.redacted` (learn path).

   | Payload | Redacted before send? |
   |---|---|
   | Review-path diff patches and annotated diffs | yes |
   | Traced imports (review path) | yes |
   | Reply-path thread transcript, HEAD snippet, diff slice | yes |
   | Learn-path harvested thread transcripts | yes |
   | `review.contextPaths` contents | **no — sent as-is** |
   | `review.codingStandardsPath` / `review.codingStandards` files | **no — sent as-is** |
   | `[DISMISSED CONTEXT]` block (prior triaged finding summaries) | **no — sent as-is** |
   | Learned-suppression block (rules derived from `wontfix` threads) | **no — sent as-is** |

   The last four are still sent to the provider unscanned. `contextPaths` and the coding-standards files are files the user deliberately chose to send; the dismissed-context and suppression blocks are bot- or human-authored text derived from earlier threads (a finding summary is capped at the first 200 characters of one line), not raw source or raw developer replies. Treat all four as potentially visible to the provider.

   The scanner is pattern-based, not a proof of absence: it covers API-key prefixes (`sk-`, `sk-ant-`, `AIza`, `ghp_`/`ghs_`/`gho_`, `github_pat_`, `glpat-`, `AKIA`, `xox*`), `password`/`secret`/`token`/`api_key` assignments, `Bearer` tokens, credentials embedded in connection strings, and PEM private key blocks. PEM blocks are located by a delimiter scan over the whole text, not by a line-anchored pattern, so both line-oriented blocks and single-line blocks whose `\n` escapes are literal (JSON/YAML config, env-style files, test fixtures) are covered. Anything it does not recognize still reaches the provider. `log-safe.js` separately redacts log output — that is a different, weaker pass and is not what protects the payloads above.
5. Audit every model in `review.fallbackModels` / `reply.fallbackModels` against the provider data-policy table above — a failover may silently route your code to a provider with weaker guarantees.
6. Consider running behind a corporate proxy or VPN if your org requires network-level controls.

## Last reviewed

2026-09-28 — re-review quarterly or when adding/changing LLM providers.
