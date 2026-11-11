// @ts-check
'use strict';

// Behaviour of the review pass at its interface: diffs + threads in,
// action plan + stats + usage out. The LLM is a scripted fake; nothing else
// is mocked.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runReviewPass } = require('../lib/review-pass.js');
const { fingerprint } = require('../lib/fingerprint.js');
const { ValidationError, RateLimitError } = require('../lib/errors.js');

const META = { id: '42', title: 'T' };
const ADD2 = '@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;\n';

/**
 * Scripted LLM. Each entry is a findings array, a raw response string, an
 * Error to throw, or a function (sys, user) => one of those.
 * @param {Array<any>} script
 * @param {{ supportsTools?: boolean, model?: string, repeatLast?: boolean }} [opts]
 */
function fakeLlm(script, opts = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    supportsTools: opts.supportsTools === true,
    call: async (sys, user, callOpts) => {
      calls.push({ sys, user, opts: callOpts });
      let step = i < script.length ? script[i] : (opts.repeatLast ? script[script.length - 1] : []);
      i += 1;
      if (typeof step === 'function') step = step(sys, user);
      if (step instanceof Error) throw step;
      const text = typeof step === 'string' ? step : JSON.stringify({ summary: 's', findings: step });
      return {
        text,
        usage: { inputTokens: 10, outputTokens: 5 },
        cost: { totalCost: 0.01 },
        model: opts.model ?? callOpts?.model,
      };
    },
  };
}

function config(overrides = {}) {
  return {
    review: {
      model: 'primary-model',
      maxFileBytes: null,
      skipGeneratedFiles: true,
      detectBreakingChanges: false,
      maxFindings: null,
      testFileSeverityThreshold: 'high',
      noiseCategories: ['style', 'naming'],
      ...(overrides.review ?? {}),
    },
    excludePaths: overrides.excludePaths ?? [],
    markerPrefix: 'ai-review',
  };
}

function finding(file, line, extra = {}) {
  return { file, line, severity: 'HIGH', category: 'bug', message: `issue at ${file}:${line}`, ...extra };
}

function botThread(id, filePath, line, { status = 'active', ruleId = 'bug' } = {}) {
  return {
    id, status, filePath, line,
    comments: [{ isBot: true, body: `**[HIGH/${ruleId}]** old` }],
    marker: { fingerprint: fingerprint(filePath, line, ruleId), version: '1' },
  };
}

const silent = () => {};

/** @param {any} args */
async function pass({ diffs, threads = [], llm, cfg = config(), promptContext = {}, tokenBudget, log = silent, replyLlm }) {
  return runReviewPass(
    { diffs, threads, meta: META, promptContext, config: cfg },
    { llm, llmName: 'fake', log, ...(tokenBudget ? { tokenBudget } : {}), ...(replyLlm ? { replyLlm } : {}) },
  );
}

describe('runReviewPass: PR description', () => {
  const diffs = [{ path: 'src/a.js', patch: ADD2 }];
  const meta = { id: '42', title: 'T', description: 'All 1633 tests pass.' };

  it('sends the description by default', async () => {
    const llm = fakeLlm([[]]);
    await runReviewPass({ diffs, threads: [], meta, promptContext: {}, config: config() }, { llm, llmName: 'fake', log: silent });
    assert.ok(llm.calls[0].user.includes('<pr_description>\nAll 1633 tests pass.\n</pr_description>'));
  });

  it('omits the description when review.includePrDescription is false', async () => {
    const llm = fakeLlm([[]]);
    const logs = [];
    const cfg = config({ review: { includePrDescription: false } });
    await runReviewPass({ diffs, threads: [], meta, promptContext: {}, config: cfg }, { llm, llmName: 'fake', log: (l, m, d) => logs.push([m, d]) });
    assert.doesNotMatch(llm.calls[0].user, /1633 tests/);
    assert.ok(logs.some(([m, d]) => m === 'pr.description.omitted' && d.chars === meta.description.length));
  });
});

