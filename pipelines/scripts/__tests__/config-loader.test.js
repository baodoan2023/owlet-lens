// @ts-check
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, DEFAULTS } = require('../lib/config-loader.js');
const { ConfigError } = require('../lib/errors.js');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('config-loader', () => {
  it('returns DEFAULTS when no file present and ANTHROPIC_API_KEY env set', () => {
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'test-key-x' },
      cliFlags: {},
    });
    assert.equal(cfg.provider, 'auto');
    assert.equal(cfg.review.model, DEFAULTS.review.model);
    assert.equal(cfg.auth.anthropicKey, 'test-key-x');
    assert.equal(cfg.review.codingStandardsPath, null);
  });

  it('does not leak coerced learn overrides into shared DEFAULTS across calls', () => {
    const origLookback = DEFAULTS.review.learn.lookbackDays;
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  learn:\n    lookbackDays: 99\n',
    );
    loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    // The shared module-level default must be untouched.
    assert.equal(DEFAULTS.review.learn.lookbackDays, origLookback);
    // A second load with no learn override must still see the default, not 99.
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg2-'));
    try {
      const cfg2 = loadConfig({ cwd: tmp2, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
      assert.equal(cfg2.review.learn.lookbackDays, origLookback);
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it('reads review.codingStandardsPath from yaml', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  codingStandardsPath: ./standards/team.md\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'test-key-x' },
      cliFlags: {},
    });
    assert.equal(cfg.review.codingStandardsPath, './standards/team.md');
  });

  it('throws ConfigError when ANTHROPIC_API_KEY missing', () => {
    assert.throws(
      () => loadConfig({ cwd: tmp, env: {}, cliFlags: {} }),
      ConfigError,
    );
  });

  it('reads ai-review.config.yaml at cwd', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'provider: github\nreview:\n  maxFindings: 10\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'test-key-x' },
      cliFlags: {},
    });
    assert.equal(cfg.provider, 'github');
    assert.equal(cfg.review.maxFindings, 10);
    assert.equal(cfg.review.model, DEFAULTS.review.model);
  });

  it('expands ${ENV_VAR} interpolation in auth.token', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'auth:\n  token: ${MY_TOKEN}\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'test-key-x', MY_TOKEN: 'abc123' },
      cliFlags: {},
    });
    assert.equal(cfg.auth.token, 'abc123');
  });

  it('does not require auth.token (GITHUB_TOKEN) when provider is bitbucket', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'provider: github\nauth:\n  token: ${GITHUB_TOKEN}\n',
    );
    // GITHUB_TOKEN is absent; --provider=bitbucket must override and not block.
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k' },
      cliFlags: { provider: 'bitbucket' },
    });
    assert.equal(cfg.provider, 'bitbucket');
    assert.equal(cfg.auth.token, ''); // unresolved → empty, but not fatal
  });

  it('provider auto + Bitbucket Pipelines env does not require auth.token', () => {
    // The finding: auto-detected Bitbucket must not be blocked by a missing
    // GITHUB_TOKEN in a github-shaped auth.token field.
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'provider: auto\nauth:\n  token: ${GITHUB_TOKEN}\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k', BITBUCKET_PIPELINE_UUID: '{abc}' },
      cliFlags: {},
    });
    assert.equal(cfg.provider, 'auto');
  });

  it('provider auto + GitHub Actions still requires auth.token (unresolved → throws)', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'provider: auto\nauth:\n  token: ${GITHUB_TOKEN}\n',
    );
    assert.throws(
      () => loadConfig({
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: 'k', GITHUB_ACTIONS: 'true' },
        cliFlags: {},
      }),
      ConfigError,
    );
  });

  it('CLI flags override config file', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'provider: github\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'test-key-x' },
      cliFlags: { provider: 'azure' },
    });
    assert.equal(cfg.provider, 'azure');
  });

  it('warns on unknown top-level field but does not throw', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'unknown: 1\nreview:\n  maxFindings: 5\n',
    );
    const warnings = [];
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'test-key-x' },
      cliFlags: {},
      onWarn: (m) => warnings.push(m),
    });
    assert.equal(cfg.review.maxFindings, 5);
    assert.ok(warnings.some((w) => /unknown/i.test(w)));
  });

  it('does not load ai-review.config.js (arbitrary code execution surface)', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.js'), 'module.exports = {};');
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'test-key-x' },
      cliFlags: {},
    });
    assert.equal(cfg.provider, 'auto');
  });

  it('throws ConfigError when --config points at a .js file', () => {
    const bad = path.join(tmp, 'bad.js');
    fs.writeFileSync(bad, 'module.exports = {};');
    assert.throws(
      () => loadConfig({
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: 'test-key-x' },
        cliFlags: { configPath: bad },
      }),
      ConfigError,
    );
  });

  it('throws ConfigError on unresolved ${VAR} in a required auth field', () => {
    // auth.token is required for the github provider; unresolved → fatal.
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'provider: github\nauth:\n  token: ${MISSING_TOKEN}\n',
    );
    assert.throws(
      () => loadConfig({
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: 'test-key-x' },
        cliFlags: {},
      }),
      ConfigError,
    );
  });

  it('warns (not throws) on unresolved ${VAR} outside auth.*', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  model: ${MAYBE_MODEL}\n',
    );
    const warnings = [];
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'test-key-x' },
      cliFlags: {},
      onWarn: (m) => warnings.push(m),
    });
    assert.equal(cfg.review.model, '');
    assert.ok(warnings.some((w) => /MAYBE_MODEL/.test(w)));
  });

  it('rejects primitive override of an object base', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'paths: false\n',
    );
    assert.throws(
      () => loadConfig({
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: 'test-key-x' },
        cliFlags: {},
      }),
      ConfigError,
    );
  });

  it('rejects malformed markers.prefix', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'markers:\n  prefix: ".*"\n',
    );
    assert.throws(
      () => loadConfig({
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: 'test-key-x' },
        cliFlags: {},
      }),
      ConfigError,
    );
  });

  it('env AI_REVIEW_MODEL overrides yaml review.model', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  model: claude-opus-4-7\nauth:\n  anthropicKey: KEY\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k', AI_REVIEW_MODEL: 'claude-haiku-4-5-20251001' },
      cliFlags: {},
    });
    assert.equal(cfg.review.model, 'claude-haiku-4-5-20251001');
  });

  it('env AI_REPLY_MODEL overrides yaml reply.model', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'reply:\n  model: claude-haiku-4-5-20251001\nauth:\n  anthropicKey: KEY\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k', AI_REPLY_MODEL: 'claude-opus-4-7' },
      cliFlags: {},
    });
    assert.equal(cfg.reply.model, 'claude-opus-4-7');
  });

  it('env AI_REVIEW_SEVERITY_THRESHOLD overrides yaml review.severityThreshold', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  severityThreshold: medium\nauth:\n  anthropicKey: KEY\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k', AI_REVIEW_SEVERITY_THRESHOLD: 'high' },
      cliFlags: {},
    });
    assert.equal(cfg.review.severityThreshold, 'high');
  });

  it('env override beats yaml but does not affect unrelated fields', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  model: claude-opus-4-7\n  maxFindings: 50\nauth:\n  anthropicKey: KEY\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k', AI_REVIEW_MODEL: 'claude-haiku-4-5-20251001' },
      cliFlags: {},
    });
    assert.equal(cfg.review.model, 'claude-haiku-4-5-20251001');
    assert.equal(cfg.review.maxFindings, 50);
  });

  it('env empty/unset does not override yaml', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  model: claude-opus-4-7\nauth:\n  anthropicKey: KEY\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k', AI_REVIEW_MODEL: '' },
      cliFlags: {},
    });
    assert.equal(cfg.review.model, 'claude-opus-4-7');
  });

  it('defaults review.strict to false', () => {
    const cfg = loadConfig({
      cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' },
      cliFlags: {},
    });
    assert.equal(cfg.review.strict, false);
  });

  it('env AI_REVIEW_STRICT=true overrides yaml review.strict=false', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  strict: false\nauth:\n  anthropicKey: KEY\n');
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k', AI_REVIEW_STRICT: 'true' },
      cliFlags: {},
    });
    assert.equal(cfg.review.strict, true);
  });

  it('env AI_REVIEW_STRICT=1 / yes parsed as truthy', () => {
    for (const v of ['true', '1', 'yes', 'TRUE', 'Yes']) {
      const cfg = loadConfig({
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: 'k', AI_REVIEW_STRICT: v },
        cliFlags: {},
      });
      assert.equal(cfg.review.strict, true, `value ${v} should be truthy`);
    }
  });

  it('env AI_REVIEW_STRICT=garbage parsed as false', () => {
    for (const v of ['', 'no', '0', 'false', 'foo']) {
      const cfg = loadConfig({
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: 'k', AI_REVIEW_STRICT: v },
        cliFlags: {},
      });
      assert.equal(cfg.review.strict, false, `value ${v} should be false`);
    }
  });

  it('throws ConfigError on invalid review.severityThreshold', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  severityThreshold: nuclear\nauth:\n  anthropicKey: KEY\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      /severityThreshold/i,
    );
  });

  it('normalizes severityThreshold to lowercase from yaml', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  severityThreshold: High\nauth:\n  anthropicKey: KEY\n');
    const cfg = loadConfig({
      cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {},
    });
    assert.equal(cfg.review.severityThreshold, 'high');
  });

  it('defaults review.provider=anthropic, reply.provider=anthropic', () => {
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k' },
      cliFlags: {},
    });
    assert.equal(cfg.review.provider, 'anthropic');
    assert.equal(cfg.reply.provider, 'anthropic');
  });

  it('review.provider=gemini requires GEMINI_API_KEY', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: gemini\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: {}, cliFlags: {} }),
      /GEMINI_API_KEY/,
    );
  });

  it('reply.provider=deepseek requires DEEPSEEK_API_KEY', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: anthropic\nreply:\n  provider: deepseek\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      /DEEPSEEK_API_KEY/,
    );
  });

  it('gemini provider with key from env', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: gemini\nreply:\n  provider: gemini\n');
    const cfg = loadConfig({ cwd: tmp, env: { GEMINI_API_KEY: 'gk' }, cliFlags: {} });
    assert.equal(cfg.review.provider, 'gemini');
    assert.equal(cfg.auth.geminiKey, 'gk');
  });

  it('pricing override merged from YAML', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'pricing:\n  claude-opus-4-7:\n    inputPerMTok: 4\n    outputPerMTok: 20\n');
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.deepEqual(cfg.pricing['claude-opus-4-7'], { inputPerMTok: 4, outputPerMTok: 20 });
  });

  it('pricing override accepts cacheReadPerMTok', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'pricing:\n  m:\n    inputPerMTok: 4\n    outputPerMTok: 20\n    cacheReadPerMTok: 0.2\n');
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.pricing.m.cacheReadPerMTok, 0.2);
  });

  it('pricing override treats an empty cacheReadPerMTok as unset', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'pricing:\n  m:\n    inputPerMTok: 4\n    outputPerMTok: 20\n    cacheReadPerMTok:\n');
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.pricing.m.cacheReadPerMTok ?? null, null);
  });

  it('pricing override rejects a non-numeric cacheReadPerMTok', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'pricing:\n  m:\n    inputPerMTok: 4\n    outputPerMTok: 20\n    cacheReadPerMTok: cheap\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      /pricing\.m\.cacheReadPerMTok must be a finite number >= 0/,
    );
  });

  it('inactive provider key absent does not throw', () => {
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k' },
      cliFlags: {},
    });
    assert.equal(cfg.auth.geminiKey, null);
    assert.equal(cfg.auth.deepseekKey, null);
  });

  it('defaults review.contextPaths to empty array', () => {
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k' },
      cliFlags: {},
    });
    assert.deepEqual(cfg.review.contextPaths, []);
  });

  it('reads review.contextPaths array from yaml', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  contextPaths:\n    - ./CLAUDE.md\n    - ./docs/architecture.md\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k' },
      cliFlags: {},
    });
    assert.deepEqual(cfg.review.contextPaths, ['./CLAUDE.md', './docs/architecture.md']);
  });

  it('throws ConfigError when contextPaths is not an array', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  contextPaths: ./CLAUDE.md\n',
    );
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      ConfigError,
    );
  });

  it('throws ConfigError when contextPaths entry is non-string', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  contextPaths:\n    - ./CLAUDE.md\n    - 42\n',
    );
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      ConfigError,
    );
  });

  it('throws ConfigError when paths.exclude entry is non-string', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'paths:\n  exclude:\n    - "**/*.test.ts"\n    - 42\n',
    );
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      /paths\.exclude entries must be strings/,
    );
  });

  it('interpolates auth.bitbucketToken from YAML using env variable', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'auth:\n  bitbucketToken: ${BITBUCKET_TOKEN}\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k', BITBUCKET_TOKEN: 'bb-secret' },
      cliFlags: {},
    });
    assert.equal(cfg.auth.bitbucketToken, 'bb-secret');
  });

  it('defaults auth.bitbucketToken to null when not set', () => {
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k' },
      cliFlags: {},
    });
    assert.equal(cfg.auth.bitbucketToken, null);
  });

  it('resolves MODELSTACK_API_KEY when modelstack is the active provider', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: modelstack\n  model: gpt-4o\nreply:\n  provider: modelstack\n  model: gpt-4o-mini\n',
    );
    const cfg = loadConfig({ cwd: tmp, env: { MODELSTACK_API_KEY: 'mk' }, cliFlags: {} });
    assert.equal(cfg.auth.modelstackKey, 'mk');
  });

  it('throws ConfigError when modelstack active but MODELSTACK_API_KEY missing', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: modelstack\n  model: gpt-4o\nreply:\n  provider: modelstack\n  model: gpt-4o-mini\n',
    );
    assert.throws(
      () => loadConfig({ cwd: tmp, env: {}, cliFlags: {} }),
      /MODELSTACK_API_KEY is required/,
    );
  });

  it('does not require MODELSTACK_API_KEY when modelstack is inactive', () => {
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'ak' }, cliFlags: {} });
    assert.equal(cfg.auth.modelstackKey, null);
  });

  it('fallbackModels defaults to empty arrays for review and reply', () => {
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k' },
      cliFlags: {},
    });
    assert.deepStrictEqual(cfg.review.fallbackModels, []);
    assert.deepStrictEqual(cfg.reply.fallbackModels, []);
  });

  it('review.fallbackModels passes through string entries', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  fallbackModels:\n    - deepseek-v3.2\n    - claude-sonnet-4-6\n',
    );
    const cfg = loadConfig({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: 'k' },
      cliFlags: {},
    });
    assert.deepStrictEqual(cfg.review.fallbackModels, ['deepseek-v3.2', 'claude-sonnet-4-6']);
  });

  it('non-string fallbackModels entry throws ConfigError', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  fallbackModels:\n    - ok-model\n    - 42\n',
    );
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      (e) => e.name === 'ConfigError' && /fallbackModels entries must be strings/.test(e.message),
    );
  });

  it('default fallbackModels are not shared across loadConfig calls', () => {
    const a = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    const b = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    // Distinct array instances — a later in-place edit must not leak into the
    // shared module-level DEFAULTS or into the other config (see obs #484).
    assert.notStrictEqual(a.review.fallbackModels, b.review.fallbackModels);
    assert.notStrictEqual(a.reply.fallbackModels, b.reply.fallbackModels);
    a.review.fallbackModels.push('leaked');
    assert.deepStrictEqual(b.review.fallbackModels, []);
  });

  it('review.maxFileBytes defaults to null', () => {
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.maxFileBytes, null);
  });

  it('accepts a positive integer review.maxFileBytes', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), 'review:\n  maxFileBytes: 50000\n');
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.maxFileBytes, 50000);
  });

  it('rejects non-positive / non-integer review.maxFileBytes', () => {
    for (const bad of ['0', '-5', '12.5', '"abc"']) {
      fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), `review:\n  maxFileBytes: ${bad}\n`);
      assert.throws(
        () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
        /review\.maxFileBytes must be a positive integer or null/,
        `expected throw for maxFileBytes: ${bad}`,
      );
    }
  });

  it('review.tokenBudget defaults to 512000', () => {
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.tokenBudget, 512000);
  });

  it('accepts a positive integer review.tokenBudget', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), 'review:\n  tokenBudget: 120000\n');
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.tokenBudget, 120000);
  });

  it('rejects non-positive / non-integer / non-number review.tokenBudget', () => {
    // Includes values that Number() would coerce to a valid integer
    // (`[512000]`, `"512000"`) — those must not slip through.
    for (const bad of ['0', '-5', '12.5', '"abc"', 'true', '"512000"', '[512000]']) {
      fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), `review:\n  tokenBudget: ${bad}\n`);
      assert.throws(
        () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
        /review\.tokenBudget must be a positive integer/,
        `expected throw for tokenBudget: ${bad}`,
      );
    }
  });

  it('review.exportWebhookUrl defaults to null', () => {
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.exportWebhookUrl, null);
  });

  it('accepts a valid http(s) review.exportWebhookUrl on an approved host', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), 'review:\n  exportWebhookUrl: https://hooks.example.com/webhook\n');
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k', AI_REVIEW_ALLOWED_HOSTS: 'hooks.example.com' }, cliFlags: {} });
    assert.equal(cfg.review.exportWebhookUrl, 'https://hooks.example.com/webhook');
  });

  it('rejects non-https review.exportWebhookUrl', () => {
    for (const bad of ['"ftp://x"', '42', '"not-a-url"', '"http://insecure.example.com"']) {
      fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), `review:\n  exportWebhookUrl: ${bad}\n`);
      assert.throws(
        () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
        /review\.exportWebhookUrl/,
        `expected throw for exportWebhookUrl: ${bad}`,
      );
    }
  });

  it('review.latencyWarnMs defaults to 300000', () => {
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.latencyWarnMs, 300000);
  });

  it('accepts a positive integer review.latencyWarnMs', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), 'review:\n  latencyWarnMs: 600000\n');
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.latencyWarnMs, 600000);
  });

  it('rejects non-positive / non-integer review.latencyWarnMs', () => {
    for (const bad of ['0', '-5', '12.5', '"abc"', 'true']) {
      fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), `review:\n  latencyWarnMs: ${bad}\n`);
      assert.throws(
        () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
        /review\.latencyWarnMs must be a positive integer or null/,
        `expected throw for latencyWarnMs: ${bad}`,
      );
    }
  });

  it('rejects boolean review.maxFileBytes (YAML true/yes coerces to 1)', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), 'review:\n  maxFileBytes: true\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      /review\.maxFileBytes must be a positive integer or null/,
    );
  });

  it('rejects boolean review.maxFindings (YAML true/yes coerces to 1)', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), 'review:\n  maxFindings: true\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      /review\.maxFindings must be a positive integer or null/,
    );
  });


  it('defaults testFileSeverityThreshold/noiseCategories/skipGeneratedFiles', () => {
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.testFileSeverityThreshold, 'high');
    assert.deepEqual(cfg.review.noiseCategories, ['style', 'naming']);
    assert.equal(cfg.review.skipGeneratedFiles, true);
  });

  it('reads and normalizes review.testFileSeverityThreshold from yaml', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  testFileSeverityThreshold: MEDIUM\n',
    );
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.testFileSeverityThreshold, 'medium');
  });

  it('throws ConfigError on invalid review.testFileSeverityThreshold', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  testFileSeverityThreshold: extreme\n',
    );
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      ConfigError,
    );
  });

  it('reads review.noiseCategories override from yaml', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  noiseCategories: []\n',
    );
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.deepEqual(cfg.review.noiseCategories, []);
  });

  it('throws ConfigError when review.noiseCategories has a non-string entry', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  noiseCategories: [style, 42]\n',
    );
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      ConfigError,
    );
  });

  it('does not leak coerced noiseCategories overrides into shared DEFAULTS across calls', () => {
    const origLen = DEFAULTS.review.noiseCategories.length;
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  noiseCategories: [style, naming, security]\n',
    );
    loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(DEFAULTS.review.noiseCategories.length, origLen);
  });

  it('normalizes review.noiseCategories entries (trim + lowercase)', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  noiseCategories: [Style, NAMING]\n',
    );
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.deepEqual(cfg.review.noiseCategories, ['style', 'naming']);
  });

  it('throws ConfigError when review.noiseCategories has an entry outside the real category enum', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  noiseCategories: [nonexistent-category]\n',
    );
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      ConfigError,
    );
  });

  it('reads review.skipGeneratedFiles override from yaml', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  skipGeneratedFiles: false\n',
    );
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.skipGeneratedFiles, false);
  });

  it('throws ConfigError when review.skipGeneratedFiles is not a boolean', () => {
    fs.writeFileSync(
      path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  skipGeneratedFiles: "yes"\n',
    );
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
      ConfigError,
    );
  });
});

