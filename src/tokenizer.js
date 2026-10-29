'use strict';

const { MiniSqlError } = require('./errors');

const KEYWORDS = new Set([
  'CREATE', 'TABLE', 'PRIMARY', 'KEY', 'NOT', 'NULL', 'UNIQUE', 'DEFAULT',
  'INSERT', 'INTO', 'VALUES', 'SELECT', 'FROM', 'WHERE', 'AND', 'OR',
  'UPDATE', 'SET', 'DELETE', 'DROP', 'SHOW', 'TABLES', 'ORDER', 'BY',
  'ASC', 'DESC', 'LIMIT', 'OFFSET', 'AS', 'TRUE', 'FALSE',
]);

/**
 * Tokenizer for the MiniSQL dialect. Keywords are case-insensitive;
 * identifiers keep their written case. String literals use single quotes
 * with '' as the escape for a literal quote, like standard SQL.
 */
function tokenize(input) {
  const tokens = [];
  let i = 0;
  const push = (type, value) => tokens.push({ type, value });

  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '-' && input[i + 1] === '-') { // -- comment to end of line
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === "'") {
      let value = '';
      let closed = false;
      i += 1;
      while (i < input.length) {
        if (input[i] === "'") {
          if (input[i + 1] === "'") { value += "'"; i += 2; }
          else { i += 1; closed = true; break; }
        } else {
          value += input[i];
          i += 1;
        }
      }
      if (!closed) throw new MiniSqlError('unterminated string literal');
      push('string', value);
      continue;
    }
    if (ch === '"') { // quoted identifier
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') { value += input[i]; i += 1; }
      if (i >= input.length) throw new MiniSqlError('unterminated quoted identifier');
      i += 1;
      push('identifier', value);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] || ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] || '')) {
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      push('number', Number(input.slice(i, j)));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      const word = input.slice(i, j);
      const upper = word.toUpperCase();
      push(KEYWORDS.has(upper) ? 'keyword' : 'identifier', KEYWORDS.has(upper) ? upper : word);
      i = j;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (['!=', '<>', '<=', '>='].includes(two)) { push('operator', two === '<>' ? '!=' : two); i += 2; continue; }
    if ('(),;*='.includes(ch)) { push(ch === '*' ? 'star' : ch === '=' ? 'operator' : 'punct', ch); i += 1; continue; }
    if ('<>'.includes(ch)) { push('operator', ch); i += 1; continue; }
    throw new MiniSqlError(`unexpected character ${JSON.stringify(ch)}`);
  }
  push('eof', null);
  return tokens;
}

module.exports = { tokenize, KEYWORDS };
