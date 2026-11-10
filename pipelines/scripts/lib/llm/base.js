// @ts-check
'use strict';

const { withRetry, parseRetryAfter } = require('../retry.js');
const { AuthError, RateLimitError, ProviderError, LLMError, ConfigError } = require('../errors.js');
const { redactSecrets } = require('../log-safe.js');
const { calculateCost } = require('./pricing.js');
const { Agent } = require('undici');

const DEFAULT_MAX_TOKENS = 32000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const FETCH_DISPATCHERS = new Map();

function getFetchTimeoutMs(env = process.env) {
  const raw = env.AI_REVIEW_LLM_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  return DEFAULT_FETCH_TIMEOUT_MS;
}

function getFetchDispatcher(timeoutMs) {
  if (!FETCH_DISPATCHERS.has(timeoutMs)) {
    FETCH_DISPATCHERS.set(timeoutMs, new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    }));
  }
  return FETCH_DISPATCHERS.get(timeoutMs);
}

/**
 * Detect a Cloudflare edge challenge masquerading as a provider 403.
 *
 * When a provider (e.g. ModelStack) sits behind Cloudflare, the edge can return
 * a 403 with an HTML interstitial ("Just a moment...", "Attention Required")
 * instead of the provider's JSON auth error. This is a *transient* edge
 * mitigation, NOT a credential failure: a byte-identical request seconds later
 * usually succeeds. Callers use this to reclassify such 403s as retryable so a
 * blip doesn't kill the whole run in ~50ms with a misleading auth error.
 *
 * A genuine `{"error":"invalid_api_key"}` JSON 403 never matches.
 *
 * @param {{ contentType?: string, body?: string, cfMitigated?: string|null }} [args]
 * @returns {boolean}
 */
function isCloudflareChallenge({ contentType = '', body = '', cfMitigated = null } = {}) {
  // Strongest signal: Cloudflare sets `cf-mitigated: challenge` on interstitials.
  if (typeof cfMitigated === 'string' && cfMitigated.trim() !== '') return true;
  // Markers that appear in challenge/block pages but not in a provider's JSON
  // auth error body.
  const CHALLENGE_MARKERS = /just a moment|attention required|cf-ray|enable javascript and cookies|cf-mitigated/i;
  if (CHALLENGE_MARKERS.test(body)) return true;
  // HTML response that names Cloudflare — covers themed/edge pages lacking the
  // strong markers above.
  if (/text\/html/i.test(contentType) && /cloudflare/i.test(body)) return true;
  return false;
}

/**
 * Template-method base class for LLM provider adapters.
 *
 * Subclasses set `providerName` (lowercase id used for cost lookup + retry
 * label) and `errorLabel` (human-readable prefix in error messages), and
 * override the abstract hooks `_request` / `_extractText` / `_extractUsage`.
 * The base owns retry orchestration, HTTP status -> typed-error mapping,
 * JSON parsing, and cost calculation so the three adapters can stay focused
 * on their wire format.
 */
class BaseLLMProvider {
  /**
   * @param {{
   *   providerName: string,
   *   errorLabel: string,
   *   apiKey: string,
   *   defaultModel: string,
   *   pricingOverride?: Record<string, any>,
   *   maxAttempts?: number,
   *   apiBaseUrl?: string,
   * }} opts
   */
  constructor(opts) {
    // openai allows empty key for local models (Ollama, LM Studio)
    const allowEmpty = opts?.providerName === 'openai';
    if (typeof opts?.apiKey !== 'string' || (!allowEmpty && opts.apiKey.trim() === '')) {
      throw new ConfigError(`${opts?.errorLabel || 'LLMProvider'}: apiKey must be a non-empty string`);
    }
    this.providerName = opts.providerName;
    this.errorLabel = opts.errorLabel;
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.pricingOverride = opts.pricingOverride || {};
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.apiBaseUrl = opts.apiBaseUrl ?? null;
    // Subclasses opt in by setting this to true. Callers gate structured-output
    // pathways on this capability flag.
    this.supportsTools = false;
  }

  /**
   * Build the HTTP request envelope for one call.
   * Adapters that set `supportsTools = true` should incorporate `tools` /
   * `toolChoice` into the body; adapters without tool-use support may ignore
   * them.
   * @param {{
   *   model: string,
   *   systemPrompt: string,
   *   userPrompt: string,
   *   maxTokens: number,
   *   tools?: any[],
   *   toolChoice?: any,
   *   responseFormat?: 'json',
   * }} _args
   * @returns {{ url: string, headers: Record<string, string>, body: object }}
   */
  // eslint-disable-next-line no-unused-vars
  _request(_args) {
    throw new Error(`${this.errorLabel}: _request not implemented`);
  }

