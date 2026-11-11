// @ts-check
'use strict';

// Review pass: raw diffs + existing threads in, action plan out. Owns every
// decision between "what changed" and "what to post / reply / reopen / close"
// so those decisions can be tested through one interface. See CONTEXT.md
// (Review pass, Coverage, Action plan).

const { CONFIG } = require('./config.js');
const { buildPrompt, renderPrHeader } = require('./prompt-builder.js');
const { preparePrDescription } = require('./pr-description.js');
const { chunkFileDiffs, buildFileGroups, summarizeFindings } = require('./chunk-diffs.js');
const { redactDiffs } = require('./diff-secret-redact.js');
const { annotateDiff } = require('./diff-annotate.js');
const { partitionReviewable } = require('./reviewable-files.js');
const { shouldDropAsNoise, truncateFindings } = require('./noise-filter.js');
const { validateFindings, buildChangedFilesMap } = require('./finding-validator.js');
const { rankSeverity } = require('./config.js');
const { reflectionFilter } = require('./reflection-filter.js');
const { reconcilePort } = require('./reconcile.js');
const { fingerprint } = require('./fingerprint.js');
const { buildDismissedContext } = require('./port/dismissal-port.js');
const { callForFindings } = require('./review-llm.js');
const { safeMsg } = require('./log-safe.js');
const { ValidationError } = require('./errors.js');

/**
 * @typedef {(level: string, msg: string, fields?: object) => void} LogFn
 *
 * @typedef {Object} ReviewPassConfig
 * @property {{
 *   model: string,
 *   maxFileBytes?: number|null,
 *   skipGeneratedFiles?: boolean,
 *   detectBreakingChanges?: boolean,
 *   maxFindings?: number|null,
 *   severityThreshold: string,
 *   testFileSeverityThreshold: string,
 *   noiseCategories: string[],
 *   reflection?: boolean,
 * }} review
 * @property {string[]} [excludePaths]
 * @property {string} [markerPrefix]
 *
 * @typedef {Object} ReviewPassInput
 * @property {Array<{ path: string, patch: string }>} diffs
 * @property {Array<any>} threads      existing review threads (provider-normalized)
 * @property {{ id: string|number, title: string, description?: string }} meta
 * @property {{
 *   codingStandards?: string, projectContext?: string, suppressionContext?: string,
 *   tracedImports?: Array<{ path: string, content: string }>,
 * }} promptContext
 * @property {ReviewPassConfig} config
 *
 * @typedef {Object} ReviewPassDeps
 * @property {any} llm                 LLMProvider (`call`, optional `supportsTools`)
 * @property {string} [llmName]        provider name, for logs
 * @property {LogFn} [log]             defaults to stderr JSON lines
 * @property {number} [tokenBudget]    prompt token budget, defaults to CONFIG.tokenBudget
 * @property {any} [replyLlm]          reply LLMProvider for reflection filter
 */

/** @type {LogFn} */
function stderrLog(level, msg, fields = {}) {
  process.stderr.write(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...fields }) + '\n');
}

/**
 * @param {ReviewPassInput} input
 * @param {ReviewPassDeps} deps
 */
