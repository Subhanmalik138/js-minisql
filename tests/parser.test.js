'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/parser');

describe('parser', () => {
  it('parses CREATE TABLE with constraints and defaults', () => {
    const ast = parse('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL DEFAULT 1.5);');
    assert.equal(ast.kind, 'createTable');
    assert.deepEqual(ast.columns[1], {
      name: 'name', type: 'TEXT', primaryKey: false, notNull: true, unique: false, defaultValue: undefined,
    });
    assert.equal(ast.columns[2].defaultValue, 1.5);
  });

  it('parses SELECT with WHERE, ORDER BY, LIMIT, and OFFSET', () => {
    const ast = parse("SELECT a, COUNT(*) AS n FROM t WHERE a > 1 AND NOT (b = 'x') ORDER BY a DESC LIMIT 5 OFFSET 2");
    assert.equal(ast.kind, 'select');
    assert.equal(ast.limit, 5);
    assert.equal(ast.offset, 2);
    assert.equal(ast.orderBy[0].direction, 'DESC');
  });

  it('parses multi-row INSERT and UPDATE/DELETE', () => {
    assert.equal(parse('INSERT INTO t VALUES (1, \'a\'), (2, \'b\');').rows.length, 2);
    assert.equal(parse('UPDATE t SET a = 3 WHERE id = 1;').kind, 'update');
    assert.equal(parse('DELETE FROM t;').kind, 'delete');
  });

  it('rejects bad SQL with a readable error', () => {
    assert.throws(() => parse('SELECT FROM t;'), /unexpected token/);
    assert.throws(() => parse('CREATE TABLE t (a BANANA);'), /unsupported type/);
    assert.throws(() => parse("SELECT * FROM t WHERE a = 'unterminated;"), /unterminated string/);
  });
});
