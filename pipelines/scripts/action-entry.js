// @ts-check
'use strict';

const core = require('@actions/core');
const { runReview, runReply, runLearn } = require('./ai-review.js');
const cachePort = require('./lib/port/cache-port.js');
const { resolveStateRoot } = require('./lib/port/state-store.js');
const { resolvePr } = require('./lib/resolve-pr.js');

function getInputs() {
  return {
    subcommand: core.getInput('subcommand') || 'review',
    configPath: core.getInput('config-path') || 'ai-review.config.yaml',
    provider: core.getInput('provider') || 'github',
    dryRun: core.getBooleanInput('dry-run'),
    severityThreshold: core.getInput('severity-threshold'),
    reviewModel: core.getInput('review-model'),
    replyModel: core.getInput('reply-model'),
    reviewProvider: core.getInput('review-provider'),
    replyProvider: core.getInput('reply-provider'),
    prNumber: core.getInput('pr-number'),
    repository: core.getInput('repository'),
    allowedHosts: core.getInput('allowed-hosts'),
    strict: core.getBooleanInput('strict'),
  };
}

async function main() {
  const anthropicKey = core.getInput('anthropic-api-key') || '';
  const deepseekKey = core.getInput('deepseek-api-key') || '';
  const geminiKey = core.getInput('gemini-api-key') || '';
  const modelstackKey = core.getInput('modelstack-api-key') || '';
  const openrouterKey = core.getInput('openrouter-api-key') || '';
  const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  const resolveToken = core.getInput('resolve-token') || '';
  if (anthropicKey) { core.setSecret(anthropicKey); process.env.ANTHROPIC_API_KEY = anthropicKey; }
  if (deepseekKey)  { core.setSecret(deepseekKey);  process.env.DEEPSEEK_API_KEY  = deepseekKey;  }
  if (geminiKey)    { core.setSecret(geminiKey);    process.env.GEMINI_API_KEY    = geminiKey;    }
  if (modelstackKey) { core.setSecret(modelstackKey); process.env.MODELSTACK_API_KEY = modelstackKey; }
  if (openrouterKey) { core.setSecret(openrouterKey); process.env.OPENROUTER_API_KEY = openrouterKey; }
  if (resolveToken) { core.setSecret(resolveToken); process.env.AI_REVIEW_RESOLVE_TOKEN = resolveToken; }
  if (githubToken) core.setSecret(githubToken);
  process.env.GITHUB_TOKEN = githubToken;

  const i = getInputs();
  if (i.severityThreshold) process.env.AI_REVIEW_SEVERITY_THRESHOLD = i.severityThreshold;
  if (i.reviewModel) process.env.AI_REVIEW_MODEL = i.reviewModel;
  if (i.replyModel) process.env.AI_REPLY_MODEL = i.replyModel;
  if (i.reviewProvider) process.env.AI_REVIEW_LLM_PROVIDER = i.reviewProvider;
  if (i.replyProvider) process.env.AI_REPLY_LLM_PROVIDER = i.replyProvider;
  if (i.repository) process.env.GITHUB_REPOSITORY = i.repository;
  // Set from the input only: the configuration file cannot widen the list (ADR-0019).
  process.env.AI_REVIEW_ALLOWED_HOSTS = i.allowedHosts;
  if (i.strict) process.env.AI_REVIEW_STRICT = 'true';

  // `learn` runs off no PR (it mines merged-PR history and opens a proposal PR),
  // so it skips PR resolution and the per-PR cache entirely. Handle it before
  // the PR gate below, which would otherwise fail with exit 7.
  if (i.subcommand === 'learn') {
    const learnArgv = ['learn', `--config=${i.configPath}`, `--provider=${i.provider}`];
    if (i.dryRun) learnArgv.push('--dry-run');
    let learnCode = 1;
    try {
      learnCode = await runLearn({ argv: learnArgv });
    } finally {
      core.setOutput('exit-code', String(learnCode));
    }
    // Learn exit codes: 0 = no proposal, 1 = PR proposed, 2-5 = config/auth/
    // provider/LLM error. Only fail the workflow on real errors (>1).
    if (learnCode > 1) process.exit(learnCode);
    return;
  }

  const prNum = resolvePr(process.env, { override: i.prNumber });
  if (!prNum) {
    core.setFailed('pr-number not provided and not derivable from event');
    process.exit(7);
    return;
  }
  process.env.GITHUB_PR_NUMBER = String(prNum);
  process.env.GITHUB_REF = process.env.GITHUB_REF || `refs/pull/${prNum}/head`;

  const repoId = process.env.GITHUB_REPOSITORY_ID;
  const runId = process.env.GITHUB_RUN_ID;
  const stateRoot = resolveStateRoot(process.env);

  await cachePort.restore({
    stateRoot,
    repoId,
    prNum,
    env: process.env,
  });

  const argv = [i.subcommand, `--config=${i.configPath}`, `--provider=${i.provider}`];
  if (i.dryRun) argv.push('--dry-run');
  if (i.strict) argv.push('--strict');

  let code = 1; // default to non-zero so throws surface as "activity"
  try {
    const fn = i.subcommand === 'reply' ? runReply : runReview;
    code = await fn({ argv });
  } finally {
    await cachePort.save({
      stateRoot,
      repoId,
      prNum,
      runId,
      dryRun: i.dryRun,
      env: process.env,
    });
    core.setOutput('exit-code', String(code));
    core.setOutput('strict-triggered', String(code === 8));
  }

  if (code > 1 && code !== 6) process.exit(code);
}

if (require.main === module) {
  main().catch((e) => { core.setFailed(e.message ?? String(e)); process.exit(1); });
}

module.exports = { main };