describe('runReviewPass: findings to action plan', () => {
  it('posts a valid finding with ruleId = category and keeps suggestion', async () => {
    const llm = fakeLlm([[finding('src/a.js', 1, { suggestion: ' fixed(); ' })]]);
    const { plan } = await pass({ diffs: [{ path: 'src/a.js', patch: ADD2 }], llm });
    assert.equal(plan.toPost.length, 1);
    assert.deepEqual(plan.toPost[0], {
      filePath: 'src/a.js', line: 1, body: 'issue at src/a.js:1',
      severity: 'HIGH', category: 'bug', suggestion: 'fixed();', ruleId: 'bug',
    });
  });

  it('drops findings outside the diff', async () => {
    const llm = fakeLlm([[finding('src/a.js', 99), finding('src/other.js', 1)]]);
    const { plan } = await pass({ diffs: [{ path: 'src/a.js', patch: ADD2 }], llm });
    assert.deepEqual(plan.toPost, []);
  });

  it('drops deletion-only findings and counts them', async () => {
    const llm = fakeLlm([[finding('src/a.js', 2)]]);
    const { plan, stats } = await pass({
      diffs: [{ path: 'src/a.js', patch: '@@ -1,2 +1,1 @@\n keep\n-gone\n' }], llm,
    });
    assert.deepEqual(plan.toPost, []);
    assert.equal(stats.dropped.deletion, 1);
  });

  it('drops noise findings and counts them', async () => {
    const llm = fakeLlm([[
      finding('src/a.js', 1, { severity: 'LOW', category: 'style' }),
      finding('src/a.test.js', 1, { severity: 'MEDIUM' }),
    ]]);
    const { plan, stats } = await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }, { path: 'src/a.test.js', patch: ADD2 }], llm,
    });
    assert.deepEqual(plan.toPost, []);
    assert.equal(stats.dropped.noise, 2);
  });

  it('truncates to maxFindings by severity and never closes a truncated finding\'s thread', async () => {
    const llm = fakeLlm([[
      finding('src/a.js', 1, { severity: 'LOW', category: 'bug' }),
      finding('src/a.js', 2, { severity: 'CRITICAL' }),
    ]]);
    const lowThread = { ...botThread('t-low', 'src/a.js', 1), status: 'fixed' };
    const { plan, stats } = await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }], llm,
      threads: [lowThread],
      cfg: config({ review: { maxFindings: 1 } }),
    });
    assert.equal(plan.toPost.length, 1);
    assert.equal(plan.toPost[0].severity, 'CRITICAL');
    assert.deepEqual(plan.toReopen, [], 'truncated finding must not reopen its thread');
    assert.equal(stats.dropped.truncated, 1);
  });

  it('reports findings by severity before truncation', async () => {
    const llm = fakeLlm([[finding('src/a.js', 1), finding('src/a.js', 2, { severity: 'LOW' })]]);
    const { stats } = await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }], llm,
      cfg: config({ review: { maxFindings: 1 } }),
    });
    assert.deepEqual(stats.bySeverity, { HIGH: 1, LOW: 1 });
  });
});

describe('runReviewPass: reconcile against existing threads', () => {
  it('skips reply on matching active thread when bot has last word', async () => {
    const llm = fakeLlm([[finding('src/a.js', 1)]]);
    const { plan } = await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }], llm, threads: [botThread('t1', 'src/a.js', 1)],
    });
    assert.equal(plan.toReply.length, 0, 'no redundant reply');
    assert.equal(plan.toPost.length, 0, 'not re-posted as new');
    assert.equal(plan.toClose.length, 0, 'thread still claimed');
  });

  it('closes an active bot thread on a changed line when the finding is gone', async () => {
    const llm = fakeLlm([[]]);
    const { plan } = await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }], llm, threads: [botThread('t1', 'src/a.js', 1)],
    });
    assert.deepEqual(plan.toClose.map((t) => t.id), ['t1']);
  });

  it('counts dismissed threads and feeds them to the prompt', async () => {
    const llm = fakeLlm([[]]);
    const { stats } = await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }], llm,
      threads: [botThread('t1', 'src/zzz.js', 9, { status: 'wontfix' })],
    });
    assert.equal(stats.dismissedCount, 1);
    assert.match(llm.calls[0].sys, /src\/zzz\.js/);
  });
});

