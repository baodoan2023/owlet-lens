// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLLMProvider, makeLLMProvider, KNOWN_LLM_PROVIDERS } = require('../../lib/llm/index.js');
const { ConfigError } = require('../../lib/errors.js');

test('detectLLMProvider: env wins over config', () => {
  const p = detectLLMProvider({
    env: { AI_REVIEW_LLM_PROVIDER: 'gemini' },
    configValue: 'anthropic',
    kind: 'review',
  });
  assert.equal(p, 'gemini');
});

test('detectLLMProvider: config when env absent', () => {
  const p = detectLLMProvider({ env: {}, configValue: 'deepseek', kind: 'review' });
  assert.equal(p, 'deepseek');
});

test('detectLLMProvider: default anthropic when both absent', () => {
  const p = detectLLMProvider({ env: {}, configValue: undefined, kind: 'review' });
  assert.equal(p, 'anthropic');
});

test('detectLLMProvider: unknown name throws ConfigError', () => {
  assert.throws(
    () => detectLLMProvider({ env: { AI_REVIEW_LLM_PROVIDER: 'fake' }, configValue: undefined, kind: 'review' }),
    ConfigError,
  );
});

test('detectLLMProvider: reply uses AI_REPLY_LLM_PROVIDER env', () => {
  const p = detectLLMProvider({
    env: { AI_REPLY_LLM_PROVIDER: 'deepseek', AI_REVIEW_LLM_PROVIDER: 'gemini' },
    configValue: 'anthropic',
    kind: 'reply',
  });
  assert.equal(p, 'deepseek');
});

