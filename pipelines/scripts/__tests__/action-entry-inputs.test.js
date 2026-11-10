'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function stubModule(modPath, exportsObj) {
  require.cache[require.resolve(modPath)] = {
    id: require.resolve(modPath),
    filename: require.resolve(modPath),
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: [],
    parent: null,
  };
}

const ACTION_ENTRY = path.resolve(__dirname, '../action-entry.js');

const ENV_KEYS = [
  'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_RUN_ID', 'GITHUB_REF', 'GITHUB_PR_NUMBER',
  'AI_REVIEW_LLM_PROVIDER', 'AI_REPLY_LLM_PROVIDER', 'OPENROUTER_API_KEY',
];

/** Side effects of the last runWithInputs call beyond the provider env vars. */
const last = { secrets: /** @type {string[]} */ ([]), openrouterKey: /** @type {string|undefined} */ (undefined) };

/**
 * Run action-entry main() with the given action inputs and capture the LLM
 * provider env vars visible when runReview is dispatched.
 * @param {Record<string, string>} inputs
 */
async function runWithInputs(inputs) {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  delete process.env.AI_REVIEW_LLM_PROVIDER;
  delete process.env.AI_REPLY_LLM_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  last.secrets = [];
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.GITHUB_REF = 'refs/pull/42/head';

  let seen = null;
  stubModule('../lib/port/cache-port.js', { restore: async () => ({ hit: false, key: null }), save: async () => {} });
  stubModule('../ai-review.js', {
    runReview: async () => {
      seen = { review: process.env.AI_REVIEW_LLM_PROVIDER, reply: process.env.AI_REPLY_LLM_PROVIDER };
      last.openrouterKey = process.env.OPENROUTER_API_KEY;
      return 0;
    },
    runReply: async () => 0,
  });
  const base = { subcommand: 'review', 'config-path': 'ai-review.config.yaml', provider: 'github', 'github-token': 't', 'pr-number': '42' };
  stubModule('@actions/core', {
    getInput: (name) => ({ ...base, ...inputs })[name] ?? '',
    getBooleanInput: () => false,
    setSecret: (v) => { last.secrets.push(v); },
    setOutput: () => {},
    setFailed: () => {},
  });

  const origExit = process.exit;
  process.exit = /** @type {any} */ (() => {});
  try {
    delete require.cache[require.resolve(ACTION_ENTRY)];
    await require(ACTION_ENTRY).main();
  } finally {
    process.exit = origExit;
    for (const k of ENV_KEYS) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
  }
  return seen;
}

test('action-entry: review-provider / reply-provider inputs set the LLM provider env vars', async () => {
  const seen = await runWithInputs({ 'review-provider': 'modelstack', 'reply-provider': 'deepseek' });
  assert.deepEqual(seen, { review: 'modelstack', reply: 'deepseek' });
});

test('action-entry: empty provider inputs leave the LLM provider env vars unset (config wins)', async () => {
  const seen = await runWithInputs({ 'review-provider': '', 'reply-provider': '' });
  assert.deepEqual(seen, { review: undefined, reply: undefined });
});

test('action-entry: openrouter-api-key input is masked and exported as OPENROUTER_API_KEY', async () => {
  const seen = await runWithInputs({ 'openrouter-api-key': 'or-secret', 'review-provider': 'openrouter' });
  assert.deepEqual(seen, { review: 'openrouter', reply: undefined });
  assert.equal(last.openrouterKey, 'or-secret');
  assert.ok(last.secrets.includes('or-secret'));
});
