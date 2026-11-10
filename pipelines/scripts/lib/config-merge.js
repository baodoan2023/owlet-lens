// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { ConfigError } = require('./errors.js');
const { isSecretVarName, isAuthPath } = require('./endpoint-guard.js');

const DEFAULTS = Object.freeze({
  provider: 'auto',
  auth: { token: null, anthropicKey: null, geminiKey: null, deepseekKey: null, modelstackKey: null, openaiKey: null, openrouterKey: null, bitbucketToken: null, gitlabToken: null, azureToken: null },
  paths: {
    include: ['backend/**', 'frontend/**'],
    exclude: ['**/*.test.ts', '**/dist/**'],
  },
  review: {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiBaseUrl: null,
    maxFindings: 25,
    maxFileBytes: null,
    tokenBudget: 512000,
    latencyWarnMs: 300000,
    severityThreshold: 'medium',
    strict: false,
    testFileSeverityThreshold: 'high',
    noiseCategories: ['style', 'naming'],
    skipGeneratedFiles: true,
    // Skip a push whose review fingerprint matches the last full review (ADR-0015).
    skipUnchanged: true,
    exportWebhookUrl: null,
    reflection: true,
    detectBreakingChanges: false,
    auditLogPath: null,
    summary: { mode: 'sticky' },
    // Declared so the default is visible and so a PR's own copy is still
    // type-checked, but deliberately NOT read from here: the gate loads these two
    // keys off the PR's target branch, never the working folder (ADR-0014).
    // Read by `lib/port/tl-gate.js` only.
    tlGate: { enabled: false, leads: [] },
    codingStandardsPath: null,
    contextPaths: [],
    fallbackModels: [],
    learn: {
      lookbackDays: 45,
      minWontfix: 2,
      minDistinctAuthors: 1,
      maxPrs: 200,
      branchPrefix: 'owlet-lens/learn',
      ignorePath: null,
    },
  },
  reply: {
    provider: 'anthropic',
    evaluator: 'llm',
    model: 'claude-haiku-4-5-20251001',
    apiBaseUrl: null,
    fallbackModels: [],
  },
  markers: { prefix: 'ai-review' },
  pricing: {},
  // Routing for the openrouter LLM provider; shape and defaults live in
  // openrouter-config.js (ADR-0020).
  openrouter: { models: {} },
});

const KNOWN_KEYS = new Set([
  'provider',
  'auth',
  'paths',
  'review',
  'reply',
  'markers',
  'pricing',
  'openrouter',
  'gitlab',
  'azure',
]);

/**
 * Substitute `${VAR}` placeholders in a string against the env. Only matches
 * UPPER_SNAKE_CASE identifiers — matches POSIX env-var convention used by
 * Anthropic SDK / Octokit / Azure pipeline variables. Lowercase env vars
 * (uncommon for config-driving variables) are NOT interpolated.
 *
 * A variable whose name looks like a secret (GITHUB_TOKEN, *_API_KEY, ...) is read only under `auth.*`:
 * the file may come from a pull request, and anywhere else the value could be sent to a host the
 * workflow did not approve (ADR-0019).
 *
 * @param {unknown} value
 * @param {NodeJS.ProcessEnv} env
 * @param {{ unresolved?: string[]|null, keyPath?: string }} [opts]
 * @returns {unknown}
 */
function interpolate(value, env, opts) {
  if (typeof value !== 'string') return value;
  const unresolved = opts?.unresolved ?? null;
  const keyPath = opts?.keyPath ?? '';
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    if (isSecretVarName(name) && !isAuthPath(keyPath)) {
      throw new ConfigError(
        `config field '${keyPath}' may not read the secret variable ${name}: secret variables can be used only under auth.*`,
      );
    }
    const v = env[name];
    if (v == null || v === '') {
      if (unresolved) unresolved.push(name);
      return '';
    }
    return v;
  });
}

function deepInterpolate(obj, env, keyPath = '', unresolvedByPath = {}) {
  if (obj === null || typeof obj !== 'object') {
    const unresolved = [];
    const out = interpolate(obj, env, { unresolved, keyPath });
    if (unresolved.length > 0) unresolvedByPath[keyPath] = unresolved;
    return out;
  }
  if (Array.isArray(obj)) {
    return obj.map((v, i) => deepInterpolate(v, env, `${keyPath}[${i}]`, unresolvedByPath));
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = deepInterpolate(v, env, keyPath ? `${keyPath}.${k}` : k, unresolvedByPath);
  }
  return out;
}

/**
 * Recursive merge of an `over` config tree onto a `base` defaults tree.
 *
 * Null-coalescing contract:
 *   - `over === undefined`        → use base (field omitted)
 *   - `over === null`             → use base (explicit null = "default")
 *   - base object, over primitive → throw ConfigError (type mismatch)
 *   - base array,  over !array    → throw ConfigError (type mismatch)
 *   - base primitive/null/array, over defined → return over
 *   - both objects                → merge keys recursively
 */