async function runReviewPass(input, deps) {
  const { diffs, threads, meta, promptContext = {}, config } = input;
  const log = deps.log ?? stderrLog;
  const tokenBudget = deps.tokenBudget ?? CONFIG.tokenBudget;
  const ctx = { llm: deps.llm, model: config.review.model, providerName: deps.llmName ?? 'unknown', log };

  const dismissed = buildDismissedContext(threads, config.markerPrefix ?? 'ai-review');
  const files = prepareFiles(diffs, config, log);
  const includeDescription = config.review.includePrDescription !== false;
  const description = preparePrDescription(includeDescription ? meta.description : '');
  if (!includeDescription && meta.description) log('info', 'pr.description.omitted', { chars: meta.description.length });
  if (description.redacted > 0) log('warn', 'pr.description.secrets.redacted', { count: description.redacted });
  if (description.truncated) log('info', 'pr.description.truncated', { originalChars: meta.description?.length ?? 0 });
  const promptOpts = {
    prInfo: { prId: meta.id, title: meta.title, description: description.text },
    codingStandards: promptContext.codingStandards ?? '',
    dismissedContext: dismissed.prompt || null,
    securityContext: null, // securityContext disabled
    projectContext: promptContext.projectContext ?? '',
    suppressionContext: promptContext.suppressionContext ?? '',
    detectBreakingChanges: config.review.detectBreakingChanges === true,
    tokenBudget,
  };
  const calls = await runCallPlan(files.reviewable, promptOpts, promptContext.tracedImports, ctx, diffs);

  const uncovered = files.annotated.map((a) => a.filePath).filter((f) => !calls.covered.has(f));
  if (uncovered.length > 0) log('warn', 'prompt.files.skipped', { count: uncovered.length, files: uncovered });

  const changedFiles = buildChangedFilesMap(files.annotated);
  const { findings: preReflection, dropped } = filterFindings(validateFindings(calls.rawFindings, changedFiles), config.review, log);

  let findings = preReflection;
  let reflectionResult = null;
  const reflectionEnabled = config.review.reflection !== false;
  if (reflectionEnabled && !deps.replyLlm) {
    log('warn', 'reflection.skipped', { reason: 'no reply LLM provider available' });
  }
  if (reflectionEnabled && deps.replyLlm && preReflection.length > 0) {
    log('info', 'reflection.enabled', { findingCount: preReflection.length });
    const criticals = preReflection.filter((f) => f.severity === 'CRITICAL');
    const reflectable = preReflection.filter((f) => f.severity !== 'CRITICAL');
    if (reflectable.length > 0) {
      reflectionResult = await reflectionFilter({
        findings: reflectable,
        diffs: diffs.map((d) => ({ path: d.path, patch: d.patch, annotatedDiff: files.annotatedByPath?.get(d.path) })),
        codingStandards: promptContext.codingStandards ?? '',
        llmProvider: deps.replyLlm,
        log,
      });
      findings = [...criticals, ...reflectionResult.kept];
    }
  }

  const { kept: capped, dropped: truncated } = truncateFindings(findings, config.review.maxFindings);
  if (truncated > 0) {
    log('info', 'findings.truncated', {
      maxFindings: config.review.maxFindings, kept: capped.length, dropped: truncated,
    });
  }
  const suppressClose = closeSuppression(threads, calls.covered, findings, capped);
  const plan = reconcilePort(threads, capped, { changedFiles, suppressClose });

  /** @type {Record<string, number>} */
  const bySeverity = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  // Reflection uses the reply LLM, so its tokens, cost and answering model
  // must ride into the run total the same way main/chunk calls do — cost
  // alone would leave the state and audit `model` missing the reply model
  // that produced part of it.
  const reflectionUsage = reflectionResult?.usage ?? null;
  const totalUsage = {
    ...calls.usage,
    inputTokens: calls.usage.inputTokens + (reflectionUsage?.inputTokens ?? 0),
    outputTokens: calls.usage.outputTokens + (reflectionUsage?.outputTokens ?? 0),
    cost: calls.usage.cost + (reflectionUsage?.cost ?? 0),
    models: calls.usage.models.concat(
      (reflectionUsage?.models ?? []).filter((m) => !calls.usage.models.includes(m)),
    ),
  };

  return {
    plan,
    findings,
    stats: {
      filesReviewed: calls.covered.size,
      skipped: { ...files.skipped, budget: calls.budgetSkipped, failedChunk: calls.failedChunkFiles },
      failedChunks: calls.failedChunks,
      dropped: { ...dropped, reflection: reflectionResult?.log?.dropped ?? 0, truncated },
      bySeverity,
      dismissedCount: dismissed.dismissedCount,
      reflection: reflectionResult?.log ?? null,
    },
    usage: totalUsage,
  };
}

/**
 * Redact and annotate every diff once, then set aside the files the LLM
 * must not see (excluded, oversized, boilerplate).
 *
 * @param {ReviewPassInput['diffs']} diffs
 * @param {ReviewPassConfig} config
 * @param {LogFn} log
 */
function prepareFiles(diffs, config, log) {
  const { diffs: safeDiffs, totalRedacted } = redactDiffs(diffs);
  if (totalRedacted > 0) log('warn', 'diff.secrets.redacted', { count: totalRedacted });
  const annotated = safeDiffs.map((d) => ({ filePath: d.path, annotatedDiff: annotateDiff(d.patch) }));
  const annotatedByPath = new Map(annotated.map((a) => [a.filePath, a.annotatedDiff]));

  const { kept, skipped } = partitionReviewable(safeDiffs, config);
  const reviewable = kept.map((d) => ({ filePath: d.path, annotatedDiff: annotatedByPath.get(d.path) ?? '' }));
  return { annotated, reviewable, annotatedByPath, skipped };
}

