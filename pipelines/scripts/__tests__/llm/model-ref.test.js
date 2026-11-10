// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseModelRef, buildModelChain, KNOWN_LLM_PROVIDERS } = require('../../lib/llm/model-ref.js');
const { ConfigError } = require('../../lib/errors.js');

test('parseModelRef: bare id keeps the default provider', () => {
  assert.deepEqual(parseModelRef('deepseek-v4-pro', 'deepseek'), { providerName: 'deepseek', model: 'deepseek-v4-pro' });
});

test('parseModelRef: known provider prefix switches provider', () => {
  assert.deepEqual(parseModelRef('anthropic:claude-sonnet-5-5', 'deepseek'), { providerName: 'anthropic', model: 'claude-sonnet-5-5' });
});

test('parseModelRef: colon in a model id is not a provider prefix', () => {
  // OpenRouter variants and Ollama tags carry colons in the model id itself.
  assert.deepEqual(parseModelRef('meta-llama/llama-3-8b:free', 'openrouter'), { providerName: 'openrouter', model: 'meta-llama/llama-3-8b:free' });
  assert.deepEqual(parseModelRef('llama3:8b', 'openai'), { providerName: 'openai', model: 'llama3:8b' });
});

test('parseModelRef: only the first colon splits a prefixed entry', () => {
  assert.deepEqual(parseModelRef('openrouter:meta-llama/llama-3-8b:free', 'anthropic'), { providerName: 'openrouter', model: 'meta-llama/llama-3-8b:free' });
});

test('parseModelRef: trims whitespace', () => {
  assert.deepEqual(parseModelRef('  anthropic: claude-sonnet-5-5 ', 'deepseek'), { providerName: 'anthropic', model: 'claude-sonnet-5-5' });
});

test('parseModelRef: empty entry or empty model after prefix throws ConfigError', () => {
  assert.throws(() => parseModelRef('', 'anthropic'), ConfigError);
  assert.throws(() => parseModelRef('   ', 'anthropic'), ConfigError);
  assert.throws(() => parseModelRef('anthropic:', 'deepseek'), ConfigError);
  assert.throws(() => parseModelRef('anthropic:  ', 'deepseek'), ConfigError);
});

test('buildModelChain: primary first, fallbacks in order', () => {
  assert.deepEqual(buildModelChain('deepseek', 'deepseek-v4-pro', ['deepseek-flash', 'anthropic:claude-sonnet-5-5']), [
    { providerName: 'deepseek', model: 'deepseek-v4-pro' },
    { providerName: 'deepseek', model: 'deepseek-flash' },
    { providerName: 'anthropic', model: 'claude-sonnet-5-5' },
  ]);
});

test('buildModelChain: dedupes by provider + model, prefix-equivalent included', () => {
  assert.deepEqual(buildModelChain('anthropic', 'claude-a', ['claude-a', 'anthropic:claude-a', 'gemini:claude-a']), [
    { providerName: 'anthropic', model: 'claude-a' },
    { providerName: 'gemini', model: 'claude-a' },
  ]);
});

test('buildModelChain: missing fallback list gives the primary alone', () => {
  assert.deepEqual(buildModelChain('gemini', 'g', undefined), [{ providerName: 'gemini', model: 'g' }]);
});

test('KNOWN_LLM_PROVIDERS is frozen and lists every adapter', () => {
  assert.ok(Object.isFrozen(KNOWN_LLM_PROVIDERS));
  assert.deepEqual([...KNOWN_LLM_PROVIDERS].sort(), ['anthropic', 'deepseek', 'gemini', 'modelstack', 'openai', 'openrouter']);
});

test('parseModelRef: own-provider prefix keeps a provider-looking id on that provider', () => {
  // Escape hatch for gateway ids such as ModelStack's `anthropic:claude-x`.
  assert.deepEqual(parseModelRef('modelstack:anthropic:claude-x', 'modelstack'), { providerName: 'modelstack', model: 'anthropic:claude-x' });
});
