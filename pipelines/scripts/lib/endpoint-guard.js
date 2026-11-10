// @ts-check
'use strict';

const { ConfigError } = require('./errors.js');

/**
 * The configuration file is part of the code under review: on a pull request it is the version
 * written by the author of that pull request. It must not be able to send a secret somewhere the
 * owner of the workflow did not agree to. Two rules, both enforced while the config is loaded:
 *
 *   1. A variable whose name looks like a secret may be interpolated only under `auth.*`.
 *   2. A URL that receives data (`*.apiBaseUrl`, `review.exportWebhookUrl`) must point at a host the
 *      workflow approved, through AI_REVIEW_ALLOWED_HOSTS (the `allowed-hosts` input of the action).
 *      The hosts of the built-in LLM providers are approved for `apiBaseUrl` without it.
 *
 * ADR-0019.
 */

/**
 * Names such as GITHUB_TOKEN, ANTHROPIC_API_KEY, AI_REVIEW_RESOLVE_TOKEN, DB_PASSWORD, AWS_CREDENTIALS, AZURE_PAT.
 * TOKEN, SECRET, PASSWORD, CREDENTIAL and PRIVATE match anywhere in the name on purpose (CREDENTIALS, SSH_PRIVATE_KEY,
 * SYSTEM_ACCESSTOKEN); KEY and PAT must be whole words so that KEYWORD or PATH are not caught. A false positive costs
 * a rename, a false negative costs a secret.
 */
const SECRET_VAR = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|(^|_)(KEY|PAT)(_|$))/;

/** Hosts of the providers this project calls by default. */
const BUILTIN_LLM_HOSTS = Object.freeze([
  'api.anthropic.com',
  'api.deepseek.com',
  'generativelanguage.googleapis.com',
  'api.modelstack.cc',
  'api.openai.com',
  'openrouter.ai',
]);

/** @param {string} name */
function isSecretVarName(name) {
  return SECRET_VAR.test(name);
}

/** Config path `auth` or `auth.<key>` (also `auth.<key>[0]`). @param {string} keyPath */
function isAuthPath(keyPath) {
  return keyPath === 'auth' || keyPath.startsWith('auth.');
}

/**
 * Comma or whitespace separated host names. Exact host names only (no wildcard, no port, no scheme),
 * compared in lower case.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function allowedHostsFrom(env) {
  return String(env?.AI_REVIEW_ALLOWED_HOSTS ?? '')
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Throws a ConfigError unless the host of `url` is approved.
 * @param {{ field: string, url: string, env: NodeJS.ProcessEnv, builtin?: readonly string[] }} opts
 */
function assertHostAllowed({ field, url, env, builtin = [] }) {
  const host = new URL(url).hostname.toLowerCase();
  if (builtin.includes(host) || allowedHostsFrom(env).includes(host)) return;
  throw new ConfigError(
    `${field} points at host "${host}", which this workflow has not approved. ` +
      'The configuration file comes from the pull request, so the host must be listed by the workflow: ' +
      'set the `allowed-hosts` input of the action (AI_REVIEW_ALLOWED_HOSTS), e.g. allowed-hosts: ' + host,
  );
}

module.exports = { isSecretVarName, isAuthPath, allowedHostsFrom, assertHostAllowed, BUILTIN_LLM_HOSTS };