/**
 * Main call over what fits the token budget, then one call per overflow
 * chunk, all built from the same prompt recipe. Traced imports ride only on
 * the main call. A file is covered once it sat in a prompt whose response
 * parsed. The provider owns retries; each call here is attempted once, plus
 * one stricter re-prompt when the response does not parse.
 *
 * @param {Array<{ filePath: string, annotatedDiff: string }>} reviewable
 * @param {object} promptOpts
 * @param {ReviewPassInput['promptContext']['tracedImports']} tracedImports
 * @param {{ llm: any, model: string, providerName: string, log: LogFn }} ctx
 * @param {Array<{ path: string, patch: string }>} diffs  raw PR diffs for semantic grouping
 */
async function runCallPlan(reviewable, promptOpts, tracedImports, ctx, diffs) {
  const usage = { inputTokens: 0, outputTokens: 0, cost: 0, models: /** @type {string[]} */ ([]) };
  const addUsage = (/** @type {any} */ call) => {
    usage.inputTokens += call.usage?.inputTokens ?? 0;
    usage.outputTokens += call.usage?.outputTokens ?? 0;
    usage.cost += call.cost?.totalCost ?? 0;
    if (call.model && !usage.models.includes(call.model)) usage.models.push(call.model);
  };
  const covered = new Set();
  /** @param {Array<{ filePath: string }>} sent @param {string[]} skipped */
  const cover = (sent, skipped) => {
    for (const f of sent) if (!skipped.includes(f.filePath)) covered.add(f.filePath);
  };

  const main = buildPrompt({ ...promptOpts, fileDiffs: reviewable, tracedImports });
  if (main.skippedImports.length > 0) {
    ctx.log('warn', 'review.imports.dropped', {
      count: main.skippedImports.length, files: main.skippedImports,
    });
  }
  const mainResult = await callForFindings(main.systemPrompt, main.userPrompt, ctx);
  mainResult.calls.forEach(addUsage);
  if (!mainResult.parsed) throw new ValidationError('Failed to extract JSON object with `findings` array');
  let rawFindings = mainResult.parsed.findings.map(toRawFinding);
  cover(reviewable, main.skippedFiles);

  const budgetSkipped = [];
  const failedChunkFiles = [];
  let failedChunks = 0;
  const overflow = reviewable.filter((d) => main.skippedFiles.includes(d.filePath));
  const chunkOpts = {
    tokenBudget: promptOpts.tokenBudget,
    // Reserve the system prompt plus the prior-findings summary that can ride
    // on any chunk prompt. Reserved unconditionally: the main call may find
    // nothing while chunk 1 does, and that chunk's findings are summarized
    // into chunks 2..N. Over-reserving only shrinks chunks slightly;
    // under-reserving blows the budget on later chunks.
    reservedTokens: Math.ceil(main.systemPrompt.length / CONFIG.charsPerToken)
      + Math.ceil(renderPrHeader(promptOpts.prInfo).length / CONFIG.charsPerToken)
      + CONFIG.chunkFindingsSummaryTokens,
  };
  let chunks = [];
  if (overflow.length > 0) {
    const groups = buildFileGroups(diffs, overflow);
    const multiFileGroups = groups.filter((g) => g.length > 1).length;
    if (multiFileGroups > 0) {
      ctx.log('info', 'review.semantic-groups', {
        groups: groups.length, multiFileGroups, overflowFiles: overflow.length,
      });
    }
    const chunkResult = chunkFileDiffs(overflow, { ...chunkOpts, groups });
    chunks = chunkResult.chunks;
    if (chunkResult.splitGroups.length > 0) {
      ctx.log('warn', 'review.semantic-groups.split', {
        count: chunkResult.splitGroups.length, groups: chunkResult.splitGroups,
      });
    }
  }
  if (chunks.length > 0) ctx.log('info', 'review.chunked', { chunks: chunks.length, overflowFiles: overflow.length });
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkFiles = chunk.map((f) => f.filePath);
    try {
      // Everything found by the main call and earlier chunks, compressed so
      // this chunk does not re-report it. Grows chunk to chunk.
      const priorFindingsSummary = summarizeFindings(rawFindings);
      const prompt = buildPrompt({ ...promptOpts, fileDiffs: chunk, priorFindingsSummary });
      const result = await callForFindings(prompt.systemPrompt, prompt.userPrompt, ctx);
      result.calls.forEach(addUsage);
      if (!result.parsed) {
        failedChunks++;
        failedChunkFiles.push(...chunkFiles);
        ctx.log('warn', 'review.chunk.parse.failed', { chunkIndex: ci, files: chunkFiles });
        continue;
      }
      rawFindings = rawFindings.concat(result.parsed.findings.map(toRawFinding));
      budgetSkipped.push(...prompt.skippedFiles);
      cover(chunk, prompt.skippedFiles);
    } catch (e) {
      failedChunks++;
      failedChunkFiles.push(...chunkFiles);
      ctx.log('warn', 'review.chunk.failed', { chunkIndex: ci, files: chunkFiles, errMessage: safeMsg(e) });
    }
  }
  return { rawFindings, covered, budgetSkipped, failedChunkFiles, failedChunks, usage };
}

