'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/database');
const { parse } = require('../src/parser');
const { execute } = require('../src/engine');
const { saveDatabase, loadDatabase } = require('../src/persistence');

function seededDb() {
  const db = new Database();
  const stmts = [
    'CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, price REAL, stock INTEGER DEFAULT 0);',
    "INSERT INTO books VALUES (1, 'Dune', 19.99, 12), (2, 'Neuromancer', 14.50, 0), (3, 'Foundation', 17.00, 5);",
  ];
  for (const sql of stmts) execute(db, parse(sql));
  return db;
}

describe('engine', () => {
  it('filters with AND/OR/NOT and sorts with LIMIT', () => {
    const db = seededDb();
    const res = execute(db, parse('SELECT title FROM books WHERE stock > 0 AND NOT (price > 18) ORDER BY price DESC LIMIT 1;'));
    assert.deepEqual(res.rows, [{ title: 'Foundation' }]);
  });

  it('computes aggregates and rejects mixed aggregate/non-aggregate selects', () => {
    const db = seededDb();
    const res = execute(db, parse('SELECT COUNT(*) AS n, SUM(stock) AS units, AVG(price) AS avg FROM books;'));
    assert.equal(res.rows[0].n, 3);
    assert.equal(res.rows[0].units, 17);
    assert.throws(() => execute(db, parse('SELECT title, COUNT(*) FROM books;')), /mix aggregate/);
  });

  it('updates and deletes only matching rows', () => {
    const db = seededDb();
    assert.equal(execute(db, parse('UPDATE books SET stock = 20 WHERE id = 2;')).count, 1);
    assert.equal(execute(db, parse('DELETE FROM books WHERE stock = 0;')).count, 0);
    assert.equal(execute(db, parse('DELETE FROM books WHERE stock >= 20;')).count, 1);
  });

  it('treats NULL comparisons as not true', () => {
    const db = seededDb();
    execute(db, parse("INSERT INTO books (id, title) VALUES (4, 'Untitled');"));
    const res = execute(db, parse('SELECT id FROM books WHERE price > 0;'));
    assert.deepEqual(res.rows.map((r) => r.id), [1, 2, 3]);
  });

  it('rejects inserts that violate constraints', () => {
    const db = seededDb();
    assert.throws(() => execute(db, parse("INSERT INTO books VALUES (1, 'Dup', 1, 1);")), /UNIQUE constraint failed/);
    assert.throws(() => execute(db, parse('INSERT INTO books (id) VALUES (9);')), /may not be NULL/);
  });
});

describe('persistence', () => {
  it('saves and reloads a database from disk', () => {
    const db = seededDb();
    const file = path.join(os.tmpdir(), `minisql-test-${process.pid}.json`);
    try {
      saveDatabase(db, file);
      const restored = loadDatabase(file);
      assert.equal(restored.table('books').rows.length, 3);
      assert.equal(restored.table('books').rows[0].title, 'Dune');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
