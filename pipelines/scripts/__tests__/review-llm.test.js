// @ts-check
'use strict';

// callForFindings over a model chain (ADR-0021): any failed attempt — an
// error, an empty answer, or no findings JSON — moves to the next model, with
// the stricter prompt. A single-model provider keeps the old behaviour: one
// stricter re-prompt on the same model, errors thrown.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { callForFindings } = require('../lib/review-llm.js');
const { wrapModelFallback } = require('../lib/llm/model-fallback.js');
const { AuthError, LLMError, ProviderError } = require('../lib/errors.js');

const GOOD = JSON.stringify({ summary: 's', findings: [{ file: 'a.js', line: 1, severity: 'HIGH', category: 'bug', message: 'm' }] });
const STRICT_MARK = 'respond with ONLY a single JSON object';

/**
 * Scripted adapter: each call consumes the next step (string response or
 * Error to throw) and records { provider, model, strict } into `log`.
 * @param {string} name
 * @param {Array<string|Error>} steps
 * @param {Array<object>} log
 * @param {boolean} [supportsTools]
 */
function scripted(name, steps, log, supportsTools = false) {
  let i = 0;
  return {
    supportsTools,
    /** @param {string} sys @param {string} _user @param {any} opts */
    async call(sys, _user, opts) {
      const step = steps[i++];
      log.push({ provider: name, model: opts.model, strict: sys.includes(STRICT_MARK), tools: Boolean(opts.tools) });
      if (step instanceof Error) throw step;
      return { text: step, usage: { inputTokens: 1, outputTokens: 1 }, cost: { totalCost: 0.5 }, model: opts.model };
    },
  };
}

function ctxFor(llm, events = []) {
  return {
    llm,
    model: 'primary',
    providerName: 'deepseek',
    log: (/** @type {string} */ level, /** @type {string} */ msg, /** @type {any} */ fields) => events.push({ level, msg, ...fields }),
  };
}

const quiet = () => {};

