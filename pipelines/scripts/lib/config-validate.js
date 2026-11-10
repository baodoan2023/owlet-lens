// @ts-check
'use strict';

const { Minimatch } = require('minimatch');
const { ConfigError } = require('./errors.js');
const { deepMerge } = require('./config-merge.js');
const { assertHostAllowed, BUILTIN_LLM_HOSTS } = require('./endpoint-guard.js');
const { validateOpenRouterConfig, warnUnusedOpenRouterModels } = require('./openrouter-config.js');
const { parseModelRef } = require('./llm/model-ref.js');

/**
 * Providers other than the kind's own named by `<provider>:<model>` entries in
 * `fallbackModels` (ADR-0021). Non-string entries are skipped here and
 * rejected by the per-entry check further down.
 *
 * @param {any} kindCfg  merged.review or merged.reply
 * @returns {Set<string>}
 */
function fallbackProviders(kindCfg) {
  const out = new Set();
  for (const m of Array.isArray(kindCfg.fallbackModels) ? kindCfg.fallbackModels : []) {
    if (typeof m !== 'string') continue;
    const { providerName } = parseModelRef(m, kindCfg.provider);
    if (providerName !== kindCfg.provider) out.add(providerName);
  }
  return out;
}

/**
 * Validate and normalize a merged config, then resolve credentials from config or env.
 *
 * @param {{
 *   merged: any,
 *   env: NodeJS.ProcessEnv,
 *   unresolvedByPath: Record<string, string[]>,
 *   onWarn: (msg: string) => void,
 * }} opts
 */