describe('runReviewPass: file bypasses', () => {
  it('keeps boilerplate paths out of the prompt when skipGeneratedFiles is on', async () => {
    const llm = fakeLlm([[]]);
    const { stats } = await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }, { path: 'dist/bundle.js', patch: ADD2 }], llm,
    });
    assert.doesNotMatch(llm.calls[0].user, /dist\/bundle\.js ===/);
    assert.deepEqual(stats.skipped.boilerplate, ['dist/bundle.js']);
  });

  it('reviews boilerplate paths when skipGeneratedFiles is off', async () => {
    const llm = fakeLlm([[]]);
    await pass({
      diffs: [{ path: 'dist/bundle.js', patch: ADD2 }], llm,
      cfg: config({ review: { skipGeneratedFiles: false } }),
    });
    assert.match(llm.calls[0].user, /=== dist\/bundle\.js ===/);
  });

  it('skips excluded and oversized files', async () => {
    const llm = fakeLlm([[]]);
    const big = '@@ -0,0 +1,1 @@\n+' + 'x'.repeat(500) + '\n';
    const { stats } = await pass({
      diffs: [
        { path: 'src/a.js', patch: ADD2 },
        { path: 'docs/readme.md', patch: ADD2 },
        { path: 'src/big.js', patch: big },
      ],
      llm,
      cfg: config({ excludePaths: ['docs/'], review: { maxFileBytes: 200 } }),
    });
    assert.deepEqual(stats.skipped.exclude, ['docs/readme.md']);
    assert.deepEqual(stats.skipped.size, ['src/big.js']);
    assert.doesNotMatch(llm.calls[0].user, /readme|big\.js ===/);
  });

  it('validates findings on a line whose secret was redacted (redaction keeps line structure)', async () => {
    const secret = '@@ -0,0 +1,2 @@\n+const key = "AKIAIOSFODNN7EXAMPLE";\n+use(key);\n';
    const llm = fakeLlm([[finding('src/a.js', 1), finding('src/a.js', 2)]]);
    const { plan } = await pass({ diffs: [{ path: 'src/a.js', patch: secret }], llm });
    assert.deepEqual(plan.toPost.map((f) => f.line), [1, 2]);
  });

  it('redacts secrets before the prompt', async () => {
    const llm = fakeLlm([[]]);
    const secret = '@@ -0,0 +1,1 @@\n+const key = "AKIAIOSFODNN7EXAMPLE";\n';
    await pass({ diffs: [{ path: 'src/a.js', patch: secret }], llm });
    assert.doesNotMatch(llm.calls[0].user, /AKIAIOSFODNN7EXAMPLE/);
  });
});

