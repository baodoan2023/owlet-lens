// @ts-check
'use strict';

// Model references for `fallbackModels` (ADR-0021). An entry is either a bare
// model id, served by the kind's own provider, or `<provider>:<model>`, served
// by another LLM provider with that provider's key. A colon only names a
// provider when the text before the first colon is a known provider name, so
// ids that carry their own colon (OpenRouter `:free` variants, Ollama tags)
// stay bare ids.

const { ConfigError } = require('../errors.js');

const KNOWN_LLM_PROVIDERS = Object.freeze(['anthropic', 'gemini', 'deepseek', 'modelstack', 'openai', 'openrouter']);

/**
 * @typedef {'anthropic' | 'gemini' | 'deepseek' | 'modelstack' | 'openai' | 'openrouter'} LLMProviderName
 * @typedef {{ providerName: string, model: string }} ModelRef
 */

/**
 * @param {string} entry
 * @param {string} defaultProvider  the kind's own provider, for bare ids
 * @returns {ModelRef}
 */
function parseModelRef(entry, defaultProvider) {
  const raw = String(entry).trim();
  if (raw === '') throw new ConfigError('model id must be a non-empty string');
  const idx = raw.indexOf(':');
  const prefix = idx > 0 ? raw.slice(0, idx).trim() : '';
  if (!KNOWN_LLM_PROVIDERS.includes(prefix)) return { providerName: defaultProvider, model: raw };
  const model = raw.slice(idx + 1).trim();
  if (model === '') {
    throw new ConfigError(`model id missing after provider prefix in ${JSON.stringify(raw.slice(0, 80))}`);
  }
  return { providerName: prefix, model };
}

/**
 * `[primary, ...fallbacks]` as model refs, order-preserving and deduped by
 * provider + model so the same model is never tried twice.
 *
 * @param {string} primaryProvider
 * @param {string} primaryModel
 * @param {unknown} fallbackModels
 * @returns {ModelRef[]}
 */
function buildModelChain(primaryProvider, primaryModel, fallbackModels) {
  const entries = Array.isArray(fallbackModels) ? fallbackModels : [];
  const refs = [{ providerName: primaryProvider, model: primaryModel }, ...entries.map((m) => parseModelRef(m, primaryProvider))];
  const seen = new Set();
  return refs.filter((r) => {
    const key = `${r.providerName}\u0000${r.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { KNOWN_LLM_PROVIDERS, parseModelRef, buildModelChain };
