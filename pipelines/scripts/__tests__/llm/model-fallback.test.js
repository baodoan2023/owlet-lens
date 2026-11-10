// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { wrapModelFallback, nextTargetIndex } = require('../../lib/llm/model-fallback.js');
const { ProviderError, AuthError, LLMError } = require('../../lib/errors.js');

// Fake provider: scripts a result/throw per model id. Records calls into the
// shared `calls` log as `provider/model` so cross-provider order is visible.
function fakeProvider(name, byModel, calls, extra = {}) {
  return {
    ...extra,
    async call(_sys, _user, opts) {
      calls.push(`${name}/${opts.model}`);
      const outcome = byModel[opts.model];
      if (typeof outcome === 'function') return outcome(opts);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

/** Same-provider chain over one fake, the shape index.js builds for bare ids. */
function sameProviderChain(byModel, models, extra = {}) {
  const calls = [];
  const provider = fakeProvider('p', byModel, calls, extra);
  const targets = models.map((model) => ({ providerName: 'p', model, provider }));
  return { calls, targets };
}

function silentLog() { /* swallow */ }

const ok = (text) => ({ text, usage: {}, cost: {} });

test('primary succeeds — fallback never called', async () => {
  const { calls, targets } = sameProviderChain({ A: ok('ok') }, ['A', 'B']);
  const r = await wrapModelFallback(targets, silentLog).call('s', 'u', {});
  assert.strictEqual(r.text, 'ok');
  assert.deepStrictEqual(calls, ['p/A']);
});

test('502 on primary fails over to next model and logs the hop', async () => {
  const { calls, targets } = sameProviderChain({
    A: new ProviderError('ModelStack 502', { provider: 'modelstack', status: 502, retryable: true }),
    B: ok('from-B'),
  }, ['A', 'B']);
  const logs = [];
  const r = await wrapModelFallback(targets, (e) => logs.push(e)).call('s', 'u', {});
  assert.strictEqual(r.text, 'from-B');
  assert.deepStrictEqual(calls, ['p/A', 'p/B']);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].fromModel, 'A');
  assert.strictEqual(logs[0].toModel, 'B');
  assert.strictEqual(logs[0].fromProvider, 'p');
  assert.strictEqual(logs[0].toProvider, 'p');
});

test('non-retryable error (400) now fails over too', async () => {
  const { calls, targets } = sameProviderChain({
    A: new LLMError('LLM 400: context too long'),
    B: ok('from-B'),
  }, ['A', 'B']);
  const r = await wrapModelFallback(targets, silentLog).call('s', 'u', {});
  assert.strictEqual(r.text, 'from-B');
  assert.deepStrictEqual(calls, ['p/A', 'p/B']);
});

test('all models fail — throws last error, type preserved', async () => {
  const errB = new ProviderError('ModelStack 502 B', { provider: 'modelstack', status: 502, retryable: true });
  const { calls, targets } = sameProviderChain({
    A: new ProviderError('ModelStack 502 A', { provider: 'modelstack', status: 502, retryable: true }),
    B: errB,
  }, ['A', 'B']);
  await assert.rejects(() => wrapModelFallback(targets, silentLog).call('s', 'u', {}), (e) => {
    assert.strictEqual(e, errB);
    assert.ok(e instanceof ProviderError);
    return true;
  });
  assert.deepStrictEqual(calls, ['p/A', 'p/B']);
});

test('auth error skips the rest of that provider — same key fails the same way', async () => {
  const { calls, targets } = sameProviderChain({
    A: new AuthError('ModelStack 401', { provider: 'modelstack', status: 401 }),
    B: ok('from-B'),
  }, ['A', 'B']);
  await assert.rejects(() => wrapModelFallback(targets, silentLog).call('s', 'u', {}), (e) => e instanceof AuthError);
  assert.deepStrictEqual(calls, ['p/A']);
});

test('auth error on one provider still fails over to another provider', async () => {
  const calls = [];
  const ds = fakeProvider('deepseek', { D1: new AuthError('DeepSeek 401', { provider: 'deepseek', status: 401 }), D2: ok('never') }, calls);
  const an = fakeProvider('anthropic', { C: ok('from-anthropic') }, calls);
  const targets = [
    { providerName: 'deepseek', model: 'D1', provider: ds },
    { providerName: 'deepseek', model: 'D2', provider: ds },
    { providerName: 'anthropic', model: 'C', provider: an },
  ];
  const r = await wrapModelFallback(targets, silentLog).call('s', 'u', {});
  assert.strictEqual(r.text, 'from-anthropic');
  assert.deepStrictEqual(calls, ['deepseek/D1', 'anthropic/C']);
});

test('cross-provider: each target is called on its own provider with its own model', async () => {
  const calls = [];
  const ds = fakeProvider('deepseek', { D: new ProviderError('DeepSeek 503', { provider: 'deepseek', status: 503, retryable: true }) }, calls);
  const an = fakeProvider('anthropic', { C: ok('from-anthropic') }, calls);
  const r = await wrapModelFallback([
    { providerName: 'deepseek', model: 'D', provider: ds },
    { providerName: 'anthropic', model: 'C', provider: an },
  ], silentLog).call('s', 'u', { model: 'IGNORED' });
  assert.strictEqual(r.text, 'from-anthropic');
  assert.deepStrictEqual(calls, ['deepseek/D', 'anthropic/C']);
});

test('opts.model is overridden per attempt; other opts pass through', async () => {
  let seenOpts;
  const provider = { async call(_s, _u, opts) { seenOpts = opts; return ok('ok'); } };
  const w = wrapModelFallback([{ providerName: 'p', model: 'A', provider }, { providerName: 'p', model: 'B', provider }], silentLog);
  await w.call('s', 'u', { maxTokens: 1234, responseFormat: 'json', model: 'IGNORED' });
  assert.strictEqual(seenOpts.model, 'A');
  assert.strictEqual(seenOpts.maxTokens, 1234);
  assert.strictEqual(seenOpts.responseFormat, 'json');
});

test('single-target chain still works (no failover path)', async () => {
  const { targets } = sameProviderChain({ A: ok('solo') }, ['A']);
  const r = await wrapModelFallback(targets, silentLog).call('s', 'u', {});
  assert.strictEqual(r.text, 'solo');
});

test('wrapper forwards supportsTools from the primary target', () => {
  const t = (supportsTools) => [{ providerName: 'p', model: 'A', provider: { supportsTools, async call() { return ok('ok'); } } }];
  assert.strictEqual(wrapModelFallback(t(true), silentLog).supportsTools, true);
  assert.strictEqual(wrapModelFallback(t(false), silentLog).supportsTools, false);
  const w = wrapModelFallback(t(true), silentLog);
  // defaultModel and maxAttempts must NOT be forwarded
  assert.strictEqual(w.defaultModel, undefined);
  assert.strictEqual(w.maxAttempts, undefined);
});

test('wrapper exposes the chain, frozen, for per-attempt callers', () => {
  const { targets } = sameProviderChain({}, ['A', 'B']);
  const w = wrapModelFallback(targets, silentLog);
  assert.deepStrictEqual(w.chain.map((t) => t.model), ['A', 'B']);
  assert.ok(Object.isFrozen(w.chain));
});

test('opts.tools pass through to inner provider call', async () => {
  let capturedOpts;
  const tools = [{ name: 'submit_findings', input_schema: {} }];
  const provider = { supportsTools: true, async call(_s, _u, opts) { capturedOpts = opts; return ok('ok'); } };
  await wrapModelFallback([{ providerName: 'p', model: 'A', provider }], silentLog).call('s', 'u', { tools });
  assert.deepStrictEqual(capturedOpts.tools, tools, 'opts.tools must pass through to inner provider');
});

test('nextTargetIndex: next entry, -1 at end, auth skips same provider', () => {
  const chain = [
    { providerName: 'a', model: '1' },
    { providerName: 'a', model: '2' },
    { providerName: 'b', model: '3' },
  ];
  const plain = new Error('boom');
  const auth = new AuthError('401', { provider: 'a', status: 401 });
  assert.strictEqual(nextTargetIndex(chain, 0, plain), 1);
  assert.strictEqual(nextTargetIndex(chain, 2, plain), -1);
  assert.strictEqual(nextTargetIndex(chain, 0, auth), 2);
  assert.strictEqual(nextTargetIndex(chain, 2, auth), -1);
  assert.strictEqual(nextTargetIndex(chain, 0, null), 1, 'no error (bad output) just moves on');
});

test('terminal error stops the chain — no failover (ADR-0020 routing errors)', async () => {
  const err = new LLMError('OpenRouter 404 (no provider is eligible)', { terminal: true });
  const { calls, targets } = sameProviderChain({ A: err, B: ok('from-B') }, ['A', 'B']);
  await assert.rejects(() => wrapModelFallback(targets, silentLog).call('s', 'u', {}), (e) => e === err);
  assert.deepStrictEqual(calls, ['p/A']);
  assert.strictEqual(nextTargetIndex([{ providerName: 'a' }, { providerName: 'b' }], 0, err), -1);
});
