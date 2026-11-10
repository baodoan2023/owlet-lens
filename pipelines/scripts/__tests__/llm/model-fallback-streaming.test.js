// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelStackProvider } = require('../../lib/llm/modelstack.js');
const { wrapModelFallback } = require('../../lib/llm/model-fallback.js');

const enc = new TextEncoder();

function sseResponse(parts, { status = 200 } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function sseSuccess(pieces, usage) {
  const parts = pieces.map((c) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  if (usage) parts.push(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`);
  parts.push('data: [DONE]\n\n');
  return parts;
}

test('failover: streaming 5xx on model A advances to model B', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  const seenModels = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seenModels.push(body.model);
    if (body.model === 'A') return new Response('upstream boom', { status: 502 });
    return sseResponse(sseSuccess(['ok'], { prompt_tokens: 1, completion_tokens: 1 }));
  };
  // maxAttempts:1 so the inner provider does not self-retry — the decorator
  // owns the cross-model loop, exactly as index.js wires it.
  const inner = new ModelStackProvider({ apiKey: 'k', defaultModel: 'A', pricingOverride: {}, maxAttempts: 1 });
  const wrapped = wrapModelFallback(
    [{ providerName: 'modelstack', model: 'A', provider: inner }, { providerName: 'modelstack', model: 'B', provider: inner }],
    () => {},
  );
  const r = await wrapped.call('sys', 'usr');
  assert.deepEqual(seenModels, ['A', 'B']);
  assert.equal(r.text, 'ok');
  assert.equal(r.model, 'B');
});
