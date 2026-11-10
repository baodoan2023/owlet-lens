// @ts-check
'use strict';

const { ConfigError } = require('./errors.js');
const { buildModelChain } = require('./llm/model-ref.js');

/**
 * @typedef {{ enabled?: boolean, effort?: 'low' | 'medium' | 'high', maxTokens?: number }} OpenRouterReasoning
 * @typedef {{
 *   only?: string[], ignore?: string[], order?: string[], quantizations?: string[],
 *   allowFallbacks?: boolean, zdr?: boolean, dataCollection?: 'allow' | 'deny',
 *   sort?: 'price' | 'throughput' | 'latency',
 *   reasoning?: OpenRouterReasoning, maxOutputTokens?: number,
 * }} OpenRouterModelRouting
 * @typedef {{
 *   dataCollection: 'allow' | 'deny',
 *   zdr: boolean,
 *   models: Record<string, OpenRouterModelRouting>,
 * }} OpenRouterConfig
 */

// Code review sends proprietary diffs, so routing defaults to providers that
// do not store or train on prompts (ADR-0020).
const DEFAULT_DATA_COLLECTION = 'deny';
const DATA_COLLECTION = new Set(['allow', 'deny']);
const SORT = new Set(['price', 'throughput', 'latency']);
const EFFORT = new Set(['low', 'medium', 'high']);
const STRING_LIST_FIELDS = ['only', 'ignore', 'order', 'quantizations'];
const BOOLEAN_FIELDS = ['allowFallbacks', 'zdr'];
const MODEL_FIELDS = new Set([
  ...STRING_LIST_FIELDS, ...BOOLEAN_FIELDS, 'dataCollection', 'sort', 'reasoning', 'maxOutputTokens',
]);
const TOP_FIELDS = new Set(['dataCollection', 'zdr', 'models']);
const REASONING_FIELDS = new Set(['enabled', 'effort', 'maxTokens']);

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {Set<string>} allowed
 * @param {string} label
 */
function rejectUnknownKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new ConfigError(`${label}.${k} is not a supported key (expected one of: ${[...allowed].join(', ')})`);
    }
  }
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {number}
 */
function positiveInt(v, label) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ConfigError(`${label} must be a positive integer (got: ${JSON.stringify(v)})`);
  }
  return v;
}

/**
 * @param {unknown} v
 * @param {Set<string>} allowed
 * @param {string} label
 * @returns {string}
 */
function oneOf(v, allowed, label) {
  if (typeof v !== 'string' || !allowed.has(v)) {
    throw new ConfigError(`${label} must be one of ${[...allowed].join('|')} (got: ${JSON.stringify(v)})`);
  }
  return v;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {boolean}
 */
function bool(v, label) {
  if (typeof v !== 'boolean') {
    throw new ConfigError(`${label} must be a boolean (got: ${JSON.stringify(v)})`);
  }
  return v;
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {OpenRouterReasoning}
 */
function validateReasoning(raw, label) {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${label} must be an object with { enabled, effort, maxTokens }`);
  }
  const r = /** @type {Record<string, unknown>} */ (raw);
  rejectUnknownKeys(r, REASONING_FIELDS, label);
  /** @type {OpenRouterReasoning} */
  const out = {};
  if (r.enabled != null) out.enabled = bool(r.enabled, `${label}.enabled`);
  if (r.effort != null) out.effort = /** @type {'low'|'medium'|'high'} */ (oneOf(r.effort, EFFORT, `${label}.effort`));
  if (r.maxTokens != null) out.maxTokens = positiveInt(r.maxTokens, `${label}.maxTokens`);
  return out;
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {OpenRouterModelRouting}
 */
function validateModelEntry(raw, label) {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${label} must be an object of routing options`);
  }
  const e = /** @type {Record<string, unknown>} */ (raw);
  rejectUnknownKeys(e, MODEL_FIELDS, label);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const f of STRING_LIST_FIELDS) {
    if (e[f] == null) continue;
    const list = e[f];
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || s.trim() === '')) {
      throw new ConfigError(`${label}.${f} must be an array of non-empty strings (got: ${JSON.stringify(list)})`);
    }
    out[f] = list.map((s) => s.trim());
  }
  for (const f of BOOLEAN_FIELDS) {
    if (e[f] != null) out[f] = bool(e[f], `${label}.${f}`);
  }
  if (e.dataCollection != null) out.dataCollection = oneOf(e.dataCollection, DATA_COLLECTION, `${label}.dataCollection`);
  if (e.sort != null) out.sort = oneOf(e.sort, SORT, `${label}.sort`);
  if (e.reasoning != null) out.reasoning = validateReasoning(e.reasoning, `${label}.reasoning`);
  if (e.maxOutputTokens != null) out.maxOutputTokens = positiveInt(e.maxOutputTokens, `${label}.maxOutputTokens`);
  return /** @type {OpenRouterModelRouting} */ (out);
}