function validateConfig({ merged, env, unresolvedByPath, onWarn }) {
  if (merged.markers && typeof merged.markers.prefix === 'string') {
    if (!/^[a-z][a-z0-9_-]*$/i.test(merged.markers.prefix)) {
      throw new ConfigError(
        `markers.prefix must match /^[a-z][a-z0-9_-]*$/i (got: ${JSON.stringify(merged.markers.prefix)})`,
      );
    }
  }

  // Validate provider names FIRST so unknown values fail with a clear
  // ConfigError before any auth-field gating runs. Otherwise an invalid
  // provider would silently miss its key entry and downgrade a missing
  // credential to a warning.
  const PROVIDER_AUTH_FIELD = {
    anthropic:  'auth.anthropicKey',
    gemini:     'auth.geminiKey',
    deepseek:   'auth.deepseekKey',
    modelstack: 'auth.modelstackKey',
    openai:     'auth.openaiKey',
    openrouter: 'auth.openrouterKey',
  };
  const EXPECTED_PROVIDERS = Object.keys(PROVIDER_AUTH_FIELD).join('|');
  for (const kind of ['review', 'reply']) {
    const p = merged[kind].provider;
    if (!PROVIDER_AUTH_FIELD[p]) {
      throw new ConfigError(
        `Unknown ${kind}.provider: ${JSON.stringify(p)} (expected: ${EXPECTED_PROVIDERS})`,
      );
    }
  }

  // Build the set of REQUIRED auth fields from the resolved active providers
  // (after env override). Unresolved env vars in INACTIVE providers' auth
  // fields downgrade to a warning instead of throwing.
  //
  // `auth.token` is the GitHub review-provider credential. Only require it when
  // the effective review provider is GitHub — Bitbucket carries its own token
  // (`auth.bitbucketToken` / BITBUCKET_TOKEN), enforced in its constructor, so
  // a github-shaped config (`token: ${GITHUB_TOKEN}`) must not block a Bitbucket
  // run when GITHUB_TOKEN is absent. `merged.provider` may be 'auto', so resolve
  // it the same way detectProvider does (env CI signals) before gating —
  // otherwise auto-detected Bitbucket runs would wrongly require GITHUB_TOKEN.
  let effectiveProvider = merged.provider;
  if (effectiveProvider === 'auto') {
    if (env.GITHUB_ACTIONS === 'true') effectiveProvider = 'github';
    else if (env.BITBUCKET_PIPELINE_UUID || env.BITBUCKET_BUILD_NUMBER) effectiveProvider = 'bitbucket';
    else if (env.GITLAB_CI === 'true') effectiveProvider = 'gitlab';
    else if (env.TF_BUILD === 'True') effectiveProvider = 'azure-devops';
    // else: undetermined — don't require a VCS token here; detectProvider will
    // raise a clear "cannot detect provider" error at runtime if it stays auto.
  }
  const requiredAuthFields = new Set();
  if (effectiveProvider === 'github') requiredAuthFields.add('auth.token');
  for (const kind of ['review', 'reply']) {
    requiredAuthFields.add(PROVIDER_AUTH_FIELD[merged[kind].provider]);
    for (const p of fallbackProviders(merged[kind])) requiredAuthFields.add(PROVIDER_AUTH_FIELD[p]);
  }
  for (const [cfgPath, vars] of Object.entries(unresolvedByPath)) {
    const msg = `Unresolved env var(s) ${vars.join(', ')} in config field '${cfgPath}'`;
    if (requiredAuthFields.has(cfgPath)) {
      throw new ConfigError(`${msg} — refusing to start with empty credentials`);
    }
    onWarn(msg);
  }

  // Validate pricing override: each entry must be an object with finite
  // non-negative numeric inputPerMTok and outputPerMTok, and the same for
  // cacheReadPerMTok when set (null, an empty YAML key, means unset). Catches
  // typos and stray strings before NaN reaches calculateCost.
  for (const [model, p] of Object.entries(merged.pricing || {})) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new ConfigError(`pricing.${model} must be an object with inputPerMTok and outputPerMTok`);
    }
    const fields = ['inputPerMTok', 'outputPerMTok'];
    if (p.cacheReadPerMTok !== undefined && p.cacheReadPerMTok !== null) fields.push('cacheReadPerMTok');
    for (const f of fields) {
      const n = Number(p[f]);
      if (!Number.isFinite(n) || n < 0) {
        throw new ConfigError(
          `pricing.${model}.${f} must be a finite number >= 0 (got: ${JSON.stringify(p[f])})`,
        );
      }
    }
  }

  // Resolve keys per provider. Each falls back to its env var. Active providers
  // (review.provider, reply.provider) MUST have a resolved key. Inactive
  // providers' keys may stay null without erroring.
  const anthropicKey   = merged.auth.anthropicKey   ?? env.ANTHROPIC_API_KEY   ?? null;
  const geminiKey      = merged.auth.geminiKey      ?? env.GEMINI_API_KEY      ?? null;
  const deepseekKey    = merged.auth.deepseekKey    ?? env.DEEPSEEK_API_KEY    ?? null;
  const modelstackKey  = merged.auth.modelstackKey  ?? env.MODELSTACK_API_KEY  ?? null;
  const openaiKey      = merged.auth.openaiKey      ?? env.OPENAI_API_KEY      ?? null;
  const openrouterKey  = merged.auth.openrouterKey  ?? env.OPENROUTER_API_KEY  ?? null;
  // Review-provider credentials and CI env are resolved by each provider's
  // constructor, not here (ADR-0012).

  const KEY_BY_PROVIDER = {
    anthropic:  { key: anthropicKey,  envName: 'ANTHROPIC_API_KEY',  authField: 'auth.anthropicKey' },
    gemini:     { key: geminiKey,     envName: 'GEMINI_API_KEY',     authField: 'auth.geminiKey' },
    deepseek:   { key: deepseekKey,   envName: 'DEEPSEEK_API_KEY',   authField: 'auth.deepseekKey' },
    modelstack: { key: modelstackKey, envName: 'MODELSTACK_API_KEY', authField: 'auth.modelstackKey' },
    openai:     { key: openaiKey,     envName: 'OPENAI_API_KEY',     authField: 'auth.openaiKey' },
    openrouter: { key: openrouterKey, envName: 'OPENROUTER_API_KEY', authField: 'auth.openrouterKey' },
  };

  for (const kind of ['review', 'reply']) {
    const providerName = merged[kind].provider;
    const entry = KEY_BY_PROVIDER[providerName];
    if (!entry) {
      throw new ConfigError(
        `Unknown ${kind}.provider: ${providerName} (expected: ${EXPECTED_PROVIDERS})`,
      );
    }
    // openai allows empty string key for local models (Ollama, LM Studio)
    if (!entry.key && !(providerName === 'openai' && typeof entry.key === 'string')) {
      throw new ConfigError(
        `${entry.envName} is required (${kind}.provider=${providerName}); set env or ${entry.authField} in config`,
      );
    }
    // A cross-provider fallback needs its own key too: fail at load, not at
    // failover time halfway through a review (ADR-0021).
    // No empty-key exemption for openai here: `apiBaseUrl` applies to the
    // kind's own provider only, so an openai fallback on another kind provider
    // targets api.openai.com, which rejects an empty key. (`openai:` under
    // provider: openai is the kind's own provider and never reaches this loop.)
    for (const p of fallbackProviders(merged[kind])) {
      const fb = KEY_BY_PROVIDER[p];
      if (typeof fb.key !== 'string' || fb.key.trim() === '') {
        const entry = String(merged[kind].fallbackModels.find((m) => typeof m === 'string' && parseModelRef(m, merged[kind].provider).providerName === p)).trim();
        throw new ConfigError(
          `${fb.envName} is required (${kind}.fallbackModels entry ${JSON.stringify(entry)} names provider ${p}); set env or ${fb.authField} in config. `
          + `If this id belongs to ${kind}.provider (a gateway id), write it as ${JSON.stringify(`${merged[kind].provider}:${entry}`)}`,
        );
      }
    }
  }

  // Shape-checked on every run, even when openrouter is inactive (ADR-0020).
  merged.openrouter = validateOpenRouterConfig(merged.openrouter);
  warnUnusedOpenRouterModels(merged, onWarn);

  const validThresholds = new Set(['low', 'medium', 'high', 'critical']);
  const normalizedThreshold = String(merged.review.severityThreshold ?? '').trim().toLowerCase();
  if (!validThresholds.has(normalizedThreshold)) {
    throw new ConfigError(
      `invalid review.severityThreshold: ${merged.review.severityThreshold} (expected: low|medium|high|critical)`,
    );
  }
  merged.review.severityThreshold = normalizedThreshold;
  if (typeof merged.review.strict !== 'boolean') {
    merged.review.strict = false;
  }

  const normalizedTestThreshold = String(merged.review.testFileSeverityThreshold ?? '').trim().toLowerCase();
  if (!validThresholds.has(normalizedTestThreshold)) {
    throw new ConfigError(
      `invalid review.testFileSeverityThreshold: ${merged.review.testFileSeverityThreshold} (expected: low|medium|high|critical)`,
    );
  }
  merged.review.testFileSeverityThreshold = normalizedTestThreshold;

  // noiseCategories: deepMerge already rejects a non-array override (base
  // default is an array), so only the per-entry string check is reachable —
  // same reasoning as contextPaths/fallbackModels above. Each entry is
  // normalized (trim + lowercase, same as testFileSeverityThreshold above)
  // and validated against the real finding-category enum — otherwise a typo'd
  // or mis-cased entry (e.g. `[Style]` or `[styl]`) would silently never match
  // any real finding, with no warning. The `.map(...)` below already produces
  // a fresh array, so no separate clone-before-keep spread is needed (unlike
  // the shared, unfrozen module-level DEFAULTS array otherwise leaking across
  // loadConfig calls — obs #484 pattern).
  const validNoiseCategories = new Set(['security', 'bug', 'performance', 'naming', 'architecture', 'style']);
  merged.review.noiseCategories = merged.review.noiseCategories.map((c) => {
    if (typeof c !== 'string') {
      throw new ConfigError(
        `review.noiseCategories entries must be strings (got: ${JSON.stringify(c)})`,
      );
    }
    const normalized = c.trim().toLowerCase();
    if (!validNoiseCategories.has(normalized)) {
      throw new ConfigError(
        `invalid review.noiseCategories entry: ${JSON.stringify(c)} (expected one of: security|bug|performance|naming|architecture|style)`,
      );
    }
    return normalized;
  });

  if (typeof merged.review.skipGeneratedFiles !== 'boolean') {
    throw new ConfigError(
      `review.skipGeneratedFiles must be a boolean (got: ${JSON.stringify(merged.review.skipGeneratedFiles)})`,
    );
  }

  if (typeof merged.review.skipUnchanged !== 'boolean') {
    throw new ConfigError(
      `review.skipUnchanged must be a boolean (got: ${JSON.stringify(merged.review.skipUnchanged)})`,
    );
  }

  const validSummaryModes = new Set(['sticky', 'append']);
  const summaryMode = String(merged.review.summary?.mode ?? 'sticky').trim().toLowerCase();
  if (!validSummaryModes.has(summaryMode)) {
    throw new ConfigError(
      `invalid review.summary.mode: ${merged.review.summary?.mode} (expected: sticky|append)`,
    );
  }
  merged.review.summary = { mode: summaryMode };

  // `review.tlGate` is shape-checked here but never *acted* on from this config:
  // the gate reads its own copy off the PR's target branch, and that read is
  // where an enabled-but-empty list becomes a ConfigError (exit 2). Checking the
  // shape here still turns a typo in a PR's copy into an error instead of a
  // silently ignored block, and the clone stops the shared DEFAULTS array from
  // being edited in place (the obs #484 pattern, same as fallbackModels).
  const tlGate = merged.review.tlGate;
  if (tlGate == null || typeof tlGate !== 'object' || Array.isArray(tlGate)) {
    throw new ConfigError(
      `review.tlGate must be an object with { enabled, leads } (got: ${Array.isArray(tlGate) ? 'array' : typeof tlGate})`,
    );
  }
  if (tlGate.enabled != null && typeof tlGate.enabled !== 'boolean') {
    throw new ConfigError(
      `review.tlGate.enabled must be a boolean (got: ${JSON.stringify(tlGate.enabled)})`,
    );
  }
  // `leads` needs no array check: deepMerge already rejects a non-array against
  // the array default above. Its entries are validated by the gate on the
  // authoritative (target-branch) copy, which is the one that decides.
  merged.review.tlGate = { enabled: tlGate.enabled === true, leads: [...(tlGate.leads ?? [])] };

  // paths.exclude: deepMerge already rejects a non-array (base default is []).
  for (const p of merged.paths.exclude) {
    if (typeof p !== 'string') {
      throw new ConfigError(
        `paths.exclude entries must be strings (got: ${JSON.stringify(p)})`,
      );
    }
  }

  // deepMerge already throws when YAML supplies a non-array for review.contextPaths
  // (base default is []), so the outer Array.isArray guard would be unreachable.
  // Only the per-entry string check is reachable (e.g. `contextPaths: [./a.md, 42]`).
  for (const p of merged.review.contextPaths) {
    if (typeof p !== 'string') {
      throw new ConfigError(
        `review.contextPaths entries must be strings (got: ${JSON.stringify(p)})`,
      );
    }
  }

  // fallbackModels: deepMerge already rejects a non-array (base default is []),
  // so only the per-entry string check is reachable (e.g. [ok, 42]).
  // Clone before keeping: when YAML omits the key, deepMerge shallow-copies and
  // merged[kind].fallbackModels is the shared, unfrozen module-level DEFAULTS
  // array. A fresh copy stops any later in-place edit from leaking across
  // loadConfig calls (mirrors the learn-block clone below; see obs #484).
  for (const kind of ['review', 'reply']) {
    for (const m of merged[kind].fallbackModels) {
      if (typeof m !== 'string') {
        throw new ConfigError(
          `${kind}.fallbackModels entries must be strings (got: ${JSON.stringify(m)})`,
        );
      }
    }
    merged[kind] = { ...merged[kind], fallbackModels: [...merged[kind].fallbackModels] };
  }

  for (const kind of ['review', 'reply']) {
    const url = merged[kind]?.apiBaseUrl;
    if (url != null) {
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        throw new ConfigError(`${kind}.apiBaseUrl must be an https:// URL or null (got: ${JSON.stringify(url)})`);
      }
      try {
        const parsed = new URL(url);
        if (!parsed.hostname) throw new Error('empty hostname');
      } catch {
        throw new ConfigError(`${kind}.apiBaseUrl is not a valid URL (got: ${JSON.stringify(url)})`);
      }
      assertHostAllowed({ field: `${kind}.apiBaseUrl`, url, env, builtin: BUILTIN_LLM_HOSTS });
    }
  }

  if (merged.review.detectBreakingChanges != null && typeof merged.review.detectBreakingChanges !== 'boolean') {
    throw new ConfigError(`review.detectBreakingChanges must be a boolean (got: ${JSON.stringify(merged.review.detectBreakingChanges)})`);
  }

  if (merged.review.reflection === null || merged.review.reflection === undefined) {
    merged.review.reflection = true;
  } else if (typeof merged.review.reflection !== 'boolean') {
    throw new ConfigError(`review.reflection must be a boolean (got: ${JSON.stringify(merged.review.reflection)})`);
  }

  if (merged.review.auditLogPath != null && typeof merged.review.auditLogPath !== 'string') {
    throw new ConfigError(`review.auditLogPath must be a string or null (got: ${JSON.stringify(merged.review.auditLogPath)})`);
  }
  if (typeof merged.review.auditLogPath === 'string' && merged.review.auditLogPath.trim() === '') {
    merged.review.auditLogPath = null;
  }

  const parsePositiveIntOrNull = (value, label) => {
    if (value == null) return null;
    if (typeof value === 'boolean') {
      throw new ConfigError(`${label} must be a positive integer or null (got: ${JSON.stringify(value)})`);
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ConfigError(`${label} must be a positive integer or null (got: ${JSON.stringify(value)})`);
    }
    return n;
  };
  merged.review.maxFileBytes = parsePositiveIntOrNull(merged.review.maxFileBytes, 'review.maxFileBytes');
  merged.review.maxFindings = parsePositiveIntOrNull(merged.review.maxFindings, 'review.maxFindings');

  // Prompt token budget for the main review call and its overflow chunks.
  // Always a positive integer so the budget stays the hard constraint
  // (ADR-0011). Coalesce null explicitly and require a real number rather than
  // relying on deepMerge's null handling or Number() coercion — coercion would
  // also admit `[512000]` and `"512000"`. Matches the strict latencyWarnMs
  // check below.
  if (merged.review.tokenBudget == null) merged.review.tokenBudget = 512000;
  if (
    typeof merged.review.tokenBudget !== 'number'
    || !Number.isInteger(merged.review.tokenBudget)
    || merged.review.tokenBudget <= 0
  ) {
    throw new ConfigError(
      `review.tokenBudget must be a positive integer (got: ${JSON.stringify(merged.review.tokenBudget)})`,
    );
  }

  if (merged.review.latencyWarnMs != null) {
    if (typeof merged.review.latencyWarnMs !== 'number' || !Number.isInteger(merged.review.latencyWarnMs) || merged.review.latencyWarnMs <= 0) {
      throw new ConfigError(`review.latencyWarnMs must be a positive integer or null (got: ${JSON.stringify(merged.review.latencyWarnMs)})`);

    }
  }

  if (merged.review.exportWebhookUrl != null) {
    const rawUrl = merged.review.exportWebhookUrl;
    if (typeof rawUrl === 'string' && rawUrl.trim() === '') {
      merged.review.exportWebhookUrl = null;
    } else {
      if (typeof rawUrl !== 'string' || !rawUrl.trim().startsWith('https://')) {
        throw new ConfigError(
          'review.exportWebhookUrl must be an https:// URL or null',
        );
      }
      try {
        const parsed = new URL(rawUrl.trim());
        if (!parsed.hostname) throw new Error('empty hostname');
      } catch {
        throw new ConfigError(
          'review.exportWebhookUrl is not a valid URL',
        );
      }
      assertHostAllowed({ field: 'review.exportWebhookUrl', url: rawUrl.trim(), env });
    }
  }

  // Clone before coercing: deepMerge shallow-copies, so when YAML omits the
  // learn block `merged.review.learn` is the shared module-level
  // DEFAULTS.review.learn reference. Mutating it in place (learn[f] = n) would
  // leak coerced overrides into every later loadConfig call in the process.
  const learn = { ...merged.review.learn };
  for (const f of ['lookbackDays', 'minWontfix', 'minDistinctAuthors', 'maxPrs']) {
    const n = Number(learn[f]);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ConfigError(`review.learn.${f} must be a positive integer (got: ${JSON.stringify(learn[f])})`);
    }
    learn[f] = n;
  }
  merged.review.learn = learn;
  if (learn.branchPrefix != null && typeof learn.branchPrefix !== 'string') {
    throw new ConfigError(`review.learn.branchPrefix must be a string (got: ${JSON.stringify(learn.branchPrefix)})`);
  }
  if (learn.ignorePath != null && typeof learn.ignorePath !== 'string') {
    throw new ConfigError(`review.learn.ignorePath must be a string or null (got: ${JSON.stringify(learn.ignorePath)})`);
  }

  // Normalize codingStandards / codingStandardsPath into _codingStandards array.
  const csArray = merged.review.codingStandards;
  const csPath = merged.review.codingStandardsPath;
  const normalized = [];
  if (csPath != null && typeof csPath !== 'string') {
    throw new ConfigError(
      `review.codingStandardsPath must be a string (got: ${typeof csPath})`,
    );
  }
  if (typeof csPath === 'string' && csPath.trim() !== '') {
    normalized.push({ glob: '*', path: csPath });
  }
  if (csArray != null && !Array.isArray(csArray)) {
    throw new ConfigError(
      `review.codingStandards must be an array of { glob, path } objects (got: ${typeof csArray})`,
    );
  }
  if (Array.isArray(csArray)) {
    for (let i = 0; i < csArray.length; i++) {
      const entry = csArray[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ConfigError(`review.codingStandards[${i}] must be an object with { glob, path }`);
      }
      if (typeof entry.glob !== 'string' || !entry.glob.trim()) {
        throw new ConfigError(`review.codingStandards[${i}].glob must be a non-empty string`);
      }
      if (typeof entry.path !== 'string' || !entry.path.trim()) {
        throw new ConfigError(`review.codingStandards[${i}].path must be a non-empty string`);
      }
      const trimmedGlob = entry.glob.trim();
      try { new Minimatch(trimmedGlob); } catch (e) {
        throw new ConfigError(`review.codingStandards[${i}].glob is not a valid glob pattern: ${e.message}`);
      }
      normalized.push({ glob: trimmedGlob, path: entry.path.trim() });
    }
  }
  merged.review._codingStandards = normalized;

  return deepMerge(merged, { auth: { anthropicKey, geminiKey, deepseekKey, modelstackKey, openaiKey, openrouterKey } });
}

module.exports = { validateConfig };