function deepMerge(base, over, keyPath = '') {
  if (over === undefined) return base;
  // Explicit null in YAML (e.g. `securityContext: null`) means "use base default",
  // not "wipe the subtree to null". Otherwise a single null in user config would
  // erase nested defaults silently.
  if (over === null) return base;
  // Type-mismatch guard: refuse to overwrite an object/array base with a primitive
  // (e.g. `paths: false` in YAML). Keeps downstream code from crashing on
  // `config.paths.include` after a typo.
  const baseIsObj = base !== null && typeof base === 'object' && !Array.isArray(base);
  const overIsObj = typeof over === 'object' && !Array.isArray(over);
  if (baseIsObj && !overIsObj) {
    throw new ConfigError(
      `Config field '${keyPath || '<root>'}' must be an object; got ${Array.isArray(over) ? 'array' : typeof over}`,
    );
  }
  if (Array.isArray(base) && !Array.isArray(over)) {
    throw new ConfigError(
      `Config field '${keyPath || '<root>'}' must be an array; got ${typeof over}`,
    );
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = deepMerge(base[k], v, keyPath ? `${keyPath}.${k}` : k);
  }
  return out;
}

/**
 * Layer defaults -> file -> env -> CLI, recording `${VAR}`s that didn't resolve.
 *
 * @param {{
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   cliFlags: { provider?: string, configPath?: string },
 *   onWarn: (msg: string) => void,
 * }} opts
 * @returns {{ merged: any, unresolvedByPath: Record<string, string[]> }} unresolvedByPath: config path -> unresolved env var names
 */
function mergeConfig({ cwd, env, cliFlags, onWarn }) {
  // `--config=` (empty value) would silently fall through to the default
  // file via the .filter(Boolean) below — fail loudly so the misuse is
  // visible instead of masked.
  if (cliFlags.configPath !== undefined && cliFlags.configPath === '') {
    throw new ConfigError('--config requires a non-empty path');
  }

  // YAML only — `.js` config support was removed because `require(p)` on a
  // user-controlled path is an arbitrary code-execution surface.
  const candidates = [
    cliFlags.configPath,
    'ai-review.config.yaml',
    'ai-review.config.yml',
  ].filter(Boolean);

  let fileCfg = {};
  for (const c of candidates) {
    const p = path.isAbsolute(c) ? c : path.join(cwd, c);
    if (!fs.existsSync(p)) continue;
    if (!/\.ya?ml$/i.test(p)) {
      throw new ConfigError(
        `ai-review config must be YAML (.yaml/.yml); rejected: ${p}`,
      );
    }
    // js-yaml v4: load() defaults to DEFAULT_SCHEMA (safe — no `!!js/function`
    // or other code-execution tags). The unsafe v3-era safeLoad/load split is
    // gone in v4; load() IS the safe loader. Pass DEFAULT_SCHEMA explicitly
    // as defense-in-depth against an accidental v3 downgrade.
    try {
      fileCfg = yaml.load(fs.readFileSync(p, 'utf8'), { schema: yaml.DEFAULT_SCHEMA }) || {};
    } catch (e) {
      // Re-throw raw YAMLException as ConfigError with the file path so the
      // operator sees which file is malformed instead of a bare parse error.
      // Truncate the message to 500 chars — YAMLException can include the
      // full offending input verbatim, which floods stderr.
      const msg = (e?.message ?? String(e)).slice(0, 500);
      throw new ConfigError(`Failed to parse ${p}: ${msg}`);
    }
    break;
  }

  for (const k of Object.keys(fileCfg)) {
    if (!KNOWN_KEYS.has(k)) onWarn(`Unknown config field: ${k}`);
  }

  const unresolvedByPath = {};
  const interpolated = deepInterpolate(fileCfg, env, '', unresolvedByPath);

  let merged = deepMerge(DEFAULTS, interpolated);

  const envOverrides = {};
  if (env.AI_REVIEW_MODEL) {
    envOverrides.review = { ...(envOverrides.review ?? {}), model: env.AI_REVIEW_MODEL };
  }
  if (env.AI_REVIEW_SEVERITY_THRESHOLD) {
    envOverrides.review = { ...(envOverrides.review ?? {}), severityThreshold: env.AI_REVIEW_SEVERITY_THRESHOLD };
  }
  if (env.AI_REVIEW_STRICT !== undefined) {
    const v = String(env.AI_REVIEW_STRICT).toLowerCase();
    const truthy = v === 'true' || v === '1' || v === 'yes';
    envOverrides.review = { ...(envOverrides.review ?? {}), strict: truthy };
  }
  if (env.AI_REPLY_MODEL) {
    envOverrides.reply = { ...(envOverrides.reply ?? {}), model: env.AI_REPLY_MODEL };
  }
  if (env.AI_REVIEW_LLM_PROVIDER) {
    envOverrides.review = { ...(envOverrides.review ?? {}), provider: env.AI_REVIEW_LLM_PROVIDER };
  }
  if (env.AI_REPLY_LLM_PROVIDER) {
    envOverrides.reply = { ...(envOverrides.reply ?? {}), provider: env.AI_REPLY_LLM_PROVIDER };
  }
  if (Object.keys(envOverrides).length > 0) {
    merged = deepMerge(merged, envOverrides);
  }

  if (cliFlags.provider) merged = deepMerge(merged, { provider: cliFlags.provider });

  return { merged, unresolvedByPath };
}

module.exports = { DEFAULTS, deepMerge, mergeConfig };
