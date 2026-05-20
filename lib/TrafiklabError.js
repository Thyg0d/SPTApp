'use strict';

/**
 * Typed error for Trafiklab API failures.
 * Carries a machine-readable code so callers can branch on the failure type
 * without parsing error messages.
 */
class TrafiklabError extends Error {
  /**
   * @param {string} message  Human-readable description
   * @param {string} code     Machine-readable code: INVALID_KEY | RATE_LIMIT | NOT_FOUND |
   *                          NO_DATA | NETWORK | TIMEOUT | PARSE | SERVER | UNKNOWN
   * @param {number} [statusCode]  HTTP status code when applicable
   */
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'TrafiklabError';
    this.code = code;
    this.statusCode = statusCode || null;
  }
}

module.exports = TrafiklabError;
