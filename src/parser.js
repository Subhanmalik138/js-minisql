'use strict';

const { MiniSqlError } = require('./errors');
const { tokenize } = require('./tokenizer');
const { TYPES } = require('./database');

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

/**
 * Recursive-descent parser for the MiniSQL dialect:
 *   CREATE TABLE t (col TYPE [PRIMARY KEY | NOT NULL | UNIQUE | DEFAULT v], ...)
 *   INSERT INTO t [(cols)] VALUES (...), (...);
 *   SELECT col | * [, ...] FROM t [WHERE expr] [ORDER BY col [ASC|DESC], ...]
 *          [LIMIT n] [OFFSET n];
 *   UPDATE t SET col = expr [, ...] [WHERE expr];
 *   DELETE FROM t [WHERE expr];
 *   DROP TABLE t;  SHOW TABLES;
 * WHERE expressions support AND / OR / NOT, parentheses, and
 * = != < > <= >= against literals, columns, and aggregate calls (SELECT only).
 */
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }

  next() { return this.tokens[this.pos++]; }

  expect(type, value) {
    const tok = this.next();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new MiniSqlError(`expected ${value || type} but got ${tok.type === 'eof' ? 'end of input' : JSON.stringify(tok.value)}`);
    }
    return tok;
  }

  accept(type, value) {
    const tok = this.peek();
    if (tok.type === type && (value === undefined || tok.value === value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  acceptKeyword(word) { return this.accept('keyword', word); }

  expectKeyword(word) { return this.expect('keyword', word); }

  expectIdentifier() {
    const tok = this.next();
    if (tok.type !== 'identifier') {
      throw new MiniSqlError(`expected identifier but got ${tok.type === 'eof' ? 'end of input' : JSON.stringify(tok.value)}`);
    }
    return tok.value;
  }

  parseStatement() {
    const tok = this.peek();
    if (tok.type !== 'keyword') throw new MiniSqlError('statement must start with a keyword');
    switch (tok.value) {
      case 'CREATE': return this.parseCreateTable();
      case 'INSERT': return this.parseInsert();
      case 'SELECT': return this.parseSelect();
      case 'UPDATE': return this.parseUpdate();
      case 'DELETE': return this.parseDelete();
      case 'DROP': return this.parseDropTable();
      case 'SHOW': return this.parseShowTables();
      default: throw new MiniSqlError(`unsupported statement ${tok.value}`);
    }
  }

  parseCreateTable() {
    this.expectKeyword('CREATE');
    this.expectKeyword('TABLE');
    const table = this.expectIdentifier();
    this.expect('punct', '(');
    const columns = [];
    do {
      const name = this.expectIdentifier();
      const typeTok = this.next();
      if (typeTok.type !== 'identifier' && typeTok.type !== 'keyword') {
        throw new MiniSqlError(`expected a column type for ${name}`);
      }
      const type = String(typeTok.value).toUpperCase();
      if (!TYPES.includes(type)) throw new MiniSqlError(`unsupported type ${type} for column ${name}`);
      const column = { name, type, primaryKey: false, notNull: false, unique: false, defaultValue: undefined };
      while (true) {
        if (this.acceptKeyword('PRIMARY')) {
          this.expectKeyword('KEY');
          column.primaryKey = true;
        } else if (this.acceptKeyword('NOT')) {
          this.expectKeyword('NULL');
          column.notNull = true;
        } else if (this.acceptKeyword('UNIQUE')) {
          column.unique = true;
        } else if (this.acceptKeyword('DEFAULT')) {
          column.defaultValue = this.parseLiteral();
        } else {
          break;
        }
      }
      columns.push(column);
    } while (this.accept('punct', ','));
    this.expect('punct', ')');
    return { kind: 'createTable', table, columns };
  }

  parseInsert() {
    this.expectKeyword('INSERT');
    this.expectKeyword('INTO');
    const table = this.expectIdentifier();
    let columns = null;
    if (this.accept('punct', '(')) {
      columns = [];
      do { columns.push(this.expectIdentifier()); } while (this.accept('punct', ','));
      this.expect('punct', ')');
    }
    this.expectKeyword('VALUES');
    const rows = [];
    do {
      this.expect('punct', '(');
      const values = [];
      do { values.push(this.parseValueExpr()); } while (this.accept('punct', ','));
      this.expect('punct', ')');
      rows.push(values);
    } while (this.accept('punct', ','));
    return { kind: 'insert', table, columns, rows };
  }

  parseSelect() {
    this.expectKeyword('SELECT');
    let columns;
    if (this.accept('star')) {
      columns = '*';
    } else {
      columns = [];
      do {
        const expr = this.parseExpr();
        let alias = null;
        if (this.acceptKeyword('AS')) alias = this.expectIdentifier();
        columns.push({ expr, alias });
      } while (this.accept('punct', ','));
    }
    this.expectKeyword('FROM');
    const table = this.expectIdentifier();
    let where = null;
    if (this.acceptKeyword('WHERE')) where = this.parseExpr();
    let orderBy = [];
    if (this.acceptKeyword('ORDER')) {
      this.expectKeyword('BY');
      do {
        const expr = this.parseExpr();
        let direction = 'ASC';
        if (this.acceptKeyword('ASC')) direction = 'ASC';
        else if (this.acceptKeyword('DESC')) direction = 'DESC';
        orderBy.push({ expr, direction });
      } while (this.accept('punct', ','));
    }
    let limit = null;
    let offset = null;
    if (this.acceptKeyword('LIMIT')) {
      const tok = this.next();
      if (tok.type !== 'number' || !Number.isInteger(tok.value) || tok.value < 0) {
        throw new MiniSqlError('LIMIT requires a non-negative integer');
      }
      limit = tok.value;
    }
    if (this.acceptKeyword('OFFSET')) {
      const tok = this.next();
      if (tok.type !== 'number' || !Number.isInteger(tok.value) || tok.value < 0) {
        throw new MiniSqlError('OFFSET requires a non-negative integer');
      }
      offset = tok.value;
    }
    return { kind: 'select', columns, table, where, orderBy, limit, offset };
  }

  parseUpdate() {
    this.expectKeyword('UPDATE');
    const table = this.expectIdentifier();
    this.expectKeyword('SET');
    const assignments = [];
    do {
      const column = this.expectIdentifier();
      this.expect('operator', '=');
      const value = this.parseValueExpr();
      assignments.push({ column, value });
    } while (this.accept('punct', ','));
    let where = null;
    if (this.acceptKeyword('WHERE')) where = this.parseExpr();
    return { kind: 'update', table, assignments, where };
  }

  parseDelete() {
    this.expectKeyword('DELETE');
    this.expectKeyword('FROM');
    const table = this.expectIdentifier();
    let where = null;
    if (this.acceptKeyword('WHERE')) where = this.parseExpr();
    return { kind: 'delete', table, where };
  }

  parseDropTable() {
    this.expectKeyword('DROP');
    this.expectKeyword('TABLE');
    const table = this.expectIdentifier();
    return { kind: 'dropTable', table };
  }

  parseShowTables() {
    this.expectKeyword('SHOW');
    this.expectKeyword('TABLES');
    return { kind: 'showTables' };
  }

  /** Literal used in DEFAULT clauses: number, string, TRUE/FALSE, or NULL. */
  parseLiteral() {
    const tok = this.next();
    if (tok.type === 'number' || tok.type === 'string') return tok.value;
    if (tok.type === 'keyword' && tok.value === 'TRUE') return true;
    if (tok.type === 'keyword' && tok.value === 'FALSE') return false;
    if (tok.type === 'keyword' && tok.value === 'NULL') return null;
    if (tok.type === 'operator' && tok.value === '-' && this.peek().type === 'number') {
      return -this.next().value;
    }
    throw new MiniSqlError(`expected a literal but got ${tok.type === 'eof' ? 'end of input' : JSON.stringify(tok.value)}`);
  }

  /** Value expressions in INSERT/UPDATE: literal or unary-minus number. */
  parseValueExpr() {
    const tok = this.peek();
    if (tok.type === 'operator' && tok.value === '-' && this.tokens[this.pos + 1]?.type === 'number') {
      this.next();
      return { type: 'literal', value: -this.next().value };
    }
    const lit = this.parseLiteral();
    return { type: 'literal', value: lit };
  }

  // Expression grammar, lowest to highest precedence:
  // OR -> AND -> NOT -> comparison -> primary
  parseExpr() { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.acceptKeyword('OR')) {
      left = { type: 'binary', op: 'OR', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.acceptKeyword('AND')) {
      left = { type: 'binary', op: 'AND', left, right: this.parseNot() };
    }
    return left;
  }

  parseNot() {
    if (this.acceptKeyword('NOT')) {
      return { type: 'unary', op: 'NOT', operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  parseComparison() {
    const left = this.parsePrimary();
    const tok = this.peek();
    if (tok.type === 'operator' && ['=', '!=', '<', '>', '<=', '>='].includes(tok.value)) {
      this.next();
      return { type: 'binary', op: tok.value, left, right: this.parsePrimary() };
    }
    return left;
  }

  parsePrimary() {
    const tok = this.next();
    if (tok.type === 'punct' && tok.value === '(') {
      const expr = this.parseExpr();
      this.expect('punct', ')');
      return expr;
    }
    if (tok.type === 'number' || tok.type === 'string') return { type: 'literal', value: tok.value };
    if (tok.type === 'keyword' && tok.value === 'TRUE') return { type: 'literal', value: true };
    if (tok.type === 'keyword' && tok.value === 'FALSE') return { type: 'literal', value: false };
    if (tok.type === 'keyword' && tok.value === 'NULL') return { type: 'literal', value: null };
    if (tok.type === 'operator' && tok.value === '-' && this.peek().type === 'number') {
      return { type: 'literal', value: -this.next().value };
    }
    if (tok.type === 'identifier') {
      // Aggregate call: COUNT(*), SUM(col), ...
      if (this.peek().type === 'punct' && this.peek().value === '(') {
        const name = tok.value.toUpperCase();
        if (!AGGREGATES.has(name)) throw new MiniSqlError(`unknown function ${tok.value}`);
        this.next();
        let args;
        if (this.accept('star')) args = ['*'];
        else {
          args = [];
          do { args.push(this.parsePrimary()); } while (this.accept('punct', ','));
        }
        this.expect('punct', ')');
        return { type: 'function', name, args };
      }
      return { type: 'column', name: tok.value };
    }
    throw new MiniSqlError(`unexpected token ${tok.type === 'eof' ? 'end of input' : JSON.stringify(tok.value)}`);
  }
}

/** Parse one statement; trailing semicolons are allowed and ignored. */
function parse(sql) {
  const parser = new Parser(tokenize(sql));
  const ast = parser.parseStatement();
  parser.accept('punct', ';');
  if (parser.peek().type !== 'eof') {
    throw new MiniSqlError(`unexpected trailing input ${JSON.stringify(parser.peek().value)}`);
  }
  return ast;
}

module.exports = { Parser, parse, AGGREGATES };
