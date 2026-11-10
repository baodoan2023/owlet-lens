# Model failover tries each model once, and only on retryable errors

> Partly superseded by [ADR-0021](./0021-fallback-on-any-failure-across-providers.md): any failure now moves to the next model, including bad output in the review path, and a fallback entry can name another provider. One try per model still holds.

With proxies such as ModelStack, one upstream model can return 502 while other models stay healthy, so retrying the same model three times mostly wastes time. When `fallbackModels` gives two or more distinct models, `makeLLMProvider` builds an order-preserving, deduped list `[primary, ...fallbackModels]`. It constructs the inner provider with `maxAttempts: 1` and wraps it in `wrapModelFallback`, which moves to the next model only on a retryable error: 5xx, 429, 529, or a Cloudflare challenge on a 403. Auth errors and other non-retryable errors throw immediately, because another model with the same key will fail the same way. With zero or one distinct model, the normal `maxAttempts: 3` same-model retry stays.

## Consequences

- Cost is attributed to the model that actually answered (`usage.models`), so every fallback model needs a `pricing:` entry for accurate cost.
