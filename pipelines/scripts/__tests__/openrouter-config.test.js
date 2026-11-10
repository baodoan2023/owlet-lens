// @ts-check
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateOpenRouterConfig, warnUnusedOpenRouterModels } = require('../lib/openrouter-config.js');
const { loadConfig } = require('../lib/config-loader.js');
const { ConfigError } = require('../lib/errors.js');

describe('validateOpenRouterConfig', () => {
  it('defaults to dataCollection deny, zdr false, no models', () => {
    assert.deepEqual(validateOpenRouterConfig(undefined), { dataCollection: 'deny', zdr: false, models: {} });
    assert.deepEqual(validateOpenRouterConfig(null), { dataCollection: 'deny', zdr: false, models: {} });
  });

  it('accepts the full per-model whitelist and returns a fresh copy', () => {
    const entry = {
      only: ['open-inference/fp4'],
      ignore: ['deepinfra'],
      order: ['cerebras', 'groq'],
      quantizations: ['fp8'],
      allowFallbacks: false,
      zdr: true,
      dataCollection: 'allow',
      sort: 'throughput',
      reasoning: { enabled: true, effort: 'high', maxTokens: 4000 },
      maxOutputTokens: 32000,
    };
    const raw = { dataCollection: 'deny', zdr: false, models: { 'z-ai/glm-5.3-flash': entry } };
    const out = validateOpenRouterConfig(raw);
    assert.deepEqual(out.models['z-ai/glm-5.3-flash'], entry);
    assert.notEqual(out.models['z-ai/glm-5.3-flash'], entry);
    assert.notEqual(out.models['z-ai/glm-5.3-flash'].only, entry.only);
  });

  it('treats null fields as unset', () => {
    const out = validateOpenRouterConfig({ dataCollection: null, zdr: null, models: { m: { zdr: null, only: null } } });
    assert.deepEqual(out, { dataCollection: 'deny', zdr: false, models: { m: {} } });
  });

  const bad = [
    [{ foo: 1 }, /openrouter\.foo/],
    [{ dataCollection: 'never' }, /openrouter\.dataCollection/],
    [{ zdr: 'yes' }, /openrouter\.zdr/],
    [{ models: [] }, /openrouter\.models/],
    [{ models: { m: 'x' } }, /openrouter\.models\["m"\]/],
    [{ models: { m: { allow_fallbacks: false } } }, /openrouter\.models\["m"\]\.allow_fallbacks/],
    [{ models: { m: { only: 'groq' } } }, /openrouter\.models\["m"\]\.only/],
    [{ models: { m: { only: ['groq', ''] } } }, /openrouter\.models\["m"\]\.only/],
    [{ models: { m: { allowFallbacks: 'no' } } }, /allowFallbacks/],
    [{ models: { m: { sort: 'cheapest' } } }, /sort/],
    [{ models: { m: { maxOutputTokens: 0 } } }, /maxOutputTokens/],
    [{ models: { m: { maxOutputTokens: 1.5 } } }, /maxOutputTokens/],
    [{ models: { m: { reasoning: true } } }, /reasoning/],
    [{ models: { m: { reasoning: { effort: 'max' } } } }, /reasoning\.effort/],
    [{ models: { m: { reasoning: { enabled: 1 } } } }, /reasoning\.enabled/],
    [{ models: { m: { reasoning: { maxTokens: -1 } } } }, /reasoning\.maxTokens/],
    [{ models: { m: { reasoning: { exclude: true } } } }, /reasoning\.exclude/],
  ];
  for (const [raw, re] of bad) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      assert.throws(() => validateOpenRouterConfig(raw), (e) => e instanceof ConfigError && re.test(e.message));
    });
  }
});

describe('warnUnusedOpenRouterModels', () => {
  const base = {
    review: { provider: 'openrouter', model: 'a/x', fallbackModels: ['b/y'] },
    reply: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', fallbackModels: [] },
  };

  it('warns for a models key that no configured model uses', () => {
    const warnings = [];
    warnUnusedOpenRouterModels({ ...base, openrouter: { models: { 'a/x': {}, 'b/y': {}, 'c/typo': {} } } }, (m) => warnings.push(m));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /openrouter\.models\["c\/typo"\]/);
  });

  it('stays silent when openrouter is not an active provider', () => {
    const warnings = [];
    const merged = {
      review: { ...base.review, provider: 'anthropic' },
      reply: base.reply,
      openrouter: { models: { 'c/typo': {} } },
    };
    warnUnusedOpenRouterModels(merged, (m) => warnings.push(m));
    assert.deepEqual(warnings, []);
  });

  it('counts an openrouter:<model> fallback on another provider as in use (ADR-0021)', () => {
    const warnings = [];
    const merged = {
      review: { provider: 'deepseek', model: 'deepseek-v4-pro', fallbackModels: ['openrouter:a/x'] },
      reply: base.reply,
      openrouter: { models: { 'a/x': {}, 'c/typo': {} } },
    };
    warnUnusedOpenRouterModels(merged, (m) => warnings.push(m));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /c\/typo/);
  });

  it('counts reply-path models when only reply uses openrouter', () => {
    const warnings = [];
    const merged = {
      review: { ...base.review, provider: 'anthropic' },
      reply: { provider: 'openrouter', model: 'r/m', fallbackModels: ['r/f'] },
      openrouter: { models: { 'r/m': {}, 'r/f': {} } },
    };
    warnUnusedOpenRouterModels(merged, (m) => warnings.push(m));
    assert.deepEqual(warnings, []);
  });
});

describe('loadConfig with an openrouter block', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-or-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('accepts the block with no unknown-field warning and normalizes it', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), [
      'review:',
      '  provider: openrouter',
      '  model: z-ai/glm-5.3-flash',
      'reply:',
      '  provider: openrouter',
      '  model: z-ai/glm-5.3-flash',
      'openrouter:',
      '  models:',
      '    z-ai/glm-5.3-flash:',
      '      only: [open-inference/fp4]',
      '      allowFallbacks: false',
      '',
    ].join('\n'));
    const warnings = [];
    const cfg = loadConfig({ cwd: tmp, env: { OPENROUTER_API_KEY: 'or-k' }, cliFlags: {}, onWarn: (m) => warnings.push(m) });
    assert.deepEqual(warnings, []);
    assert.equal(cfg.auth.openrouterKey, 'or-k');
    assert.deepEqual(cfg.openrouter, {
      dataCollection: 'deny',
      zdr: false,
      models: { 'z-ai/glm-5.3-flash': { only: ['open-inference/fp4'], allowFallbacks: false } },
    });
  });

  it('validates the block shape even when openrouter is not active', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), 'openrouter:\n  zdr: maybe\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      (e) => e instanceof ConfigError && /openrouter\.zdr/.test(e.message),
    );
  });

  for (const bad of ['1234', '""', '{ host: x }']) {
    it(`rejects review.apiBaseUrl: ${bad} with a ConfigError before the adapter sees it`, () => {
      fs.writeFileSync(
        path.join(tmp, 'ai-review.config.yaml'),
        `review:\n  provider: openrouter\n  model: a/b\n  apiBaseUrl: ${bad}\n`,
      );
      assert.throws(
        () => loadConfig({ cwd: tmp, env: { OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
        (e) => e instanceof ConfigError && /review\.apiBaseUrl/.test(e.message),
      );
    });
  }

  it('requires OPENROUTER_API_KEY when openrouter is active', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), 'review:\n  provider: openrouter\n  model: a/b\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      (e) => e instanceof ConfigError && /OPENROUTER_API_KEY/.test(e.message),
    );
  });
});
