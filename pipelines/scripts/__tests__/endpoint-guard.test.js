// @ts-check
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../lib/config-loader.js');
const { ConfigError } = require('../lib/errors.js');
const { isSecretVarName, allowedHostsFrom } = require('../lib/endpoint-guard.js');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** @param {string} yaml @param {Record<string,string>} [env] */
function load(yaml, env = {}) {
  fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), yaml);
  return loadConfig({ cwd: tmp, env: { ANTHROPIC_API_KEY: 'k', ...env }, cliFlags: {} });
}

describe('secret-named variables are read only under auth.*', () => {
  it('recognises secret-looking names and leaves ordinary ones alone', () => {
    for (const n of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'AI_REVIEW_RESOLVE_TOKEN', 'DB_PASSWORD', 'AZURE_PAT', 'SYSTEM_ACCESSTOKEN', 'MY_SECRET']) {
      assert.equal(isSecretVarName(n), true, n);
    }
    for (const n of ['GITHUB_REPOSITORY', 'CI_SERVER_URL', 'KEYWORD', 'AI_REVIEW_MODEL', 'HOME']) {
      assert.equal(isSecretVarName(n), false, n);
    }
  });

  it('still reads secrets under auth.*', () => {
    const cfg = load('auth:\n  token: ${GITHUB_TOKEN}\n  modelstackKey: ${MODELSTACK_API_KEY}\n', { GITHUB_TOKEN: 't', MODELSTACK_API_KEY: 'm' });
    assert.equal(cfg.auth.token, 't');
    assert.equal(cfg.auth.modelstackKey, 'm');
  });

  it('refuses a token placed in a URL field', () => {
    assert.throws(
      () => load('review:\n  exportWebhookUrl: https://hooks.example.com/?t=${AI_REVIEW_RESOLVE_TOKEN}\n', { AI_REVIEW_RESOLVE_TOKEN: 'secret-value', AI_REVIEW_ALLOWED_HOSTS: 'hooks.example.com' }),
      (e) => e instanceof ConfigError && /review\.exportWebhookUrl/.test(e.message) && /AI_REVIEW_RESOLVE_TOKEN/.test(e.message) && !/secret-value/.test(e.message),
    );
  });

  it('refuses a token in any other field, nested or in a list', () => {
    assert.throws(() => load('review:\n  codingStandardsPath: ${GITHUB_TOKEN}\n', { GITHUB_TOKEN: 'x' }), ConfigError);
    assert.throws(() => load('review:\n  contextPaths:\n    - ${ANTHROPIC_API_KEY}\n'), ConfigError);
  });

  it('still reads ordinary variables anywhere', () => {
    const cfg = load('review:\n  codingStandardsPath: ${STANDARDS_FILE}\n', { STANDARDS_FILE: 'docs/standards.md' });
    assert.equal(cfg.review.codingStandardsPath, 'docs/standards.md');
  });
});

describe('URLs that receive data need an approved host', () => {
  it('parses AI_REVIEW_ALLOWED_HOSTS: comma or space separated, lower case, exact names', () => {
    assert.deepEqual(allowedHostsFrom({ AI_REVIEW_ALLOWED_HOSTS: ' A.example.com,b.example.com  c.example.com ' }), ['a.example.com', 'b.example.com', 'c.example.com']);
    assert.deepEqual(allowedHostsFrom({}), []);
  });

  it('accepts the host of a built-in provider without any list', () => {
    const cfg = load('review:\n  apiBaseUrl: https://api.anthropic.com/v1/messages\n');
    assert.equal(cfg.review.apiBaseUrl, 'https://api.anthropic.com/v1/messages');
  });

  it('accepts the OpenRouter host for the openrouter provider without any list', () => {
    const cfg = load('review:\n  provider: openrouter\n  model: anthropic/claude-sonnet-4.5\n  apiBaseUrl: https://openrouter.ai/api/v1\n', { OPENROUTER_API_KEY: 'k' });
    assert.equal(cfg.review.apiBaseUrl, 'https://openrouter.ai/api/v1');
  });

  it('refuses another apiBaseUrl host, for review and for reply', () => {
    for (const kind of ['review', 'reply']) {
      assert.throws(
        () => load(`${kind}:\n  apiBaseUrl: https://llm.attacker.example/v1\n`),
        (e) => e instanceof ConfigError && new RegExp(`${kind}\\.apiBaseUrl`).test(e.message) && /llm\.attacker\.example/.test(e.message) && /allowed-hosts/.test(e.message),
      );
    }
  });

  it('accepts that host once the workflow approves it', () => {
    const cfg = load('review:\n  provider: openai\n  apiBaseUrl: https://llm.corp.example/v1\n', { AI_REVIEW_ALLOWED_HOSTS: 'llm.corp.example', OPENAI_API_KEY: 'k' });
    assert.equal(cfg.review.apiBaseUrl, 'https://llm.corp.example/v1');
  });

  it('judges the real host: user-info and look-alike prefixes do not pass', () => {
    assert.throws(() => load('review:\n  apiBaseUrl: https://api.anthropic.com@attacker.example/v1\n'), ConfigError);
    assert.throws(() => load('review:\n  apiBaseUrl: https://api.anthropic.com.attacker.example/v1\n'), ConfigError);
  });

  it('refuses a webhook host that is not approved, even a built-in LLM host', () => {
    assert.throws(() => load('review:\n  exportWebhookUrl: https://hooks.attacker.example/x\n'), ConfigError);
    assert.throws(() => load('review:\n  exportWebhookUrl: https://api.anthropic.com/x\n'), ConfigError);
  });

  it('the configuration file cannot approve a host itself', () => {
    assert.throws(
      () => load('review:\n  apiBaseUrl: https://llm.attacker.example/v1\n  allowedHosts: [llm.attacker.example]\n'),
      ConfigError,
    );
  });
});

describe('the secret-name match is wide on purpose', () => {
  it('catches plural and compound names that an anchored match would miss', () => {
    for (const n of ['AWS_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS', 'SSH_PRIVATE_KEY', 'MY_PRIVATE_CONFIG']) {
      assert.equal(isSecretVarName(n), true, n);
    }
  });
  it('does not catch KEY or PAT inside another word', () => {
    for (const n of ['KEYWORD', 'PATH', 'MONKEY_BUSINESS']) {
      assert.equal(isSecretVarName(n), false, n);
    }
  });
});