describe('review.detectBreakingChanges', () => {
  it('throws ConfigError on non-boolean value', () => {
    for (const bad of ['"true"', '1', '"yes"']) {
      fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), `review:\n  detectBreakingChanges: ${bad}\n`);
      assert.throws(
        () => loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} }),
        /review\.detectBreakingChanges must be a boolean/,
        `expected throw for detectBreakingChanges: ${bad}`,
      );
    }
  });

  it('accepts true, false, and null (defaults to false)', () => {
    for (const val of ['true', 'false']) {
      fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), `review:\n  detectBreakingChanges: ${val}\n`);
      const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
      assert.equal(cfg.review.detectBreakingChanges, val === 'true');
    }
    const cfg = loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k' }, cliFlags: {} });
    assert.equal(cfg.review.detectBreakingChanges, false);
  });
});

describe('review.learn config', () => {
  let learnTmp;
  beforeEach(() => { learnTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learncfg-')); });
  afterEach(() => { fs.rmSync(learnTmp, { recursive: true, force: true }); });

  it('defaults learn block when omitted', () => {
    const cfg = loadConfig({ cwd: learnTmp, cliFlags: {}, env: { ANTHROPIC_API_KEY: 'k' } });
    assert.deepEqual(cfg.review.learn, {
      lookbackDays: 45, minWontfix: 2, minDistinctAuthors: 1,
      maxPrs: 200, branchPrefix: 'owlet-lens/learn', ignorePath: null,
    });
  });

  it('throws on non-positive lookbackDays', () => {
    fs.writeFileSync(path.join(learnTmp, 'ai-review.config.yaml'), 'review:\n  learn:\n    lookbackDays: 0\n');
    assert.throws(
      () => loadConfig({ cwd: learnTmp, cliFlags: {}, env: { ANTHROPIC_API_KEY: 'k' } }),
      /review\.learn\.lookbackDays/,
    );
  });

  it('throws on non-integer minWontfix', () => {
    fs.writeFileSync(path.join(learnTmp, 'ai-review.config.yaml'), 'review:\n  learn:\n    minWontfix: abc\n');
    assert.throws(
      () => loadConfig({ cwd: learnTmp, cliFlags: {}, env: { ANTHROPIC_API_KEY: 'k' } }),
      /review\.learn\.minWontfix/,
    );
  });
});

describe('codingStandards array normalization', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-norm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const env = { ANTHROPIC_API_KEY: 'k' };

  it('normalizes codingStandardsPath string to _codingStandards array', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), 'review:\n  codingStandardsPath: rules/general.md\n');
    const cfg = loadConfig({ cwd: tmp, cliFlags: {}, env });
    assert.deepEqual(cfg.review._codingStandards, [{ glob: '*', path: 'rules/general.md' }]);
    assert.equal(cfg.review.codingStandardsPath, 'rules/general.md');
  });

  it('passes codingStandards array through to _codingStandards', () => {
    const yaml = `review:\n  codingStandards:\n    - glob: "*.ts"\n      path: rules/ts.md\n    - glob: "*.java"\n      path: rules/java.md\n`;
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml);
    const cfg = loadConfig({ cwd: tmp, cliFlags: {}, env });
    assert.deepEqual(cfg.review._codingStandards, [
      { glob: '*.ts', path: 'rules/ts.md' },
      { glob: '*.java', path: 'rules/java.md' },
    ]);
  });

  it('merges codingStandardsPath as catch-all prepended to codingStandards array', () => {
    const yaml = `review:\n  codingStandardsPath: rules/general.md\n  codingStandards:\n    - glob: "*.ts"\n      path: rules/ts.md\n`;
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml);
    const cfg = loadConfig({ cwd: tmp, cliFlags: {}, env });
    assert.deepEqual(cfg.review._codingStandards, [
      { glob: '*', path: 'rules/general.md' },
      { glob: '*.ts', path: 'rules/ts.md' },
    ]);
  });

  it('defaults _codingStandards to empty array when neither key is set', () => {
    const cfg = loadConfig({ cwd: tmp, cliFlags: {}, env });
    assert.deepEqual(cfg.review._codingStandards, []);
  });

  it('throws ConfigError for array entry missing glob', () => {
    const yaml = `review:\n  codingStandards:\n    - path: rules/ts.md\n`;
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml);
    assert.throws(
      () => loadConfig({ cwd: tmp, cliFlags: {}, env }),
      /codingStandards.*glob.*string/,
    );
  });

  it('throws ConfigError for array entry missing path', () => {
    const yaml = `review:\n  codingStandards:\n    - glob: "*.ts"\n`;
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml);
    assert.throws(
      () => loadConfig({ cwd: tmp, cliFlags: {}, env }),
      /codingStandards.*path.*string/,
    );
  });

  it('throws ConfigError for non-object array entry', () => {
    const yaml = `review:\n  codingStandards:\n    - "just-a-string"\n`;
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml);
    assert.throws(
      () => loadConfig({ cwd: tmp, cliFlags: {}, env }),
      /codingStandards.*must be.*object/,
    );
  });

  it('throws ConfigError when codingStandards is a non-array non-null value', () => {
    const yaml = `review:\n  codingStandards: rules/java.md\n`;
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml);
    assert.throws(
      () => loadConfig({ cwd: tmp, cliFlags: {}, env }),
      /codingStandards must be an array/,
    );
  });

  it('throws ConfigError for whitespace-only glob or path', () => {
    const yaml1 = `review:\n  codingStandards:\n    - glob: "  "\n      path: rules/ts.md\n`;
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml1);
    assert.throws(
      () => loadConfig({ cwd: tmp, cliFlags: {}, env }),
      /codingStandards.*glob.*non-empty/,
    );

    const yaml2 = `review:\n  codingStandards:\n    - glob: "*.ts"\n      path: "  "\n`;
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml2);
    assert.throws(
      () => loadConfig({ cwd: tmp, cliFlags: {}, env }),
      /codingStandards.*path.*non-empty/,
    );
  });

  it('trims whitespace from glob and path values', () => {
    const yaml = `review:\n  codingStandards:\n    - glob: " *.ts "\n      path: " rules/ts.md "\n`;
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml);
    const cfg = loadConfig({ cwd: tmp, cliFlags: {}, env });
    assert.equal(cfg.review._codingStandards[0].glob, '*.ts');
    assert.equal(cfg.review._codingStandards[0].path, 'rules/ts.md');
  });
});