describe('callForFindings — model chain', () => {
  it('primary parses: one call, no failover', async () => {
    const log = [];
    const ds = scripted('deepseek', [GOOD], log);
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'primary', provider: ds },
      { providerName: 'anthropic', model: 'claude', provider: scripted('anthropic', [GOOD], log) },
    ], quiet);
    const r = await callForFindings('SYS', 'USER', ctxFor(llm));
    assert.equal(r.parsed?.findings.length, 1);
    assert.deepEqual(log.map((c) => c.provider), ['deepseek']);
    assert.equal(r.calls.length, 1);
  });

  it('no findings JSON on attempt 1 moves to the next model with the stricter prompt', async () => {
    const log = [];
    const events = [];
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'primary', provider: scripted('deepseek', ['sorry, no json here'], log) },
      { providerName: 'anthropic', model: 'claude', provider: scripted('anthropic', [GOOD], log) },
    ], quiet);
    const r = await callForFindings('SYS', 'USER', ctxFor(llm, events));
    assert.equal(r.parsed?.findings.length, 1);
    assert.deepEqual(log, [
      { provider: 'deepseek', model: 'primary', strict: false, tools: false },
      { provider: 'anthropic', model: 'claude', strict: true, tools: false },
    ]);
    assert.deepEqual(r.calls.map((c) => c.model), ['primary', 'claude'], 'both calls accounted for usage');
    const hop = events.find((e) => e.msg === 'llm.model.failover');
    assert.ok(hop, 'failover is logged');
    assert.equal(hop.reason, 'no-findings-json');
    assert.equal(hop.fromProvider, 'deepseek');
    assert.equal(hop.toProvider, 'anthropic');
  });

  it('empty answer on attempt 1 moves to the next model', async () => {
    const log = [];
    const events = [];
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'primary', provider: scripted('deepseek', [''], log) },
      { providerName: 'deepseek', model: 'flash', provider: scripted('deepseek', [GOOD], log) },
    ], quiet);
    const r = await callForFindings('SYS', 'USER', ctxFor(llm, events));
    assert.equal(r.parsed?.findings.length, 1);
    assert.deepEqual(log.map((c) => [c.model, c.strict]), [['primary', false], ['flash', true]]);
    assert.equal(events.find((e) => e.msg === 'llm.model.failover')?.reason, 'empty');
  });

  it('any error on attempt 1 (non-retryable 400 too) moves to the next model', async () => {
    const log = [];
    const events = [];
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'primary', provider: scripted('deepseek', [new LLMError('DeepSeek 400')], log) },
      { providerName: 'anthropic', model: 'claude', provider: scripted('anthropic', [GOOD], log) },
    ], quiet);
    const r = await callForFindings('SYS', 'USER', ctxFor(llm, events));
    assert.equal(r.parsed?.findings.length, 1);
    assert.deepEqual(log.map((c) => [c.provider, c.strict]), [['deepseek', false], ['anthropic', true]]);
    assert.equal(events.find((e) => e.msg === 'llm.model.failover')?.reason, 'error');
  });

  it('walks the whole chain, one attempt per model, stricter prompt after the first', async () => {
    const log = [];
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'a', provider: scripted('deepseek', [new ProviderError('503', { provider: 'deepseek', status: 503, retryable: true })], log) },
      { providerName: 'deepseek', model: 'b', provider: scripted('deepseek', ['junk'], log) },
      { providerName: 'anthropic', model: 'c', provider: scripted('anthropic', [GOOD], log) },
    ], quiet);
    const r = await callForFindings('SYS', 'USER', ctxFor(llm));
    assert.equal(r.parsed?.findings.length, 1);
    assert.deepEqual(log.map((c) => [c.model, c.strict]), [['a', false], ['b', true], ['c', true]]);
  });

  it('every model returns junk: parsed null, every call reported', async () => {
    const log = [];
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'a', provider: scripted('deepseek', ['junk'], log) },
      { providerName: 'anthropic', model: 'b', provider: scripted('anthropic', ['more junk'], log) },
    ], quiet);
    const r = await callForFindings('SYS', 'USER', ctxFor(llm));
    assert.equal(r.parsed, null);
    assert.equal(r.calls.length, 2);
    assert.equal(log.length, 2, 'no extra same-model retry once a chain is configured');
  });

  it('last model throws: the error propagates', async () => {
    const err = new ProviderError('529', { provider: 'anthropic', status: 529, retryable: true });
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'a', provider: scripted('deepseek', ['junk'], []) },
      { providerName: 'anthropic', model: 'b', provider: scripted('anthropic', [err], []) },
    ], quiet);
    await assert.rejects(() => callForFindings('SYS', 'USER', ctxFor(llm)), (e) => e === err);
  });

  it('auth error skips the rest of that provider and goes to the next provider', async () => {
    const log = [];
    const ds = scripted('deepseek', [new AuthError('401', { provider: 'deepseek', status: 401 }), GOOD], log);
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'a', provider: ds },
      { providerName: 'deepseek', model: 'b', provider: ds },
      { providerName: 'anthropic', model: 'c', provider: scripted('anthropic', [GOOD], log) },
    ], quiet);
    const r = await callForFindings('SYS', 'USER', ctxFor(llm));
    assert.equal(r.parsed?.findings.length, 1);
    assert.deepEqual(log.map((c) => c.model), ['a', 'c']);
  });

  it('terminal error (OpenRouter routing) throws without failover', async () => {
    const log = [];
    const err = new LLMError('OpenRouter 404 routing', { terminal: true });
    const llm = wrapModelFallback([
      { providerName: 'openrouter', model: 'a', provider: scripted('openrouter', [err], log) },
      { providerName: 'anthropic', model: 'b', provider: scripted('anthropic', [GOOD], log) },
    ], quiet);
    await assert.rejects(() => callForFindings('SYS', 'USER', ctxFor(llm)), (e) => e === err);
    assert.deepEqual(log.map((c) => c.provider), ['openrouter']);
  });

  it('a bug in our own post-processing throws at once, not as a failover', async () => {
    const log = [];
    // text that is not a string makes extractJson/snippet throw: our defect, not the model's
    const broken = { supportsTools: false, async call(_s, _u, /** @type {any} */ opts) { log.push(opts.model); return { text: 42, usage: {}, cost: {}, model: opts.model }; } };
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'a', provider: /** @type {any} */ (broken) },
      { providerName: 'anthropic', model: 'b', provider: scripted('anthropic', [GOOD], []) },
    ], quiet);
    await assert.rejects(() => callForFindings('SYS', 'USER', ctxFor(llm)), TypeError);
    assert.deepEqual(log, ['a']);
  });

  it('structured output follows each target: tools only where the adapter supports them', async () => {
    const log = [];
    const llm = wrapModelFallback([
      { providerName: 'deepseek', model: 'a', provider: scripted('deepseek', ['junk'], log, false) },
      { providerName: 'anthropic', model: 'b', provider: scripted('anthropic', [GOOD], log, true) },
    ], quiet);
    await callForFindings('SYS', 'USER', ctxFor(llm));
    assert.deepEqual(log.map((c) => c.tools), [false, true]);
  });
});

describe('callForFindings — single model (no fallback configured)', () => {
  it('no JSON: one stricter re-prompt on the same model, as before', async () => {
    const log = [];
    const r = await callForFindings('SYS', 'USER', ctxFor(scripted('deepseek', ['junk', GOOD], log)));
    assert.equal(r.parsed?.findings.length, 1);
    assert.deepEqual(log.map((c) => [c.model, c.strict]), [['primary', false], ['primary', true]]);
  });

  it('error on attempt 1 throws without a second attempt', async () => {
    const log = [];
    const err = new ProviderError('502', { provider: 'deepseek', status: 502, retryable: true });
    await assert.rejects(() => callForFindings('SYS', 'USER', ctxFor(scripted('deepseek', [err, GOOD], log))), (e) => e === err);
    assert.equal(log.length, 1);
  });
});
