// @ts-check
'use strict';

const { OpenAICompatibleProvider } = require('./openai-base.js');
const { LLMError } = require('../errors.js');
const { redactSecrets } = require('../log-safe.js');
const { validateOpenRouterConfig } = require('../openrouter-config.js');

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// OpenRouter fronts reasoning models whose max_tokens covers both reasoning and
// answer tokens (same ceiling as DeepSeek / ModelStack). OpenRouter does not
// clamp it to the model, so small-context models set a per-model
// `maxOutputTokens` instead.
const MAX_OUTPUT_TOKENS = 64_000;
// App attribution on OpenRouter's side. Fixed values, no user data.
const ATTRIBUTION_HEADERS = Object.freeze({
  'HTTP-Referer': 'https://github.com/openwt-vn/owlet-lens',
  'X-Title': 'Owlet Lens',
});

/** @typedef {import('../openrouter-config.js').OpenRouterConfig} OpenRouterConfig */

/** @param {string} base */
function normalizeUrl(base) {
  const b = base.replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

/**
 * Build OpenRouter's `provider` routing object for one model: built-in default
 * (deny), then the global block, then the model's own entry (ADR-0020).
 *
 * @param {OpenRouterConfig} routing
 * @param {string} model
 * @param {boolean} jsonMode
 * @returns {Record<string, unknown>}
 */
function providerPrefs(routing, model, jsonMode) {
  const entry = routing.models[model] ?? {};
  const zdr = entry.zdr ?? routing.zdr;
  return {
    data_collection: entry.dataCollection ?? routing.dataCollection,
    ...(zdr ? { zdr: true } : {}),
    ...(entry.only ? { only: entry.only } : {}),
    ...(entry.ignore ? { ignore: entry.ignore } : {}),
    ...(entry.order ? { order: entry.order } : {}),
    ...(entry.quantizations ? { quantizations: entry.quantizations } : {}),
    ...(entry.allowFallbacks !== undefined ? { allow_fallbacks: entry.allowFallbacks } : {}),
    ...(entry.sort ? { sort: entry.sort } : {}),
    // Route only to upstreams that honor response_format; others silently
    // return prose.
    ...(jsonMode ? { require_parameters: true } : {}),
  };
}

/**
 * @param {import('../openrouter-config.js').OpenRouterReasoning | undefined} r
 * @returns {Record<string, unknown> | undefined}
 */
function reasoningBody(r) {
  if (!r) return undefined;
  return {
    ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
    ...(r.effort ? { effort: r.effort } : {}),
    ...(r.maxTokens ? { max_tokens: r.maxTokens } : {}),
  };
}

/**
 * Hint for errors that a retry or another model cannot fix: they come from the
 * routing config or the prompt size. Empty string when the error is unknown.
 *
 * @param {string} model
 * @param {number} status
 * @param {string} text  error message / body
 * @returns {string}
 */
function routingHint(model, status, text) {
  const key = `openrouter.models[${JSON.stringify(model)}]`;
  if (/context_length_exceeded/i.test(text)) {
    return ` (prompt plus max_tokens exceed the model context; lower ${key}.maxOutputTokens or review.tokenBudget)`;
  }
  if (status === 404) {
    return ` (no provider is eligible for this model under its routing; check ${key} only/ignore/quantizations, `
      + 'openrouter.dataCollection / zdr, and that a provider supports JSON mode)';
  }
  return '';
}

/**
 * OpenRouter gateway (OpenAI-compatible chat completions). Adds privacy and
 * per-model provider routing, billed cost from `usage.cost`, and terminal
 * errors with routing hints for failures no retry can fix.
 */
class OpenRouterProvider extends OpenAICompatibleProvider {
  /**
   * @param {{
   *   apiKey: string, defaultModel: string, pricingOverride: Record<string, any>,
   *   maxAttempts?: number, apiBaseUrl?: string, routing?: OpenRouterConfig,
   * }} opts
   */
  constructor(opts) {
    super({
      ...opts,
      providerName: 'openrouter',
      errorLabel: 'OpenRouter',
      apiUrl: opts.apiBaseUrl ? normalizeUrl(opts.apiBaseUrl) : API_URL,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    this.routing = opts.routing ?? validateOpenRouterConfig(undefined);
  }

  /** @param {Parameters<OpenAICompatibleProvider['_request']>[0]} args */
  _request(args) {
    const base = super._request(args);
    const entry = this.routing.models[args.model] ?? {};
    const reasoning = reasoningBody(entry.reasoning);
    return {
      url: base.url,
      headers: { ...base.headers, ...ATTRIBUTION_HEADERS },
      body: {
        ...base.body,
        max_tokens: Math.min(args.maxTokens, entry.maxOutputTokens ?? MAX_OUTPUT_TOKENS),
        provider: providerPrefs(this.routing, args.model, 'response_format' in base.body),
        ...(reasoning ? { reasoning } : {}),
      },
    };
  }

  /**
   * 400/404 are never retried on the same model. A routing cause adds a hint
   * and marks the error terminal, so no fallback model papers over the pin
   * (ADR-0020); any other 400/404 may fail over (ADR-0021).
   * @param {Response} res
   * @param {{ model?: string }} [ctx]
   */
  async mapHttpError(res, ctx = {}) {
    if (res.status === 400 || res.status === 404) {
      const txt = await res.text().catch(() => '');
      const hint = routingHint(ctx.model ?? this.defaultModel, res.status, txt);
      throw new LLMError(`${this.errorLabel} ${res.status}: ${redactSecrets(txt).slice(0, 200)}${hint}`, { terminal: hint !== '' });
    }
    return super.mapHttpError(res, ctx);
  }

  /**
   * @param {{ code?: unknown, message?: unknown, metadata?: { error_type?: unknown } }} error
   * @param {string} model
   */
  _mapStreamError(error, model) {
    const mapped = super._mapStreamError(error, model);
    if (!(mapped instanceof LLMError)) return mapped;
    const text = `${String(error?.message ?? '')} ${String(error?.metadata?.error_type ?? '')}`;
    const hint = routingHint(model, Number(error?.code), text);
    return hint ? new LLMError(`${mapped.message}${hint}`, { terminal: true }) : mapped;
  }

  /**
   * A `pricing:` override wins, then the billed `usage.cost`, then the
   * (empty) built-in table, which reports unpriced.
   * @param {string} model
   * @param {{ inputTokens: number, outputTokens: number }} usage
   * @param {any} rawUsage
   */
  _cost(model, usage, rawUsage) {
    const billed = rawUsage?.cost;
    if (!this.pricingOverride[model] && typeof billed === 'number' && Number.isFinite(billed) && billed >= 0) {
      return { inputCost: 0, outputCost: 0, cacheCreationCost: 0, cacheReadCost: 0, totalCost: billed, priced: true };
    }
    return super._cost(model, usage, rawUsage);
  }
}

module.exports = { OpenRouterProvider };
