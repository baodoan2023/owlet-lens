// @ts-check
'use strict';

const { AuthError } = require('../errors.js');
const { safeCause } = require('../log-safe.js');

/**
 * @typedef {{ call: (sys: string, user: string, opts?: object) => Promise<any>, supportsTools?: boolean }} LLMAdapter
 * @typedef {{ providerName: string, model: string, provider: LLMAdapter }} ChainTarget
 */

/**
 * Default failover logger: one-line JSON to stderr (no secrets in the payload).
 * @param {object} entry
 */
function defaultLog(entry) {
  process.stderr.write(JSON.stringify(entry) + '\n');
}

/**
 * Index of the target to try after `chain[i]` failed, or -1 when none is left.
 * Any failure moves on (ADR-0021), with two exceptions. A terminal error stops
 * the chain. An auth error skips the remaining targets on that provider, which
 * share its key and would fail the same way, and moves to the next provider.
 *
 * @param {ReadonlyArray<{ providerName: string }>} chain
 * @param {number} i
 * @param {unknown} err  the error, or null when the call returned bad output
 * @returns {number}
 */
function nextTargetIndex(chain, i, err) {
  // A terminal error is a configuration problem another model must not paper
  // over, e.g. an OpenRouter routing pin with no eligible provider (ADR-0020).
  if (/** @type {{ terminal?: unknown }} */ (err ?? {}).terminal === true) return -1;
  const skipProvider = err instanceof AuthError ? chain[i].providerName : null;
  for (let j = i + 1; j < chain.length; j++) {
    if (chain[j].providerName !== skipProvider) return j;
  }
  return -1;
}

/**
 * Wrap a model chain so a failed call on one target falls over to the next.
 * Targets may sit on different LLM providers (ADR-0021). Each target is tried
 * exactly once: its adapter must be built with `maxAttempts: 1` so its own
 * retry loop does not double up (ADR-0005).
 *
 * `call` walks the chain on errors. `chain` is exposed for callers that judge
 * the answer themselves and drive one attempt per target (review-llm.js).
 *
 * @param {ChainTarget[]} targets  [primary, ...fallbacks], deduped, length >= 1
 * @param {(entry: object) => void} [log]
 * @returns {{ supportsTools: boolean, chain: ReadonlyArray<ChainTarget>, call: (sys: string, user: string, opts?: object) => Promise<any> }}
 */
function wrapModelFallback(targets, log = defaultLog) {
  const chain = Object.freeze([...targets]);
  return {
    supportsTools: chain[0]?.provider.supportsTools ?? false,
    chain,
    async call(systemPrompt, userPrompt, opts = {}) {
      let lastErr;
      let i = 0;
      while (i >= 0 && i < chain.length) {
        const target = chain[i];
        try {
          return await target.provider.call(systemPrompt, userPrompt, { ...opts, model: target.model });
        } catch (err) {
          lastErr = err;
          const next = nextTargetIndex(chain, i, err);
          if (next === -1) throw err;
          // Narrow to the loose error shape we read for logging instead of an
          // `any` cast — keeps property access type-checked (no type-safety bypass).
          const e = /** @type {{ name?: string, status?: number }} */ (err);
          log({
            level: 'warn',
            msg: 'llm model failover',
            fromProvider: target.providerName,
            fromModel: target.model,
            toProvider: chain[next].providerName,
            toModel: chain[next].model,
            errName: e?.name,
            status: e?.status,
            ...safeCause(err),
          });
          i = next;
        }
      }
      throw lastErr || new Error('wrapModelFallback: empty model chain');
    },
  };
}

module.exports = { wrapModelFallback, nextTargetIndex };