describe('runReviewPass: LLM calls', () => {
  it('sends the submit_findings tool when the provider supports tools', async () => {
    const llm = fakeLlm([[]], { supportsTools: true });
    await pass({ diffs: [{ path: 'src/a.js', patch: ADD2 }], llm });
    assert.equal(llm.calls[0].opts.tools[0].name, 'submit_findings');
    assert.equal(llm.calls[0].opts.model, 'primary-model');
  });

  it('re-prompts once with a stricter instruction when the response does not parse', async () => {
    const llm = fakeLlm(['no json here', [finding('src/a.js', 1)]]);
    const { plan } = await pass({ diffs: [{ path: 'src/a.js', patch: ADD2 }], llm });
    assert.equal(llm.calls.length, 2);
    assert.match(llm.calls[1].sys, /respond with ONLY a single JSON object/);
    assert.equal(plan.toPost.length, 1);
  });

  it('throws ValidationError when the main response never parses', async () => {
    const llm = fakeLlm(['nope', 'still nope']);
    await assert.rejects(
      pass({ diffs: [{ path: 'src/a.js', patch: ADD2 }], llm }),
      ValidationError,
    );
  });

  it('appends traced imports to the main prompt only', async () => {
    const llm = fakeLlm([[]]);
    await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }], llm,
      promptContext: { tracedImports: [{ path: 'src/dep.js', content: 'export const d = 1;' }] },
    });
    assert.match(llm.calls[0].user, /=== src\/dep\.js \(imported\) ===/);
  });

  it('drops traced imports that do not fit the remaining budget instead of overflowing', async () => {
    const { buildPrompt, estimateTokens } = require('../lib/prompt-builder.js');
    const sys = buildPrompt({ fileDiffs: [], prInfo: { prId: '42', title: 'T' } }).systemPrompt;
    const perFile = estimateTokens('1:+const a = 1;\n2:+const b = 2;\n') + estimateTokens('src/a.js') + 10;
    // Fits the system prompt + one file, leaving only a sliver — far less than
    // the traced import below, so the import must be dropped rather than push
    // the diff into an overflow chunk.
    const tokenBudget = estimateTokens(sys) + perFile + 20;
    const logs = [];
    const llm = fakeLlm([[]]);
    await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }], llm, tokenBudget,
      promptContext: { tracedImports: [{ path: 'src/dep.js', content: 'y'.repeat(4000) }] },
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
    });
    assert.equal(llm.calls.length, 1, 'a dropped import must not create an overflow chunk');
    assert.match(llm.calls[0].user, /=== src\/a\.js ===/, 'the diff still rides the main call');
    assert.doesNotMatch(llm.calls[0].user, /src\/dep\.js/, 'oversized import must be dropped');
    const dropped = logs.find((l) => l.msg === 'review.imports.dropped');
    assert.ok(dropped, 'dropped imports must be logged');
    assert.equal(dropped.fields.count, 1);
    assert.deepEqual(dropped.fields.files, ['src/dep.js']);
  });

  it('sums usage and cost across calls', async () => {
    const llm = fakeLlm(['junk', []]);
    const { usage } = await pass({ diffs: [{ path: 'src/a.js', patch: ADD2 }], llm });
    assert.equal(usage.inputTokens, 20);
    assert.equal(usage.outputTokens, 10);
    assert.ok(Math.abs(usage.cost - 0.02) < 1e-9);
  });
});

// Two equally-sized files; the budget fits the system prompt, the PR header
// and one file, so src/a.js goes in the main call and src/b.js overflows into
// a chunk.
function overflowSetup() {
  const { buildPrompt, estimateTokens, renderPrHeader } = require('../lib/prompt-builder.js');
  const prInfo = { prId: '42', title: 'T' };
  const sys = buildPrompt({ fileDiffs: [], prInfo }).systemPrompt;
  const diffs = [{ path: 'src/a.js', patch: ADD2 }, { path: 'src/b.js', patch: ADD2 }];
  const perFile = estimateTokens('1:+const a = 1;\n2:+const b = 2;\n') + estimateTokens('src/a.js') + 10;
  const tokenBudget = estimateTokens(sys) + estimateTokens(renderPrHeader(prInfo)) + perFile + Math.floor(perFile / 2);
  return { diffs, tokenBudget };
}

// Same tight budget, three files: the main call fits one, the other two
// overflow into two separate chunks.
function overflowSetup3() {
  const { buildPrompt, estimateTokens } = require('../lib/prompt-builder.js');
  const sys = buildPrompt({ fileDiffs: [], prInfo: { prId: '42', title: 'T' } }).systemPrompt;
  const diffs = [
    { path: 'src/a.js', patch: ADD2 },
    { path: 'src/b.js', patch: ADD2 },
    { path: 'src/c.js', patch: ADD2 },
  ];
  const perFile = estimateTokens('1:+const a = 1;\n2:+const b = 2;\n') + estimateTokens('src/a.js') + 10;
  const tokenBudget = estimateTokens(sys) + perFile + Math.floor(perFile / 2);
  return { diffs, tokenBudget };
}

