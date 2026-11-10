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

const KNOWN_LLM_PROVIDERS = Object.freeze(['anthropic', 'gemini', 'deepseek', 'modelstack', 'openai', 'openrouter']);

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

/**
 * Build an LLMProvider instance for the requested provider name + path.
 *
 * @param {'anthropic' | 'gemini' | 'deepseek' | 'modelstack' | 'openai' | 'openrouter'} name
 * @param {{
 *   config: {
 *     auth: { anthropicKey?: string|null, geminiKey?: string|null, deepseekKey?: string|null, modelstackKey?: string|null, openaiKey?: string|null, openrouterKey?: string|null },
 *     review: { model: string, fallbackModels?: string[] },
 *     reply: { model: string, fallbackModels?: string[] },
 *     pricing: Record<string, { inputPerMTok: number, outputPerMTok: number, cacheReadPerMTok?: number }>,
 *     openrouter?: import('../openrouter-config.js').OpenRouterConfig,
 *   },
 *   kind: 'review' | 'reply',
 * }} opts
 * @returns {{ call: Function }}
 */
function makeLLMProvider(name, { config, kind }) {
  assertKnown(name, 'makeLLMProvider');
  const defaultModel = config[kind]?.model;
  if (typeof defaultModel !== 'string' || defaultModel.trim() === '') {
    throw new ConfigError(
      `config.${kind}.model must be a non-empty string (got: ${JSON.stringify(defaultModel)})`,
    );
  }
  const KEY_FIELD = { anthropic: 'anthropicKey', gemini: 'geminiKey', deepseek: 'deepseekKey', modelstack: 'modelstackKey', openai: 'openaiKey', openrouter: 'openrouterKey' };
  const apiKey = config.auth?.[KEY_FIELD[name]];
  // openai allows empty string key for local models (Ollama, LM Studio)
  if (name === 'openai') {
    if (typeof apiKey !== 'string') {
      throw new ConfigError(`config.auth.openaiKey must be a string for provider 'openai'`);
    }
  } else if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new ConfigError(
      `config.auth.${KEY_FIELD[name]} must be a non-empty string for provider '${name}'`,
    );
  }
  const pricingOverride = config.pricing || {};

  // Build the model-failover list: primary first, then configured fallbacks,
  // order-preserving and deduped so a repeated id is never retried twice.
  const fallbackModels = Array.isArray(config[kind]?.fallbackModels) ? config[kind].fallbackModels : [];
  const models = [];
  const seen = new Set();
  for (const m of [defaultModel, ...fallbackModels]) {
    if (!seen.has(m)) { seen.add(m); models.push(m); }
  }
  const wrap = models.length > 1;

  // One try per model when wrapping; the decorator owns the cross-model loop.
  const apiBaseUrl = typeof config[kind]?.apiBaseUrl === 'string' && config[kind].apiBaseUrl.trim()
    ? config[kind].apiBaseUrl.trim()
    : undefined;
  /** @type {{ apiKey: string, defaultModel: string, pricingOverride: object, maxAttempts?: number, apiBaseUrl?: string }} */
  const ctorOpts = { apiKey, defaultModel, pricingOverride };
  if (apiBaseUrl) {
    ctorOpts.apiBaseUrl = apiBaseUrl;
    process.stderr.write(JSON.stringify({ level: 'info', msg: `${kind}.apiBaseUrl override active`, provider: name, apiBaseUrl: redactSecrets(apiBaseUrl) }) + '\n');
  }
  if (wrap) ctorOpts.maxAttempts = 1;

  let provider;
  if (name === 'anthropic') {
    provider = new AnthropicProvider(ctorOpts);
  } else if (name === 'gemini') {
    provider = new GeminiProvider(ctorOpts);
  } else if (name === 'deepseek') {
    provider = new DeepSeekProvider(ctorOpts);
  } else if (name === 'modelstack') {
    provider = new ModelStackProvider(ctorOpts);
  } else if (name === 'openrouter') {
    provider = new OpenRouterProvider({ ...ctorOpts, routing: config.openrouter });
  } else if (name === 'openai') {
    const normalizeUrl = (base) => {
      if (typeof base !== 'string') throw new ConfigError('openai: apiBaseUrl must be a string');
      const b = base.replace(/\/+$/, '');
      return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
    };
    provider = new OpenAICompatibleProvider({
      ...ctorOpts,
      providerName: 'openai',
      errorLabel: 'OpenAI',
      apiUrl: apiBaseUrl ? normalizeUrl(apiBaseUrl) : 'https://api.openai.com/v1/chat/completions',
      maxOutputTokens: 32_768,
    });
  } else {
    throw new ConfigError(`Unknown LLM provider: ${name}`);
  }

  return wrap ? wrapModelFallback(provider, models) : provider;
}

module.exports = { detectLLMProvider, makeLLMProvider, KNOWN_LLM_PROVIDERS };
