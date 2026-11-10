# ADR-0021: Any failed attempt moves to the next model, and fallbacks can switch provider

- **Status**: Accepted. Supersedes part of [ADR-0005](./0005-model-failover-single-attempt-per-model.md): failover is no longer limited to retryable errors.
- **Date**: 2026-11-08

## Context

ADR-0005 moved to the next model only on a retryable error (5xx, 429, 529, Cloudflare 403). Two gaps showed up in use:

- **Bad output never reached a fallback.** When the review model answered with no findings JSON, or with nothing at all, the review path re-prompted the same model with a stricter instruction. A model that cannot produce the JSON once usually cannot do it twice, while a configured fallback stayed unused. A non-retryable error (for example a 400) also skipped the fallbacks.
- **Fallbacks were stuck on one provider.** Every `fallbackModels` entry ran on the kind's own provider. The `deepseek` provider serves only DeepSeek models, so a DeepSeek review had no way to fall back to Claude. ModelStack can serve several model families behind one key, but only the models it carries.

## Decision

1. **Any failure moves to the next model.** In the review path, an attempt fails when it throws any error, returns an empty answer, or returns no JSON object with a `findings` array. The next attempt goes to the next model in `[model, ...fallbackModels]`, with the stricter prompt. Each model is tried once (ADR-0005's one-try-per-model rule stays). When the last model fails, its error is thrown, or the chunk counts as unparsed, as before. The generic `call` used by the reply, reflection and learn paths also fails over on any error; those paths judge the answer themselves, as before.
2. **With no fallback configured, nothing changes.** One model still gets one stricter same-model re-prompt on bad output, and its errors still throw after the adapter's own retries.
3. **A fallback entry can name a provider.** `anthropic:claude-sonnet-5-5` runs on the `anthropic` provider with `ANTHROPIC_API_KEY`. A bare entry stays on the kind's own provider. Text before the first colon counts as a provider only when it is a known provider name, so ids with their own colon (`meta-llama/llama-3-8b:free`, `llama3:8b`) stay bare ids. Every provider in the chain needs its key at config load (exit 2), not at failover time. `apiBaseUrl` applies to the kind's own provider only.
4. **Two failures do not move on.**
   - An **auth error** skips the remaining models on that provider, since they share the key, and moves to the next provider in the chain.
   - A **terminal error** stops the chain. The terminal errors are the OpenRouter routing failures from ADR-0020: no eligible provider (404) and `context_length_exceeded`. A fallback to an unpinned model would defeat the pin. Any other OpenRouter 400/404 may fail over.

## Consequences

- A bad answer now costs one call on the next model instead of one more call on the same model. Both calls are counted in `usage` and attributed to the model that answered.
- A fallback on another provider needs that provider's key in the CI environment (for the GitHub Action, its `*-api-key` input) and a `pricing:` entry when the built-in table lacks the model.
- An existing bare entry whose id starts with a provider name and a colon (a gateway id such as `anthropic:claude-x` on ModelStack) changes meaning and routes to that provider. Without that provider's key the config fails at load (exit 2). With the key present the entry reroutes, so check gateway configs before upgrading. Prefixing the kind's own provider (`modelstack:anthropic:claude-x`) keeps the old meaning.
- Only the LLM call itself fails over. A throw from the review path's own parsing or logging surfaces as a bug.
- Structured output (`submit_findings`) follows each model's adapter, so a chain can mix tool-capable and JSON-text providers.
- Failover in the review path logs `llm.model.failover` with `reason` (`error`, `empty` or `no-findings-json`), and the generic path logs `llm model failover`. Both logs name the provider and model on each side of the hop.