describe('runReviewPass: overflow chunks', () => {
  it('reviews budget-overflow files in a separate chunk call', async () => {
    const { diffs, tokenBudget } = overflowSetup();
    const llm = fakeLlm([[finding('src/a.js', 1)], [finding('src/b.js', 1)]]);
    const { plan } = await pass({ diffs, llm, tokenBudget });
    assert.equal(llm.calls.length, 2);
    assert.match(llm.calls[1].user, /=== src\/b\.js ===/);
    assert.deepEqual(plan.toPost.map((f) => f.filePath).sort(), ['src/a.js', 'src/b.js']);
  });

  it('does not close threads on files of a failed chunk', async () => {
    const { diffs, tokenBudget } = overflowSetup();
    const llm = fakeLlm([[], new Error('chunk exploded')]);
    const { plan, stats } = await pass({
      diffs, llm, tokenBudget, threads: [botThread('tb', 'src/b.js', 1)],
    });
    assert.deepEqual(plan.toClose, []);
    assert.equal(stats.failedChunks, 1);
  });
});

describe('runReviewPass: coverage', () => {
  it('never closes threads on excluded, oversized or boilerplate files', async () => {
    const llm = fakeLlm([[]]);
    const big = '@@ -0,0 +1,2 @@\n+' + 'x'.repeat(500) + '\n+y\n';
    const { plan } = await pass({
      diffs: [
        { path: 'src/a.js', patch: ADD2 },
        { path: 'docs/readme.md', patch: ADD2 },
        { path: 'src/big.js', patch: big },
        { path: 'dist/bundle.js', patch: ADD2 },
      ],
      threads: [
        botThread('t-excluded', 'docs/readme.md', 1),
        botThread('t-size', 'src/big.js', 1),
        botThread('t-boiler', 'dist/bundle.js', 1),
        botThread('t-covered', 'src/a.js', 1),
      ],
      llm,
      cfg: config({ excludePaths: ['docs/'], review: { maxFileBytes: 200 } }),
    });
    assert.deepEqual(plan.toClose.map((t) => t.id), ['t-covered']);
  });

  it('counts every covered file as reviewed, including chunked ones', async () => {
    const { diffs, tokenBudget } = overflowSetup();
    const llm = fakeLlm([[], []]);
    const { stats } = await pass({ diffs, llm, tokenBudget });
    assert.equal(stats.filesReviewed, 2);
  });

  it('does not count a failed chunk\'s files as reviewed', async () => {
    const { diffs, tokenBudget } = overflowSetup();
    const llm = fakeLlm([[], 'junk', 'junk']);
    const { stats } = await pass({ diffs, llm, tokenBudget });
    assert.equal(stats.filesReviewed, 1);
    assert.deepEqual(stats.skipped.failedChunk, ['src/b.js']);
    assert.deepEqual(stats.skipped.budget, [], 'a failed chunk is not a budget skip');
  });
});

