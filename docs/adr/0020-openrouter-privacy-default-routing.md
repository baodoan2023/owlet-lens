# ADR-0020: OpenRouter routes privately by default and pins providers per model

- **Status**: Accepted
- **Date**: 2026-10-27

## Context

OpenRouter puts hundreds of models behind one OpenAI-compatible endpoint. Each model can be served by several upstream providers, and the providers differ in data policy, quantization, price and which request parameters they honor. `provider: openai` with `apiBaseUrl` already reaches OpenRouter, but it cannot control any of that routing.

This tool sends proprietary diffs. By default, OpenRouter (`data_collection: allow`) may route a request to a provider that stores prompts or trains on them.

## Decision

1. **Private routing is the default.** Every request sends `provider.data_collection: "deny"` unless config says `allow`. `zdr` (zero data retention) is opt-in, because it shrinks the provider pool much more and some models have no eligible endpoint at all.
2. **Routing is set per model, in one shared block.** A top-level `openrouter:` block holds global `dataCollection` / `zdr` and a `models` map keyed by exact model id. The adapter merges three layers for the model being called, last one winning: built-in default, then global, then the model's entry. Each `fallbackModels` entry therefore keeps its own pin (`only`, `allowFallbacks: false`, …).
3. **Only whitelisted fields are accepted.** Per-model keys are `only`, `ignore`, `order`, `quantizations`, `allowFallbacks`, `zdr`, `dataCollection`, `sort`, `reasoning` and `maxOutputTokens`. Any other key fails the config with exit 2, so a typo such as `allow_fallback` cannot silently drop a pin. Supporting a new OpenRouter field is a one-line change.
4. **Routing failures are terminal.** These two errors throw a terminal `LLMError` (exit 5), with no same-model retry and no model failover:
   - a 404 because no provider is eligible after routing
   - `context_length_exceeded`

   The message names `openrouter.models["<id>"]`. Both are configuration problems. Failing over to an unpinned model would defeat the pin. A pinned provider that is down (429 / 5xx) stays retryable, as in ADR-0005.
5. **Cost uses the billed amount.** A `pricing:` entry for the model wins. Otherwise the cost is OpenRouter's `usage.cost`, reported as the total with a zero input/output split. With neither, the call is reported as unpriced. There is no built-in OpenRouter price table, because prices change per provider and per day.

## Consequences

- Some models have fewer providers, or none, under `deny`. A user who accepts the trade sets `dataCollection: allow` globally or for that model.
- JSON-mode calls also send `require_parameters: true`. A model whose providers ignore `response_format` then returns 404 with the routing hint, instead of prose the parser drops.
- Model failover stays client-side (`wrapModelFallback`). OpenRouter's server-side `models: [...]` is not used, so failover is logged the same way for every provider.
