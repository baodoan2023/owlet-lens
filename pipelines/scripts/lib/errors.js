// pipelines/scripts/lib/errors.js
// @ts-check
'use strict';

class AIReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AIReviewError';
  }
}

class ConfigError extends AIReviewError {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

class ProviderError extends AIReviewError {
  /**
   * @param {string} message
   * @param {{ provider: string, status?: number, retryable?: boolean }} meta
   */
  constructor(message, meta) {
    super(message);
    this.name = 'ProviderError';
    this.provider = meta.provider;
    this.status = meta.status;
    this.retryable = meta.retryable ?? false;
  }
}

class AuthError extends ProviderError {
  constructor(message, meta) {
    super(message, { ...meta, retryable: false });
    this.name = 'AuthError';
  }
}

/**
 * Thrown when a comment was successfully created via REST but the
 * subsequent GraphQL thread lookup (needed to flip resolved state) failed.
 * The comment exists on the PR; `commentDbId` lets operators locate it.
 */
class OrphanCommentError extends ProviderError {
  /**
   * @param {string} message
   * @param {{ provider: string, status?: number, commentDbId: number|string }} meta
   */
  constructor(message, meta) {
    super(message, { ...meta, retryable: false });
    this.name = 'OrphanCommentError';
    this.commentDbId = meta.commentDbId;
  }
}

class RateLimitError extends ProviderError {
  /**
   * @param {string} message
   * @param {{ provider: string, status?: number, retryAfterMs?: number }} meta
   */
  constructor(message, meta) {
    super(message, { ...meta, retryable: true });
    this.name = 'RateLimitError';
    this.retryAfterMs = meta.retryAfterMs;
  }
}

class LLMError extends AIReviewError {
  /**
   * @param {string} message
   * @param {{ terminal?: boolean }} [opts]  terminal: no model failover either,
   *   for a configuration problem another model must not paper over (ADR-0020)
   */
  constructor(message, { terminal = false } = {}) {
    super(message);
    this.name = 'LLMError';
    this.terminal = terminal;
  }
}

class ValidationError extends AIReviewError {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * True when the error is an LLM transport-layer error that should propagate
 * through callers without being wrapped in a generic `LLMError(status unknown)`.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
function isLLMTransportError(e) {
  return (
    e instanceof AuthError ||
    e instanceof RateLimitError ||
    e instanceof ProviderError ||
    e instanceof LLMError
  );
}

module.exports = {
  AIReviewError,
  ConfigError,
  ProviderError,
  AuthError,
  OrphanCommentError,
  RateLimitError,
  LLMError,
  ValidationError,
  isLLMTransportError,
};