test('makeLLMProvider: anthropic returns adapter with .call', () => {
  const p = makeLLMProvider('anthropic', {
    config: {
      auth: { anthropicKey: 'k', geminiKey: null, deepseekKey: null },
      review: { model: 'claude-opus-4-7' },
      reply: { model: 'claude-haiku-4-5-20251001' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(typeof p.call, 'function');
});

test('makeLLMProvider: gemini returns adapter', () => {
  const p = makeLLMProvider('gemini', {
    config: {
      auth: { anthropicKey: null, geminiKey: 'gk', deepseekKey: null },
      review: { model: 'gemini-2.5-pro' },
      reply: { model: 'gemini-2.5-flash' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(typeof p.call, 'function');
});

test('makeLLMProvider: deepseek returns adapter', () => {
  const p = makeLLMProvider('deepseek', {
    config: {
      auth: { anthropicKey: null, geminiKey: null, deepseekKey: 'dk' },
      review: { model: 'deepseek-chat' },
      reply: { model: 'deepseek-chat' },
      pricing: {},
    },
    kind: 'reply',
  });
  assert.equal(typeof p.call, 'function');
});

test('makeLLMProvider: unknown name throws ConfigError', () => {
  assert.throws(
    () => makeLLMProvider('fake', {
      config: { auth: {}, review: {}, reply: {}, pricing: {} },
      kind: 'review',
    }),
    ConfigError,
  );
});

test('KNOWN_LLM_PROVIDERS list', () => {
  assert.deepEqual([...KNOWN_LLM_PROVIDERS].sort(), ['anthropic', 'deepseek', 'gemini', 'modelstack', 'openai', 'openrouter']);
});

test('detectLLMProvider: accepts modelstack from config', () => {
  const p = detectLLMProvider({ env: {}, configValue: 'modelstack', kind: 'review' });
  assert.equal(p, 'modelstack');
});

test('makeLLMProvider: modelstack returns adapter', () => {
  const p = makeLLMProvider('modelstack', {
    config: {
      auth: { anthropicKey: null, geminiKey: null, deepseekKey: null, modelstackKey: 'mk' },
      review: { model: 'gpt-4o' },
      reply: { model: 'gpt-4o-mini' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(typeof p.call, 'function');
});

test('makeLLMProvider: modelstack missing key throws ConfigError', () => {
  assert.throws(
    () => makeLLMProvider('modelstack', {
      config: {
        auth: { anthropicKey: null, geminiKey: null, deepseekKey: null, modelstackKey: null },
        review: { model: 'gpt-4o' },
        reply: { model: 'gpt-4o' },
        pricing: {},
      },
      kind: 'review',
    }),
    ConfigError,
  );
});

test('empty fallbackModels returns a bare provider (has defaultModel, maxAttempts 3)', () => {
  const p = makeLLMProvider('modelstack', {
    config: {
      auth: { anthropicKey: null, geminiKey: null, deepseekKey: null, modelstackKey: 'k-test' },
      review: { model: 'gemini-3.1-pro', fallbackModels: [] },
      reply: { model: 'gemini-3.1-pro' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.strictEqual(p.maxAttempts, 3);          // BaseLLMProvider default — not wrapped
  assert.strictEqual(p.defaultModel, 'gemini-3.1-pro');
});

test('non-empty fallbackModels returns a wrapped provider (one-try inner)', () => {
  const p = makeLLMProvider('modelstack', {
    config: {
      auth: { anthropicKey: null, geminiKey: null, deepseekKey: null, modelstackKey: 'k-test' },
      review: { model: 'gemini-3.1-pro', fallbackModels: ['deepseek-v3.2'] },
      reply: { model: 'gemini-3.1-pro' },
      pricing: {},
    },
    kind: 'review',
  });
  // Wrapper exposes only { call } — no provider fields leak through.
  assert.strictEqual(typeof p.call, 'function');
  assert.strictEqual(p.defaultModel, undefined);
  assert.strictEqual(p.maxAttempts, undefined);
});

test('primary duplicated in fallbackModels dedupes to a bare provider', () => {
  const p = makeLLMProvider('modelstack', {
    config: {
      auth: { anthropicKey: null, geminiKey: null, deepseekKey: null, modelstackKey: 'k-test' },
      review: { model: 'gemini-3.1-pro', fallbackModels: ['gemini-3.1-pro'] },
      reply: { model: 'gemini-3.1-pro' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.strictEqual(p.maxAttempts, 3); // [gemini, gemini] -> [gemini] -> not wrapped
});

test('makeLLMProvider: apiBaseUrl from config is passed to the provider', () => {
  const p = makeLLMProvider('anthropic', {
    config: {
      auth: { anthropicKey: 'k' },
      review: { model: 'claude-opus-4-7', apiBaseUrl: 'https://eu.api.anthropic.com/v1/messages' },
      reply: { model: 'claude-haiku-4-5-20251001' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(p.apiBaseUrl, 'https://eu.api.anthropic.com/v1/messages');
});

test('makeLLMProvider: apiBaseUrl defaults to null when not set', () => {
  const p = makeLLMProvider('anthropic', {
    config: {
      auth: { anthropicKey: 'k' },
      review: { model: 'claude-opus-4-7' },
      reply: { model: 'claude-haiku-4-5-20251001' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(p.apiBaseUrl, null);
});

test('KNOWN_LLM_PROVIDERS includes openai', () => {
  assert.ok(KNOWN_LLM_PROVIDERS.includes('openai'));
});

test('detectLLMProvider: accepts openai from config', () => {
  const p = detectLLMProvider({ env: {}, configValue: 'openai', kind: 'review' });
  assert.equal(p, 'openai');
});

test('makeLLMProvider: openai returns adapter with .call', () => {
  const p = makeLLMProvider('openai', {
    config: {
      auth: { openaiKey: 'sk-test' },
      review: { model: 'gpt-4o', apiBaseUrl: 'https://api.openai.com/v1' },
      reply: { model: 'gpt-4o-mini' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(typeof p.call, 'function');
});

test('makeLLMProvider: openai normalizes apiBaseUrl to append /chat/completions', () => {
  const p = makeLLMProvider('openai', {
    config: {
      auth: { openaiKey: 'sk-test' },
      review: { model: 'gpt-4o', apiBaseUrl: 'https://api.openai.com/v1' },
      reply: { model: 'gpt-4o-mini' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(p.apiUrl, 'https://api.openai.com/v1/chat/completions');
});

test('makeLLMProvider: openai keeps apiBaseUrl if already ends with /chat/completions', () => {
  const p = makeLLMProvider('openai', {
    config: {
      auth: { openaiKey: 'sk-test' },
      review: { model: 'gpt-4o', apiBaseUrl: 'https://api.openai.com/v1/chat/completions' },
      reply: { model: 'gpt-4o-mini' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(p.apiUrl, 'https://api.openai.com/v1/chat/completions');
});

test('makeLLMProvider: openai defaults to api.openai.com when no apiBaseUrl', () => {
  const p = makeLLMProvider('openai', {
    config: {
      auth: { openaiKey: 'sk-test' },
      review: { model: 'gpt-4o' },
      reply: { model: 'gpt-4o-mini' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(p.apiUrl, 'https://api.openai.com/v1/chat/completions');
});

test('makeLLMProvider: openai allows empty string key (Ollama)', () => {
  const p = makeLLMProvider('openai', {
    config: {
      auth: { openaiKey: '' },
      review: { model: 'llama3', apiBaseUrl: 'http://localhost:11434/v1' },
      reply: { model: 'llama3' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(typeof p.call, 'function');
});

test('makeLLMProvider: openai rejects non-string key', () => {
  assert.throws(
    () => makeLLMProvider('openai', {
      config: {
        auth: { openaiKey: null },
        review: { model: 'gpt-4o' },
        reply: { model: 'gpt-4o-mini' },
        pricing: {},
      },
      kind: 'review',
    }),
    ConfigError,
  );
});

test('makeLLMProvider: openai strips trailing slashes from apiBaseUrl', () => {
  const p = makeLLMProvider('openai', {
    config: {
      auth: { openaiKey: 'sk-test' },
      review: { model: 'gpt-4o', apiBaseUrl: 'https://openrouter.ai/api/v1/' },
      reply: { model: 'gpt-4o-mini' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(p.apiUrl, 'https://openrouter.ai/api/v1/chat/completions');
});

test('makeLLMProvider: openrouter returns an adapter carrying the routing config', () => {
  const routing = { dataCollection: 'deny', zdr: false, models: { 'a/b': { only: ['x'] } } };
  const p = makeLLMProvider('openrouter', {
    config: {
      auth: { openrouterKey: 'or-k' },
      review: { model: 'a/b' },
      reply: { model: 'a/b' },
      pricing: {},
      openrouter: routing,
    },
    kind: 'review',
  });
  assert.equal(typeof p.call, 'function');
  assert.equal(p.providerName, 'openrouter');
  assert.deepEqual(p.routing, routing);
});

test('makeLLMProvider: openrouter missing key throws ConfigError', () => {
  assert.throws(
    () => makeLLMProvider('openrouter', {
      config: { auth: { openrouterKey: null }, review: { model: 'a/b' }, reply: { model: 'a/b' }, pricing: {} },
      kind: 'review',
    }),
    (e) => e instanceof ConfigError && /openrouterKey/.test(e.message),
  );
});

test('detectLLMProvider: accepts openrouter from env', () => {
  const p = detectLLMProvider({ env: { AI_REPLY_LLM_PROVIDER: 'openrouter' }, configValue: undefined, kind: 'reply' });
  assert.equal(p, 'openrouter');
});

// --- Cross-provider fallback (ADR-0021) ---

const { AnthropicProvider } = require('../../lib/llm/anthropic.js');
const { DeepSeekProvider } = require('../../lib/llm/deepseek.js');

function crossConfig(overrides = {}) {
  return {
    auth: { anthropicKey: 'ak', deepseekKey: 'dk', ...(overrides.auth ?? {}) },
    review: { model: 'deepseek-v4-pro', fallbackModels: ['anthropic:claude-sonnet-5-5'], ...(overrides.review ?? {}) },
    reply: { model: 'deepseek-flash' },
    pricing: {},
  };
}

test('cross-provider fallback: chain holds one adapter per provider, each one-try', () => {
  const p = makeLLMProvider('deepseek', { config: crossConfig(), kind: 'review' });
  assert.deepEqual(p.chain.map((t) => [t.providerName, t.model]), [
    ['deepseek', 'deepseek-v4-pro'],
    ['anthropic', 'claude-sonnet-5-5'],
  ]);
  assert.ok(p.chain[0].provider instanceof DeepSeekProvider);
  assert.ok(p.chain[1].provider instanceof AnthropicProvider);
  assert.equal(p.chain[0].provider.maxAttempts, 1);
  assert.equal(p.chain[1].provider.maxAttempts, 1);
  assert.equal(p.chain[1].provider.defaultModel, 'claude-sonnet-5-5');
});

test('cross-provider fallback: same-provider entries share one adapter', () => {
  const p = makeLLMProvider('deepseek', {
    config: crossConfig({ review: { fallbackModels: ['deepseek-flash', 'anthropic:claude-sonnet-5-5'] } }),
    kind: 'review',
  });
  assert.equal(p.chain.length, 3);
  assert.strictEqual(p.chain[0].provider, p.chain[1].provider);
});

test('cross-provider fallback: missing key for the fallback provider throws ConfigError', () => {
  assert.throws(
    () => makeLLMProvider('deepseek', { config: crossConfig({ auth: { anthropicKey: null } }), kind: 'review' }),
    (e) => e instanceof ConfigError && /anthropicKey/.test(e.message),
  );
});

test('cross-provider fallback: apiBaseUrl applies to the primary provider only', () => {
  const p = makeLLMProvider('anthropic', {
    config: {
      auth: { anthropicKey: 'ak', deepseekKey: 'dk' },
      review: { model: 'claude-opus-5-5', apiBaseUrl: 'https://eu.api.anthropic.com/v1/messages', fallbackModels: ['deepseek:deepseek-v4-pro'] },
      reply: { model: 'x' },
      pricing: {},
    },
    kind: 'review',
  });
  assert.equal(p.chain[0].provider.apiBaseUrl, 'https://eu.api.anthropic.com/v1/messages');
  assert.notEqual(p.chain[1].provider.apiUrl ?? p.chain[1].provider.apiBaseUrl, 'https://eu.api.anthropic.com/v1/messages');
});

test('cross-provider fallback: prefix naming the primary provider dedupes against the primary', () => {
  const p = makeLLMProvider('deepseek', {
    config: crossConfig({ review: { fallbackModels: ['deepseek:deepseek-v4-pro'] } }),
    kind: 'review',
  });
  assert.equal(p.chain, undefined, 'single-target chain is returned unwrapped');
  assert.equal(p.maxAttempts, 3);
});

test('cross-provider fallback: openai fallback rejects an empty key (it always targets api.openai.com)', () => {
  assert.throws(
    () => makeLLMProvider('deepseek', {
      config: crossConfig({ auth: { openaiKey: '' }, review: { fallbackModels: ['openai:gpt-4o'] } }),
      kind: 'review',
    }),
    (e) => e instanceof ConfigError && /openaiKey/.test(e.message),
  );
});
