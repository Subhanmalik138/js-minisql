'use strict';

/**
 * Every user-facing failure in MiniSQL is a MiniSqlError: a parse error, a
 * constraint violation, or an execution error. The CLI prints just the
 * message, never a stack trace, so errors read like a real database's.
 */
class MiniSqlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MiniSqlError';
  }
}

module.exports = { MiniSqlError };