  /**
   * Pull the assistant text out of the parsed JSON response.
   * @param {any} _data
   * @returns {string}
   */
  // eslint-disable-next-line no-unused-vars
  _extractText(_data) {
    throw new Error(`${this.errorLabel}: _extractText not implemented`);
  }

  /**
   * Pull token-usage counts out of the parsed JSON response. Adapters with
   * prompt-caching support also surface `cacheCreationInputTokens` and
   * `cacheReadInputTokens`; adapters without caching may omit those fields.
   * @param {any} _data
   * @returns {{
   *   inputTokens: number,
   *   outputTokens: number,
   *   cacheCreationInputTokens?: number,
   *   cacheReadInputTokens?: number,
   * }}
   */
  // eslint-disable-next-line no-unused-vars
  _extractUsage(_data) {
    throw new Error(`${this.errorLabel}: _extractUsage not implemented`);
  }

  /**
   * Map an HTTP response status to a typed error. Throws for any non-2xx
   * status; returns undefined for 2xx so the caller proceeds to read the body.
   * Shared by the non-streaming (`call`) and streaming (OpenAICompatibleProvider)
   * paths so status handling never diverges.
   * @param {Response} res
   * @param {{ model?: string }} [_ctx]  the call being made, for subclass hints
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async mapHttpError(res, _ctx) {
    if (res.status === 401 || res.status === 403) {
      // Include the (secret-redacted) response body — providers like ModelStack
      // return a useful reason here (invalid_api_key vs IP/tier forbidden) that
      // is otherwise lost, making auth failures hard to diagnose.
      const txt = await res.text().catch(() => '');
      // A 403 carrying a Cloudflare edge challenge is a transient mitigation,
      // not a credential failure. Reclassify as a retryable ProviderError so
      // withRetry can back off and try again instead of dying instantly with a
      // misleading AuthError. (401 is always auth — never reclassified.)
      if (res.status === 403 && isCloudflareChallenge({
        contentType: res.headers.get('content-type') || '',
        body: txt,
        cfMitigated: res.headers.get('cf-mitigated'),
      })) {
        throw new ProviderError(`${this.errorLabel} 403 (Cloudflare edge challenge — transient)`, {
          provider: this.providerName,
          status: 403,
          retryable: true,
        });
      }
      // Truncate before redacting — a Cloudflare interstitial can be 10KB+ of
      // HTML; redacting the whole body just to drop all but 300 chars wastes work.
      const detail = txt ? `: ${redactSecrets(txt.slice(0, 300))}` : '';
      throw new AuthError(`${this.errorLabel} ${res.status}${detail}`, { provider: this.providerName, status: res.status });
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      throw new RateLimitError(`${this.errorLabel} 429`, {
        provider: this.providerName,
        status: 429,
        retryAfterMs,
      });
    }
    if (res.status >= 500 && res.status < 600) {
      throw new ProviderError(`${this.errorLabel} ${res.status}`, { provider: this.providerName, status: res.status, retryable: true });
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new LLMError(`${this.errorLabel} ${res.status}: ${redactSecrets(txt).slice(0, 200)}`);
    }
  }

  /**
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {{ model?: string, maxTokens?: number, tools?: any[], toolChoice?: any, responseFormat?: 'json' }} [opts]
   * @returns {Promise<{
   *   text: string,
   *   usage: {
   *     inputTokens: number,
   *     outputTokens: number,
   *     cacheCreationInputTokens?: number,
   *     cacheReadInputTokens?: number,
   *   },
   *   cost: any,
   *   model: string,
   * }>}
   */
  async call(systemPrompt, userPrompt, opts = {}) {
    const model = opts.model || this.defaultModel;
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const { url, headers, body } = this._request({
      model, systemPrompt, userPrompt, maxTokens,
      tools: opts.tools, toolChoice: opts.toolChoice,
      responseFormat: opts.responseFormat,
    });

    const data = await withRetry(async () => {
      const timeoutMs = getFetchTimeoutMs();
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
        dispatcher: getFetchDispatcher(timeoutMs),
      });
      await this.mapHttpError(res);
      try {
        return await res.json();
      } catch (e) {
        throw new LLMError(`${this.errorLabel} malformed JSON: ${(e && e.message) || ''}`);
      }
    }, { maxAttempts: this.maxAttempts, label: this.providerName });

    const text = this._extractText(data);
    const usage = this._extractUsage(data);
    const cost = calculateCost(this.providerName, model, usage, this.pricingOverride);
    // Surface the model that actually answered so callers log/attribute cost
    // against it. Under model-failover the wrapper overrides opts.model per
    // attempt, so this can differ from the caller's configured default.
    return { text, usage, cost, model };
  }
}

module.exports = {
  BaseLLMProvider,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_FETCH_TIMEOUT_MS,
  getFetchTimeoutMs,
  getFetchDispatcher,
  isCloudflareChallenge,
};