describe('config-loader — cross-provider fallbackModels (ADR-0021)', () => {
  it('a provider-prefixed fallback requires that provider\'s key', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: deepseek\n  model: deepseek-v4-pro\n  fallbackModels: [anthropic:claude-sonnet-5-5]\nreply:\n  provider: deepseek\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { DEEPSEEK_API_KEY: 'dk' }, cliFlags: {} }),
      (e) => e instanceof ConfigError && /ANTHROPIC_API_KEY/.test(e.message) && /review\.fallbackModels/.test(e.message),
    );
  });

  it('loads when the fallback provider key is present', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: deepseek\n  model: deepseek-v4-pro\n  fallbackModels: [anthropic:claude-sonnet-5-5]\nreply:\n  provider: deepseek\n');
    const cfg = loadConfig({ cwd: tmp, env: { DEEPSEEK_API_KEY: 'dk', ANTHROPIC_API_KEY: 'ak' }, cliFlags: {} });
    assert.deepEqual(cfg.review.fallbackModels, ['anthropic:claude-sonnet-5-5']);
    assert.equal(cfg.auth.anthropicKey, 'ak');
  });

  it('an unresolved ${VAR} in the fallback provider\'s auth field is fatal, not a warning', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: deepseek\n  fallbackModels: [anthropic:claude-sonnet-5-5]\nreply:\n  provider: deepseek\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { DEEPSEEK_API_KEY: 'dk' }, cliFlags: {} }),
      /auth\.anthropicKey/,
    );
  });

  it('an empty model after a provider prefix is a ConfigError', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: deepseek\n  fallbackModels: ["anthropic:"]\nreply:\n  provider: deepseek\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { DEEPSEEK_API_KEY: 'dk', ANTHROPIC_API_KEY: 'ak' }, cliFlags: {} }),
      ConfigError,
    );
  });

  it('an unknown prefix is treated as part of the model id', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: openrouter\n  model: x\n  fallbackModels: ["meta-llama/llama-3-8b:free"]\nreply:\n  provider: openrouter\n  model: x\n');
    const cfg = loadConfig({ cwd: tmp, env: { OPENROUTER_API_KEY: 'ok' }, cliFlags: {} });
    assert.deepEqual(cfg.review.fallbackModels, ['meta-llama/llama-3-8b:free']);
  });
});