/**
 * Validate and normalize the top-level `openrouter:` block. Runs on every
 * config load, even when no path uses openrouter, so a bad shared config fails
 * early. Returns fresh objects; the input is never mutated.
 *
 * @param {unknown} raw
 * @returns {OpenRouterConfig}
 */
function validateOpenRouterConfig(raw) {
  if (raw == null) return { dataCollection: DEFAULT_DATA_COLLECTION, zdr: false, models: {} };
  if (!isPlainObject(raw)) {
    throw new ConfigError('openrouter must be an object with { dataCollection, zdr, models }');
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  rejectUnknownKeys(o, TOP_FIELDS, 'openrouter');
  const dataCollection = o.dataCollection == null
    ? DEFAULT_DATA_COLLECTION
    : /** @type {'allow'|'deny'} */ (oneOf(o.dataCollection, DATA_COLLECTION, 'openrouter.dataCollection'));
  const zdr = o.zdr == null ? false : bool(o.zdr, 'openrouter.zdr');
  if (o.models != null && !isPlainObject(o.models)) {
    throw new ConfigError('openrouter.models must be a map of model id -> routing options');
  }
  /** @type {Record<string, OpenRouterModelRouting>} */
  const models = {};
  for (const [id, entry] of Object.entries(/** @type {Record<string, unknown>} */ (o.models ?? {}))) {
    models[id] = validateModelEntry(entry, `openrouter.models[${JSON.stringify(id)}]`);
  }
  return { dataCollection, zdr, models };
}

/**
 * Warn about `openrouter.models` keys that match no configured model. Only
 * when openrouter is active for review or reply: otherwise the entries are
 * expected to be idle (shared configs). A typo'd model id would silently drop
 * a pin someone relies on for data residency.
 *
 * @param {{
 *   review: { provider: string, model: string, fallbackModels?: string[] },
 *   reply: { provider: string, model: string, fallbackModels?: string[] },
 *   openrouter?: { models?: Record<string, unknown> },
 * }} merged
 * @param {(msg: string) => void} onWarn
 */
function warnUnusedOpenRouterModels(merged, onWarn) {
  // openrouter is in use when it serves any model in either chain: the kind's
  // own provider, or a `openrouter:<model>` fallback entry (ADR-0021).
  const used = new Set();
  for (const k of /** @type {const} */ (['review', 'reply'])) {
    for (const ref of buildModelChain(merged[k].provider, merged[k].model, merged[k].fallbackModels)) {
      if (ref.providerName === 'openrouter') used.add(ref.model);
    }
  }
  if (used.size === 0) return;
  for (const id of Object.keys(merged.openrouter?.models ?? {})) {
    if (!used.has(id)) {
      onWarn(`openrouter.models[${JSON.stringify(id)}] matches no configured openrouter model; its routing is never applied`);
    }
  }
}

module.exports = { validateOpenRouterConfig, warnUnusedOpenRouterModels, DEFAULT_DATA_COLLECTION };
