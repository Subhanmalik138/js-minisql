'use strict';

const { MiniSqlError } = require('./errors');
const { Column } = require('./database');

function isTruthy(value) {
  return value !== null && value !== false && value !== 0 && value !== '';
}

/** Evaluate a row-level expression. Aggregate calls are rejected here — they are handled by the SELECT path. */
function evalExpr(node, row) {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'column': {
      if (row === null || !(node.name in row)) throw new MiniSqlError(`no column ${node.name}`);
      return row[node.name];
    }
    case 'unary':
      if (node.op === 'NOT') return !isTruthy(evalExpr(node.operand, row));
      throw new MiniSqlError(`unknown unary operator ${node.op}`);
    case 'binary': {
      if (node.op === 'AND') return isTruthy(evalExpr(node.left, row)) && isTruthy(evalExpr(node.right, row));
      if (node.op === 'OR') return isTruthy(evalExpr(node.left, row)) || isTruthy(evalExpr(node.right, row));
      const left = evalExpr(node.left, row);
      const right = evalExpr(node.right, row);
      // SQL-style: any comparison involving NULL is not true.
      if (left === null || right === null) return false;
      switch (node.op) {
        case '=': return left === right;
        case '!=': return left !== right;
        case '<': return left < right;
        case '>': return left > right;
        case '<=': return left <= right;
        case '>=': return left >= right;
        default: throw new MiniSqlError(`unknown operator ${node.op}`);
      }
    }
    case 'function':
      throw new MiniSqlError(`aggregate ${node.name} can only appear in a SELECT list`);
    default:
      throw new MiniSqlError(`unknown expression type ${node.type}`);
  }
}

function containsAggregate(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'function') return true;
  return Object.values(node).some((v) => (Array.isArray(v) ? v.some(containsAggregate) : containsAggregate(v)));
}

function exprLabel(expr) {
  if (expr.type === 'column') return expr.name;
  if (expr.type === 'function') {
    const arg = expr.args[0] === '*' ? '*' : expr.args[0].name;
    return `${expr.name}(${arg})`;
  }
  return 'expr';
}

function computeAggregate(expr, rows) {
  const { name } = expr;
  if (name === 'COUNT') {
    if (expr.args[0] === '*') return rows.length;
    const col = expr.args[0].name;
    return rows.reduce((n, row) => (row[col] !== null && row[col] !== undefined ? n + 1 : n), 0);
  }
  const col = expr.args[0].name;
  const values = rows.map((row) => row[col]).filter((v) => v !== null && v !== undefined);
  if (values.length === 0) return null;
  if (name === 'SUM') return values.reduce((a, b) => a + b, 0);
  if (name === 'AVG') return values.reduce((a, b) => a + b, 0) / values.length;
  if (name === 'MIN') return values.reduce((a, b) => (a < b ? a : b));
  if (name === 'MAX') return values.reduce((a, b) => (a > b ? a : b));
  throw new MiniSqlError(`unknown aggregate ${name}`);
}

/** NULLs sort last, regardless of direction — the least surprising choice. */
function compareValues(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function executeSelect(db, ast) {
  const table = db.table(ast.table);
  const filtered = ast.where ? table.rows.filter((row) => isTruthy(evalExpr(ast.where, row))) : [...table.rows];

  if (ast.columns !== '*' && ast.columns.some((c) => containsAggregate(c.expr))) {
    if (ast.columns.some((c) => !containsAggregate(c.expr))) {
      throw new MiniSqlError('cannot mix aggregate and non-aggregate columns in one SELECT');
    }
    const out = {};
    for (const col of ast.columns) {
      out[col.alias || exprLabel(col.expr)] = computeAggregate(col.expr, filtered);
    }
    return { type: 'rows', columns: Object.keys(out), rows: [out] };
  }

  let projected = filtered.map((row) => {
    if (ast.columns === '*') return { row, out: { ...row } };
    const out = {};
    for (const col of ast.columns) out[col.alias || exprLabel(col.expr)] = evalExpr(col.expr, row);
    return { row, out };
  });

  if (ast.orderBy.length > 0) {
    projected.sort((a, b) => {
      for (const key of ast.orderBy) {
        const cmp = compareValues(evalExpr(key.expr, a.row), evalExpr(key.expr, b.row));
        if (cmp !== 0) return key.direction === 'DESC' ? -cmp : cmp;
      }
      return 0;
    });
  }

  const offset = ast.offset || 0;
  const sliced = ast.limit === null ? projected.slice(offset) : projected.slice(offset, offset + ast.limit);
  const rows = sliced.map((p) => p.out);
  const columns = rows.length > 0
    ? Object.keys(rows[0])
    : (ast.columns === '*' ? table.columns.map((c) => c.name) : ast.columns.map((c) => c.alias || exprLabel(c.expr)));
  return { type: 'rows', columns, rows };
}

function executeInsert(db, ast) {
  const table = db.table(ast.table);
  const targetCols = ast.columns || table.columns.map((c) => c.name);
  for (const colName of targetCols) {
    if (!table.column(colName)) throw new MiniSqlError(`no column ${colName} in table ${ast.table}`);
  }
  let count = 0;
  for (const valueNodes of ast.rows) {
    if (valueNodes.length !== targetCols.length) {
      throw new MiniSqlError(`INSERT has ${valueNodes.length} values for ${targetCols.length} columns`);
    }
    const raw = {};
    targetCols.forEach((colName, i) => { raw[colName] = evalExpr(valueNodes[i], {}); });
    table.insert(raw);
    count += 1;
  }
  return { type: 'count', count, verb: 'inserted' };
}

/** Execute a parsed statement against the database. Returns a result object for the CLI to render. */
function execute(db, ast) {
  switch (ast.kind) {
    case 'createTable': {
      db.createTable(ast.table, ast.columns.map((c) => new Column(c)));
      return { type: 'ok', message: `Table ${ast.table} created.` };
    }
    case 'insert':
      return executeInsert(db, ast);
    case 'select':
      return executeSelect(db, ast);
    case 'update': {
      const table = db.table(ast.table);
      const predicate = ast.where ? (row) => isTruthy(evalExpr(ast.where, row)) : () => true;
      const assignments = {};
      for (const a of ast.assignments) assignments[a.column] = evalExpr(a.value, {});
      const count = table.update(predicate, assignments);
      return { type: 'count', count, verb: 'updated' };
    }
    case 'delete': {
      const table = db.table(ast.table);
      const predicate = ast.where ? (row) => isTruthy(evalExpr(ast.where, row)) : () => true;
      const count = table.delete(predicate);
      return { type: 'count', count, verb: 'deleted' };
    }
    case 'dropTable':
      db.dropTable(ast.table);
      return { type: 'ok', message: `Table ${ast.table} dropped.` };
    case 'showTables':
      return {
        type: 'rows',
        columns: ['table'],
        rows: db.tableNames().map((name) => ({ table: name })),
      };
    default:
      throw new MiniSqlError(`cannot execute ${ast.kind}`);
  }
}

module.exports = { execute, evalExpr, computeAggregate };