describe('config-loader — fallback key edge cases (ADR-0021)', () => {
  it('an openai:<model> fallback needs a non-empty key (no apiBaseUrl, so api.openai.com)', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: deepseek\n  fallbackModels: [openai:gpt-4o]\nreply:\n  provider: deepseek\nauth:\n  openaiKey: ""\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { DEEPSEEK_API_KEY: 'dk' }, cliFlags: {} }),
      (e) => e instanceof ConfigError && /OPENAI_API_KEY/.test(e.message),
    );
  });

  it('the missing-key error names the own-provider escape hatch', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: modelstack\n  model: m\n  fallbackModels: [anthropic:claude-x]\nreply:\n  provider: modelstack\n  model: m\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { MODELSTACK_API_KEY: 'mk' }, cliFlags: {} }),
      (e) => e instanceof ConfigError && /modelstack:anthropic:claude-x/.test(e.message),
    );
  });

  it('the hint survives a spaced prefix ("anthropic :x")', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'review:\n  provider: modelstack\n  model: m\n  fallbackModels: ["anthropic :claude-x"]\nreply:\n  provider: modelstack\n  model: m\n');
    assert.throws(
      () => loadConfig({ cwd: tmp, env: { MODELSTACK_API_KEY: 'mk' }, cliFlags: {} }),
      (e) => e instanceof ConfigError && /ANTHROPIC_API_KEY/.test(e.message),
    );
  });
});