describe('runReviewPass: chunk parity with the main call', () => {
  it('applies breaking-change detection to chunk prompts', async () => {
    const { diffs, tokenBudget } = overflowSetup();
    const llm = fakeLlm([[], []]);
    await pass({ diffs, llm, tokenBudget, cfg: config({ review: { detectBreakingChanges: true } }) });
    assert.match(llm.calls[1].sys, /Breaking-change detection/);
  });

  it('keeps suggestions on chunk findings', async () => {
    const { diffs, tokenBudget } = overflowSetup();
    const llm = fakeLlm([[], [finding('src/b.js', 1, { suggestion: 'fix()' })]]);
    const { plan } = await pass({ diffs, llm, tokenBudget });
    assert.equal(plan.toPost[0].suggestion, 'fix()');
  });

  it('re-prompts a chunk once when its response does not parse', async () => {
    const { diffs, tokenBudget } = overflowSetup();
    const llm = fakeLlm([[], 'junk', [finding('src/b.js', 1)]]);
    const { plan, stats } = await pass({ diffs, llm, tokenBudget });
    assert.equal(llm.calls.length, 3);
    assert.deepEqual(plan.toPost.map((f) => f.filePath), ['src/b.js']);
    assert.equal(stats.failedChunks, 0);
  });

  it('injects main-call findings into the overflow chunk prompt', async () => {
    const { diffs, tokenBudget } = overflowSetup();
    const llm = fakeLlm([[finding('src/a.js', 1)], []]);
    await pass({ diffs, llm, tokenBudget });
    assert.equal(llm.calls.length, 2);
    assert.doesNotMatch(llm.calls[0].user, /already-found findings/i, 'main call has no prior findings');
    assert.match(llm.calls[1].user, /already-found findings/i);
    assert.match(llm.calls[1].user, /\[HIGH\/bug\] src\/a\.js:1/);
  });

  it('carries earlier chunk findings into the next chunk prompt', async () => {
    const { diffs, tokenBudget } = overflowSetup3();
    const llm = fakeLlm([[finding('src/a.js', 1)], [finding('src/b.js', 1)], []]);
    const { plan } = await pass({ diffs, llm, tokenBudget });
    assert.equal(llm.calls.length, 3, 'main + two overflow chunks');
    assert.match(llm.calls[2].user, /src\/a\.js:1/);
    assert.match(llm.calls[2].user, /src\/b\.js:1/);
    assert.deepEqual(plan.toPost.map((f) => f.filePath).sort(), ['src/a.js', 'src/b.js']);
  });

  it('does not stack retries on top of the provider\'s own retry', { timeout: 3000 }, async () => {
    const { diffs, tokenBudget } = overflowSetup();
    // What a provider throws once its own retries are exhausted.
    const outage = new RateLimitError('rate limited after provider retries', { provider: 'fake' });
    const llm = fakeLlm([[], outage], { repeatLast: true });
    const { stats } = await pass({ diffs, llm, tokenBudget });
    assert.equal(llm.calls.length, 2, 'chunk call must be attempted exactly once');
    assert.equal(stats.failedChunks, 1);
  });
});

describe('runReviewPass: usage attribution', () => {
  it('reports the models that actually answered', async () => {
    const llm = fakeLlm([[]], { model: 'fallback-model' });
    const { usage } = await pass({ diffs: [{ path: 'src/a.js', patch: ADD2 }], llm });
    assert.deepEqual(usage.models, ['fallback-model']);
  });

  it('merges reflection tokens, cost and answering model into usage', async () => {
    // A HIGH finding is reflectable; the reflection call runs on the reply
    // LLM, which (under failover) answers with a different model. Its spend
    // must ride into the run total the same way the main call's does — the
    // old code kept only `cost`, dropping the reflection tokens and model.
    const llm = fakeLlm([[finding('src/a.js', 1, { severity: 'HIGH' })]]);
    const replyLlm = {
      call: async () => ({
        text: JSON.stringify({ verdicts: [{ index: 0, verdict: 'keep', reason: 'ok' }] }),
        usage: { inputTokens: 100, outputTokens: 50 },
        cost: { totalCost: 0.005 },
        model: 'reflection-model',
      }),
    };
    const { usage } = await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }], llm, replyLlm,
    });
    assert.equal(llm.calls.length, 1, 'main call only — no overflow chunk');
    assert.equal(usage.inputTokens, 110);
    assert.equal(usage.outputTokens, 55);
    assert.ok(Math.abs(usage.cost - 0.015) < 1e-9);
    assert.deepEqual(usage.models, ['primary-model', 'reflection-model']);
  });

  it('does not merge reflection twice when the same model answered both', async () => {
    const llm = fakeLlm([[finding('src/a.js', 1, { severity: 'HIGH' })]]);
    const replyLlm = {
      call: async () => ({
        text: JSON.stringify({ verdicts: [{ index: 0, verdict: 'keep', reason: 'ok' }] }),
        usage: { inputTokens: 10, outputTokens: 5 },
        cost: { totalCost: 0.01 },
        model: 'primary-model',
      }),
    };
    const { usage } = await pass({
      diffs: [{ path: 'src/a.js', patch: ADD2 }], llm, replyLlm,
    });
    assert.deepEqual(usage.models, ['primary-model']);
    assert.equal(usage.inputTokens, 20);
    assert.ok(Math.abs(usage.cost - 0.02) < 1e-9);
  });
});
