'use strict';

const { MiniSqlError } = require('./errors');

const TYPES = new Set(['INTEGER', 'REAL', 'TEXT', 'BOOLEAN']);

/**
 * Coerce a raw value into a column's declared type, SQL-style.
 * Strings that look like numbers are accepted for numeric columns; anything
 * else is a hard error, because silently storing the wrong type is how
 * toy databases corrupt data.
 */
function coerceValue(value, type) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'INTEGER': {
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
      if (typeof value === 'boolean') return value ? 1 : 0;
      break;
    }
    case 'REAL': {
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        return Number(value);
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      break;
    }
    case 'TEXT': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      break;
    }
    case 'BOOLEAN': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
      break;
    }
    default:
      throw new MiniSqlError(`unknown type ${type}`);
  }
  throw new MiniSqlError(`cannot coerce ${JSON.stringify(value)} to ${type}`);
}

class Column {
  constructor({ name, type, primaryKey = false, notNull = false, unique = false, defaultValue = undefined }) {
    if (!name) throw new MiniSqlError('column requires a name');
    if (!TYPES.has(type)) throw new MiniSqlError(`unsupported type ${type} for column ${name}`);
    this.name = name;
    this.type = type;
    this.primaryKey = primaryKey;
    // A primary key is implicitly NOT NULL and UNIQUE, like in real databases.
    this.notNull = notNull || primaryKey;
    this.unique = unique || primaryKey;
    this.defaultValue = defaultValue;
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      primaryKey: this.primaryKey,
      notNull: this.notNull,
      unique: this.unique,
      defaultValue: this.defaultValue === undefined ? null : this.defaultValue,
    };
  }

  static fromJSON(data) {
    return new Column({ ...data, defaultValue: data.defaultValue === null ? undefined : data.defaultValue });
  }
}

class Table {
  constructor(name, columns) {
    if (!name) throw new MiniSqlError('table requires a name');
    if (!columns || columns.length === 0) throw new MiniSqlError(`table ${name} needs at least one column`);
    const seen = new Set();
    let pkCount = 0;
    for (const col of columns) {
      if (seen.has(col.name)) throw new MiniSqlError(`duplicate column ${col.name} in table ${name}`);
      seen.add(col.name);
      if (col.primaryKey) pkCount += 1;
    }
    if (pkCount > 1) throw new MiniSqlError(`table ${name} has more than one PRIMARY KEY column`);
    this.name = name;
    this.columns = columns;
    this.rows = [];
  }

  column(name) {
    return this.columns.find((c) => c.name === name) || null;
  }

  /**
   * Validate one row against the schema, apply defaults, and enforce
   * NOT NULL / UNIQUE / PRIMARY KEY. Returns the stored row object.
   * A failed insert leaves the table untouched.
   */
  insert(rawRow) {
    const row = {};
    for (const col of this.columns) {
      let value = rawRow[col.name];
      if (value === undefined) value = col.defaultValue;
      value = coerceValue(value, col.type);
      if (value === null && col.notNull) {
        throw new MiniSqlError(`column ${col.name} may not be NULL`);
      }
      row[col.name] = value;
    }
    for (const col of this.columns) {
      if (!col.unique || row[col.name] === null) continue;
      if (this.rows.some((r) => r[col.name] === row[col.name])) {
        throw new MiniSqlError(`UNIQUE constraint failed: ${this.name}.${col.name} = ${JSON.stringify(row[col.name])}`);
      }
    }
    this.rows.push(row);
    return row;
  }

  /** Update every row matching `predicate`; returns the number of rows changed. */
  update(predicate, assignments) {
    let count = 0;
    for (const row of this.rows) {
      if (!predicate(row)) continue;
      const next = { ...row };
      for (const [colName, value] of Object.entries(assignments)) {
        const col = this.column(colName);
        if (!col) throw new MiniSqlError(`no column ${colName} in table ${this.name}`);
        next[colName] = coerceValue(value, col.type);
        if (next[colName] === null && col.notNull) {
          throw new MiniSqlError(`column ${colName} may not be NULL`);
        }
      }
      for (const col of this.columns) {
        if (!col.unique || next[col.name] === null) continue;
        if (this.rows.some((r) => r !== row && r[col.name] === next[col.name])) {
          throw new MiniSqlError(`UNIQUE constraint failed: ${this.name}.${col.name}`);
        }
      }
      Object.assign(row, next);
      count += 1;
    }
    return count;
  }

  /** Delete every row matching `predicate`; returns the number of rows removed. */
  delete(predicate) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !predicate(row));
    return before - this.rows.length;
  }

  toJSON() {
    return { name: this.name, columns: this.columns.map((c) => c.toJSON()), rows: this.rows };
  }

  static fromJSON(data) {
    const table = new Table(data.name, data.columns.map((c) => Column.fromJSON(c)));
    // Rows were already validated when first inserted; re-insert directly.
    table.rows = data.rows;
    return table;
  }
}

class Database {
  constructor() {
    this.tables = new Map();
  }

  createTable(name, columns) {
    if (this.tables.has(name)) throw new MiniSqlError(`table ${name} already exists`);
    const table = new Table(name, columns);
    this.tables.set(name, table);
    return table;
  }

  dropTable(name) {
    if (!this.tables.delete(name)) throw new MiniSqlError(`no such table ${name}`);
  }

  table(name) {
    const table = this.tables.get(name);
    if (!table) throw new MiniSqlError(`no such table ${name}`);
    return table;
  }

  tableNames() {
    return [...this.tables.keys()];
  }

  toJSON() {
    return { tables: [...this.tables.values()].map((t) => t.toJSON()) };
  }

  static fromJSON(data) {
    const db = new Database();
    for (const tableData of data.tables || []) {
      const table = Table.fromJSON(tableData);
      db.tables.set(table.name, table);
    }
    return db;
  }
}

module.exports = { Column, Table, Database, TYPES: [...TYPES], coerceValue };