/** @param {any} f */
function toRawFinding(f) {
  return {
    file: f.file, line: f.line, message: f.message, severity: f.severity, category: f.category,
    ...(typeof f.suggestion === 'string' && f.suggestion.trim() ? { suggestion: f.suggestion.trim() } : {}),
  };
}

/**
 * Fingerprints reconcile must not close: every thread on an uncovered file
 * (the LLM never saw it, so a missing finding proves nothing), and every
 * finding cut by maxFindings (it still exists, it just wasn't posted).
 *
 * @param {Array<any>} threads
 * @param {Set<string>} covered
 * @param {Array<any>} findings
 * @param {Array<any>} capped
 */
function closeSuppression(threads, covered, findings, capped) {
  const suppress = new Set();
  for (const t of threads) {
    if (t.marker?.fingerprint && !covered.has(t.filePath)) suppress.add(t.marker.fingerprint);
  }
  if (capped.length < findings.length) {
    const keptSet = new Set(capped);
    for (const f of findings) {
      if (!keptSet.has(f)) suppress.add(fingerprint(f.filePath, f.line, f.ruleId));
    }
  }
  return suppress;
}

/**
 * Drop deletion-only and noise findings; map the rest to reconcile's shape.
 *
 * @param {Array<any>} validated
 * @param {ReviewPassConfig['review']} review
 * @param {LogFn} log
 */
function filterFindings(validated, review, log) {
  const findings = [];
  const dropped = { deletion: 0, noise: 0, belowThreshold: 0 };
  const thresholdRank = rankSeverity(review.severityThreshold);
  for (const f of validated) {
    if (f.deletion) {
      dropped.deletion++;
      log('warn', 'finding.dropped.deletion-only', {
        file: f.file, line: f.line, severity: f.severity, category: f.category,
      });
      continue;
    }
    const dropReason = shouldDropAsNoise(f, review);
    if (dropReason) {
      dropped.noise++;
      log('info', 'finding.dropped.noise', {
        file: f.file, line: f.line, severity: f.severity, category: f.category, reason: dropReason,
      });
      continue;
    }
    if (rankSeverity(f.severity) < thresholdRank) {
      dropped.belowThreshold++;
      log('info', 'finding.dropped.below-threshold', {
        file: f.file, line: f.line, severity: f.severity, category: f.category, threshold: review.severityThreshold,
      });
      continue;
    }
    const category = f.category ?? 'unknown';
    findings.push({
      filePath: f.file, line: f.line, body: f.message,
      severity: f.severity ?? 'UNKNOWN', category, suggestion: f.suggestion ?? null,
      // Identity key is category-only, not category:severity. The LLM
      // re-grades the same finding's severity inconsistently run to run
      // (e.g. LOW -> MEDIUM); baking severity into the fingerprint turned
      // that grading noise into a brand-new finding identity each time,
      // reposting the same code observation as a fresh thread.
      ruleId: category,
    });
  }
  return { findings, dropped };
}

module.exports = { runReviewPass };
