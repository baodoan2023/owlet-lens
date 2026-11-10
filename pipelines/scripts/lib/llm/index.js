// @ts-check
'use strict';

const { ConfigError } = require('../errors.js');
const { redactSecrets } = require('../log-safe.js');
const { AnthropicProvider } = require('./anthropic.js');
const { GeminiProvider } = require('./gemini.js');
const { DeepSeekProvider } = require('./deepseek.js');
const { ModelStackProvider } = require('./modelstack.js');
const { OpenRouterProvider } = require('./openrouter.js');
const { OpenAICompatibleProvider } = require('./openai-base.js');
const { wrapModelFallback } = require('./model-fallback.js');
const { KNOWN_LLM_PROVIDERS, buildModelChain } = require('./model-ref.js');

function assertKnown(name, source) {
  if (!KNOWN_LLM_PROVIDERS.includes(name)) {
    const safe = String(name).slice(0, 50);
    throw new ConfigError(
      `Unknown LLM provider '${safe}' from ${source}. Expected one of: ${KNOWN_LLM_PROVIDERS.join(', ')}`,
    );
  }
  return name;
}

/**
 * Resolve LLM provider name. Precedence: env > config > default ('anthropic').
 *
 * @param {{ env: NodeJS.ProcessEnv, configValue?: string, kind: 'review' | 'reply' }} opts
 * @returns {'anthropic' | 'gemini' | 'deepseek' | 'modelstack' | 'openai' | 'openrouter'}
 */
function detectLLMProvider({ env, configValue, kind }) {
  const envKey = kind === 'review' ? 'AI_REVIEW_LLM_PROVIDER' : 'AI_REPLY_LLM_PROVIDER';
  const rawEnv = env[envKey];
  const fromEnv = typeof rawEnv === 'string' ? rawEnv.trim() : '';
  if (fromEnv) return assertKnown(fromEnv, envKey);
  const fromConfig = typeof configValue === 'string' ? configValue.trim() : '';
  if (fromConfig) return assertKnown(fromConfig, `config.${kind}.provider`);
  return 'anthropic';
}

const KEY_FIELD = Object.freeze({ anthropic: 'anthropicKey', gemini: 'geminiKey', deepseek: 'deepseekKey', modelstack: 'modelstackKey', openai: 'openaiKey', openrouter: 'openrouterKey' });

/**
 * The API key for `name`, or a ConfigError naming the missing auth field.
 * @param {string} name
 * @param {Record<string, string|null|undefined>|undefined} auth
 * @param {boolean} isPrimary  the kind's own provider (the only one `apiBaseUrl` reaches)
 * @returns {string}
 */
function requireKey(name, auth, isPrimary) {
  const field = KEY_FIELD[name];
  const apiKey = auth?.[field];
  // openai allows empty string key for local models (Ollama, LM Studio). Only
  // as the kind's own provider: a fallback cannot reach a local apiBaseUrl.
  if (name === 'openai' && isPrimary) {
    if (typeof apiKey !== 'string') {
      throw new ConfigError(`config.auth.openaiKey must be a string for provider 'openai'`);
    }
    return apiKey;
  }
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new ConfigError(`config.auth.${field} must be a non-empty string for provider '${name}'`);
  }
  return apiKey;
}

/**
 * One adapter for one LLM provider.
 *
 * @param {string} name
 * @param {{ apiKey: string, defaultModel: string, pricingOverride: object, maxAttempts?: number, apiBaseUrl?: string }} ctorOpts
 * @param {any} config
 */
