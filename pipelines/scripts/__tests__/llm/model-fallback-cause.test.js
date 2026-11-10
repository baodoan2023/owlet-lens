'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wrapModelFallback } = require('../../lib/llm/model-fallback.js');

test('failover log carries the network root cause code', async () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' });
  const provider = {
    async call(_s, _u, { model }) {
      if (model === 'a') throw new TypeError('fetch failed', { cause });
      return { text: 'ok', model };
    },
  };
  const logs = [];
  const llm = wrapModelFallback(
    [{ providerName: 'p', model: 'a', provider }, { providerName: 'p', model: 'b', provider }],
    (l) => logs.push(l),
  );
  await llm.call('s', 'u');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].errCode, 'ENOTFOUND');
  assert.match(logs[0].errCause, /ENOTFOUND/);
});
