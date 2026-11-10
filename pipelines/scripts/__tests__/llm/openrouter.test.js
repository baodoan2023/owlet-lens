// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenRouterProvider } = require('../../lib/llm/openrouter.js');
const { ProviderError, LLMError } = require('../../lib/errors.js');
const { validateOpenRouterConfig } = require('../../lib/openrouter-config.js');

const enc = new TextEncoder();

/**
 * @param {string[]} parts
 * @param {{ status?: number }} [opts]
 */
function sseResponse(parts, { status = 200 } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * OpenRouter-shaped stream: content chunks, then the usage chunk that repeats
 * finish_reason, then [DONE].
 * @param {string[]} pieces
 * @param {Record<string, unknown>} [usage]
 */
function sseSuccess(pieces, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  const parts = [': OPENROUTER PROCESSING\n\n'];
  for (const c of pieces) parts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  parts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage })}\n\n`);
  parts.push('data: [DONE]\n\n');
  return parts;
}

/**
 * Capture the request of one call.
 * @param {import('node:test').TestContext} t
 * @param {() => Response} [respond]
 * @returns {{ seen: { url?: string, headers?: Record<string, string>, body?: any } }}
 */
function captureFetch(t, respond = () => sseResponse(sseSuccess(['ok']))) {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  /** @type {{ url?: string, headers?: Record<string, string>, body?: any }} */
  const seen = {};
  globalThis.fetch = async (url, init) => {
    seen.url = String(url);
    seen.headers = /** @type {Record<string, string>} */ (init?.headers);
    seen.body = JSON.parse(String(init?.body));
    return respond();
  };
  return { seen };
}

/** @param {Record<string, unknown>} [extra] */
function make(extra = {}) {
  return new OpenRouterProvider({ apiKey: 'or-k', defaultModel: 'z-ai/glm-5.3-flash', pricingOverride: {}, maxAttempts: 1, ...extra });
}

test('openrouter: default URL, bearer auth and attribution headers', async (t) => {
  const { seen } = captureFetch(t);
  const r = await make().call('sys', 'usr');
  assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen.headers?.Authorization, 'Bearer or-k');
  assert.equal(seen.headers?.['X-Title'], 'Owlet Lens');
  assert.equal(seen.headers?.['HTTP-Referer'], 'https://github.com/openwt-vn/owlet-lens');
  assert.equal(r.text, 'ok');
  assert.equal(r.model, 'z-ai/glm-5.3-flash');
});

test('openrouter: apiBaseUrl is normalized to the chat completions path', async (t) => {
  const { seen } = captureFetch(t);
  await make({ apiBaseUrl: 'https://gw.example.com/api/v1/' }).call('sys', 'usr');
  assert.equal(seen.url, 'https://gw.example.com/api/v1/chat/completions');
});

test('openrouter: with no routing config, sends data_collection deny only', async (t) => {
  const { seen } = captureFetch(t);
  await make().call('sys', 'usr');
  assert.deepEqual(seen.body.provider, { data_collection: 'deny' });
  assert.equal(seen.body.reasoning, undefined);
  assert.equal(seen.body.max_tokens, 32000); // DEFAULT_MAX_TOKENS under the 64k cap
});

test('openrouter: per-model routing overrides global and maps to snake_case', async (t) => {
  const { seen } = captureFetch(t);
  const routing = validateOpenRouterConfig({
    dataCollection: 'deny',
    zdr: true,
    models: {
      'z-ai/glm-5.3-flash': {
        only: ['open-inference/fp4'],
        ignore: ['deepinfra'],
        order: ['a', 'b'],
        quantizations: ['fp4'],
        allowFallbacks: false,
        dataCollection: 'allow',
        sort: 'latency',
        reasoning: { enabled: true, effort: 'low', maxTokens: 2000 },
      },
    },
  });
  await make({ routing }).call('sys', 'usr');
  assert.deepEqual(seen.body.provider, {
    data_collection: 'allow',
    zdr: true,
    only: ['open-inference/fp4'],
    ignore: ['deepinfra'],
    order: ['a', 'b'],
    quantizations: ['fp4'],
    allow_fallbacks: false,
    sort: 'latency',
  });
  assert.deepEqual(seen.body.reasoning, { enabled: true, effort: 'low', max_tokens: 2000 });
});

test('openrouter: routing follows the model being called (failover model gets its own pin)', async (t) => {
  const { seen } = captureFetch(t);
  const routing = validateOpenRouterConfig({
    models: { 'qwen/qwen3-coder': { order: ['cerebras'] }, 'z-ai/glm-5.3-flash': { only: ['x'] } },
  });
  await make({ routing }).call('sys', 'usr', { model: 'qwen/qwen3-coder' });
  assert.equal(seen.body.model, 'qwen/qwen3-coder');
  assert.deepEqual(seen.body.provider, { data_collection: 'deny', order: ['cerebras'] });
});

test('openrouter: JSON mode adds require_parameters', async (t) => {
  const { seen } = captureFetch(t);
  await make().call('sys', 'usr', { responseFormat: 'json' });
  assert.deepEqual(seen.body.response_format, { type: 'json_object' });
  assert.deepEqual(seen.body.provider, { data_collection: 'deny', require_parameters: true });
});

test('openrouter: max_tokens is capped at 64000 or the per-model maxOutputTokens', async (t) => {
  const { seen } = captureFetch(t);
  await make().call('sys', 'usr', { maxTokens: 200_000 });
  assert.equal(seen.body.max_tokens, 64_000);
  const routing = validateOpenRouterConfig({ models: { 'z-ai/glm-5.3-flash': { maxOutputTokens: 8000 } } });
  await make({ routing }).call('sys', 'usr', { maxTokens: 200_000 });
  assert.equal(seen.body.max_tokens, 8000);
});

test('openrouter: a per-model maxOutputTokens above the 64k default is honored', async (t) => {
  const { seen } = captureFetch(t);
  const routing = validateOpenRouterConfig({ models: { 'z-ai/glm-5.3-flash': { maxOutputTokens: 128_000 } } });
  await make({ routing }).call('sys', 'usr', { maxTokens: 200_000 });
  assert.equal(seen.body.max_tokens, 128_000);
});

test('openrouter: reasoning deltas are ignored, only content is kept', async (t) => {
  captureFetch(t, () => sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'thinking...' } }] })}\n\n`,
    ...sseSuccess(['{"findings":[]}']),
  ]));
  const r = await make().call('sys', 'usr');
  assert.equal(r.text, '{"findings":[]}');
});