function buildAdapter(name, ctorOpts, config) {
  if (name === 'anthropic') return new AnthropicProvider(ctorOpts);
  if (name === 'gemini') return new GeminiProvider(ctorOpts);
  if (name === 'deepseek') return new DeepSeekProvider(ctorOpts);
  if (name === 'modelstack') return new ModelStackProvider(ctorOpts);
  if (name === 'openrouter') return new OpenRouterProvider({ ...ctorOpts, routing: config.openrouter });
  if (name === 'openai') {
    const normalizeUrl = (/** @type {unknown} */ base) => {
      if (typeof base !== 'string') throw new ConfigError('openai: apiBaseUrl must be a string');
      const b = base.replace(/\/+$/, '');
      return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
    };
    return new OpenAICompatibleProvider({
      ...ctorOpts,
      providerName: 'openai',
      errorLabel: 'OpenAI',
      apiUrl: ctorOpts.apiBaseUrl ? normalizeUrl(ctorOpts.apiBaseUrl) : 'https://api.openai.com/v1/chat/completions',
      maxOutputTokens: 32_768,
    });
  }
  throw new ConfigError(`Unknown LLM provider: ${name}`);
}

/**
 * Build an LLMProvider instance for the requested provider name + path.
 *
 * With `fallbackModels`, returns a model chain (`wrapModelFallback`) over one
 * adapter per provider in the chain. A `<provider>:<model>` entry runs on that
 * provider with its own key (ADR-0021); `apiBaseUrl` applies to the kind's own
 * provider only.
 *
 * @param {'anthropic' | 'gemini' | 'deepseek' | 'modelstack' | 'openai' | 'openrouter'} name
 * @param {{
 *   config: {
 *     auth: { anthropicKey?: string|null, geminiKey?: string|null, deepseekKey?: string|null, modelstackKey?: string|null, openaiKey?: string|null, openrouterKey?: string|null },
 *     review: { model: string, fallbackModels?: string[], apiBaseUrl?: string|null },
 *     reply: { model: string, fallbackModels?: string[], apiBaseUrl?: string|null },
 *     pricing: Record<string, { inputPerMTok: number, outputPerMTok: number, cacheReadPerMTok?: number }>,
 *     openrouter?: import('../openrouter-config.js').OpenRouterConfig,
 *   },
 *   kind: 'review' | 'reply',
 * }} opts
 * @returns {{ call: Function, supportsTools?: boolean, chain?: ReadonlyArray<import('./model-fallback.js').ChainTarget> }}
 */
function makeLLMProvider(name, { config, kind }) {
  assertKnown(name, 'makeLLMProvider');
  const defaultModel = config[kind]?.model;
  if (typeof defaultModel !== 'string' || defaultModel.trim() === '') {
    throw new ConfigError(
      `config.${kind}.model must be a non-empty string (got: ${JSON.stringify(defaultModel)})`,
    );
  }
  const refs = buildModelChain(name, defaultModel, config[kind]?.fallbackModels);
  const wrap = refs.length > 1;
  const pricingOverride = config.pricing || {};
  const rawBase = config[kind]?.apiBaseUrl;
  const apiBaseUrl = typeof rawBase === 'string' && rawBase.trim() ? rawBase.trim() : undefined;
  if (apiBaseUrl) {
    process.stderr.write(JSON.stringify({ level: 'info', msg: `${kind}.apiBaseUrl override active`, provider: name, apiBaseUrl: redactSecrets(apiBaseUrl) }) + '\n');
  }

  // One adapter per provider, keyed by name. Fail fast on a missing key for
  // any provider in the chain, not at failover time mid-review.
  /** @type {Map<string, any>} */
  const adapters = new Map();
  for (const ref of refs) {
    if (adapters.has(ref.providerName)) continue;
    /** @type {{ apiKey: string, defaultModel: string, pricingOverride: object, maxAttempts?: number, apiBaseUrl?: string }} */
    const ctorOpts = { apiKey: requireKey(ref.providerName, config.auth, ref.providerName === name), defaultModel: ref.model, pricingOverride };
    if (ref.providerName === name && apiBaseUrl) ctorOpts.apiBaseUrl = apiBaseUrl;
    // One try per model when wrapping; the chain owns the cross-model loop.
    if (wrap) ctorOpts.maxAttempts = 1;
    adapters.set(ref.providerName, buildAdapter(ref.providerName, ctorOpts, config));
  }

  if (!wrap) return adapters.get(name);
  return wrapModelFallback(refs.map((r) => ({ ...r, provider: adapters.get(r.providerName) })));
}

module.exports = { detectLLMProvider, makeLLMProvider, KNOWN_LLM_PROVIDERS };
