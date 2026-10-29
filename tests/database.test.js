'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Database, Column } = require('../src/database');

function usersTable(db) {
  return db.createTable('users', [
    new Column({ name: 'id', type: 'INTEGER', primaryKey: true }),
    new Column({ name: 'name', type: 'TEXT', notNull: true }),
    new Column({ name: 'age', type: 'INTEGER', defaultValue: 0 }),
  ]);
}

describe('Table constraints', () => {
  it('applies defaults and coerces string numbers', () => {
    const db = new Database();
    const t = usersTable(db);
    const row = t.insert({ id: '7', name: 'Ada' });
    assert.equal(row.age, 0);
    assert.equal(row.id, 7);
  });

  it('rejects duplicate primary keys and null NOT NULL columns', () => {
    const db = new Database();
    const t = usersTable(db);
    t.insert({ id: 1, name: 'Ada' });
    assert.throws(() => t.insert({ id: 1, name: 'Bo' }), /UNIQUE constraint failed/);
    assert.throws(() => t.insert({ id: 2, name: null }), /may not be NULL/);
  });

  it('rejects a second PRIMARY KEY column and duplicate column names', () => {
    assert.throws(() => new Database().createTable('t', [
      new Column({ name: 'a', type: 'INTEGER', primaryKey: true }),
      new Column({ name: 'b', type: 'INTEGER', primaryKey: true }),
    ]), /more than one PRIMARY KEY/);
    assert.throws(() => new Database().createTable('t', [
      new Column({ name: 'a', type: 'INTEGER' }),
      new Column({ name: 'a', type: 'TEXT' }),
    ]), /duplicate column/);
  });

  it('update enforces UNIQUE and delete returns the removed count', () => {
    const db = new Database();
    const t = usersTable(db);
    t.insert({ id: 1, name: 'Ada', age: 30 });
    t.insert({ id: 2, name: 'Bo', age: 20 });
    assert.throws(() => t.update(() => true, { id: 2 }), /UNIQUE constraint failed/);
    assert.equal(t.update((r) => r.age < 25, { age: 21 }), 1);
    assert.equal(t.delete((r) => r.age === 21), 1);
    assert.equal(t.rows.length, 1);
  });
});

describe('Database serialization', () => {
  it('round-trips tables, schemas, and rows through JSON', () => {
    const db = new Database();
    usersTable(db).insert({ id: 1, name: 'Ada', age: 36 });
    const restored = Database.fromJSON(db.toJSON());
    assert.deepEqual(restored.table('users').rows, [{ id: 1, name: 'Ada', age: 36 }]);
    assert.equal(restored.table('users').column('name').notNull, true);
  });
});