test('openrouter: cost comes from usage.cost when no pricing override', async (t) => {
  captureFetch(t, () => sseResponse(sseSuccess(['ok'], { prompt_tokens: 1000, completion_tokens: 100, cost: 0.00123 })));
  const r = await make().call('sys', 'usr');
  assert.equal(r.cost.priced, true);
  assert.equal(r.cost.totalCost, 0.00123);
  assert.equal(r.cost.inputCost, 0);
  assert.equal(r.cost.outputCost, 0);
  assert.equal(r.usage.inputTokens, 1000);
});

test('openrouter: a pricing override beats usage.cost', async (t) => {
  captureFetch(t, () => sseResponse(sseSuccess(['ok'], { prompt_tokens: 1_000_000, completion_tokens: 0, cost: 9 })));
  const pricingOverride = { 'z-ai/glm-5.3-flash': { inputPerMTok: 2, outputPerMTok: 4 } };
  const r = await make({ pricingOverride }).call('sys', 'usr');
  assert.equal(r.cost.totalCost, 2);
  assert.equal(r.cost.inputCost, 2);
});

test('openrouter: no usage.cost and no override reports unpriced', async (t) => {
  captureFetch(t);
  const r = await make().call('sys', 'usr');
  assert.equal(r.cost.priced, false);
  assert.equal(r.cost.totalCost, 0);
});

test('openrouter: HTTP 404 is terminal and points at the routing entry', async (t) => {
  let calls = 0;
  captureFetch(t, () => {
    calls += 1;
    return new Response('{"error":{"code":404,"message":"No endpoints found matching your data policy"}}', { status: 404 });
  });
  await assert.rejects(make({ maxAttempts: 3 }).call('sys', 'usr'), (e) => {
    assert.ok(e instanceof LLMError);
    assert.match(e.message, /No endpoints found/);
    assert.match(e.message, /openrouter\.models\["z-ai\/glm-5\.3-flash"\]/);
    assert.equal(e.terminal, true, 'routing failure must not fail over (ADR-0020)');
    return true;
  });
  assert.equal(calls, 1);
});

test('openrouter: HTTP 400 context_length_exceeded names maxOutputTokens', async (t) => {
  captureFetch(t, () => new Response(
    '{"error":{"code":400,"message":"too long","metadata":{"error_type":"context_length_exceeded"}}}',
    { status: 400 },
  ));
  await assert.rejects(make().call('sys', 'usr'), (e) => {
    assert.ok(e instanceof LLMError);
    assert.match(e.message, /maxOutputTokens/);
    assert.equal(e.terminal, true);
    return true;
  });
});

test('openrouter: HTTP 400 without a known cause is a plain LLMError', async (t) => {
  captureFetch(t, () => new Response('{"error":{"code":400,"message":"bad param"}}', { status: 400 }));
  await assert.rejects(make().call('sys', 'usr'), (e) => {
    assert.ok(e instanceof LLMError);
    assert.match(e.message, /bad param/);
    assert.doesNotMatch(e.message, /openrouter\.models/);
    assert.equal(e.terminal, false, 'a plain 400 may fail over (ADR-0021)');
    return true;
  });
});

test('openrouter: in-stream no-endpoint error is terminal with the routing hint', async (t) => {
  captureFetch(t, () => sseResponse([`data: ${JSON.stringify({
    error: { code: 404, message: 'No allowed providers are available for the selected model' },
    choices: [{ delta: { content: '' }, finish_reason: 'error' }],
  })}\n\n`]));
  await assert.rejects(make().call('sys', 'usr'), (e) => {
    assert.ok(e instanceof LLMError);
    assert.match(e.message, /openrouter\.models\["z-ai\/glm-5\.3-flash"\]/);
    assert.equal(e.terminal, true);
    return true;
  });
});

test('openrouter: in-stream context_length_exceeded names maxOutputTokens', async (t) => {
  captureFetch(t, () => sseResponse([`data: ${JSON.stringify({
    error: { code: 400, message: 'too long', metadata: { error_type: 'context_length_exceeded' } },
    choices: [{ delta: { content: '' }, finish_reason: 'error' }],
  })}\n\n`]));
  await assert.rejects(make().call('sys', 'usr'), /maxOutputTokens/);
});

test('openrouter: in-stream 502 from a pinned provider stays retryable', async (t) => {
  captureFetch(t, () => sseResponse([`data: ${JSON.stringify({
    error: { code: 502, message: 'provider down' },
    choices: [{ delta: { content: '' }, finish_reason: 'error' }],
  })}\n\n`]));
  await assert.rejects(make().call('sys', 'usr'), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.retryable, true);
    return true;
  });
});
