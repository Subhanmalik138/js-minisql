#!/usr/bin/env node
'use strict';

const fs = require('fs');
const readline = require('readline');
const { Database } = require('./database');
const { parse } = require('./parser');
const { execute } = require('./engine');
const { MiniSqlError } = require('./errors');

const HELP = `MiniSQL — a tiny SQL database engine. Statements end with ;
Meta commands (REPL only):
  .help            show this help
  .tables          list tables
  .schema <table>  show a table's columns
  .save [file]     write the database to a JSON file
  .load <file>     replace the database with a JSON file's contents
  .exit            quit (auto-saves when a database file was given)`;

function renderResult(result) {
  if (result.type === 'ok') {
    console.log(result.message);
    return;
  }
  if (result.type === 'count') {
    console.log(`${result.count} row(s) ${result.verb}.`);
    return;
  }
  if (result.type === 'rows') {
    if (result.rows.length === 0) {
      console.log('(0 rows)');
      return;
    }
    const widths = result.columns.map((col) => Math.max(
      col.length,
      ...result.rows.map((row) => String(row[col] === null ? 'NULL' : row[col]).length),
    ));
    const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ');
    console.log(line(result.columns));
    console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
    for (const row of result.rows) {
      console.log(line(result.columns.map((col) => (row[col] === null ? 'NULL' : row[col]))));
    }
    console.log(`(${result.rows.length} row(s))`);
  }
}

/** Split a script into statements on semicolons that are not inside string literals. */
function splitStatements(script) {
  const statements = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (ch === "'") {
      if (inString && script[i + 1] === "'") { current += "''"; i += 1; }
      else { inString = !inString; current += ch; }
    } else if (ch === ';' && !inString) {
      if (current.trim()) statements.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}

/** True when the buffer holds a complete statement: ends with ; outside a string literal. */
function statementComplete(buffer) {
  let inString = false;
  let last = '';
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i];
    if (ch === "'") {
      if (inString && buffer[i + 1] === "'") i += 1;
      else inString = !inString;
    } else if (!inString && !/\s/.test(ch)) {
      last = ch;
    }
  }
  return !inString && last === ';';
}

function saveDatabase(db, path) {
  fs.writeFileSync(path, JSON.stringify(db.toJSON(), null, 2));
  console.log(`Saved to ${path}`);
}

function loadDatabase(path) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  return Database.fromJSON(data);
}

function runStatement(db, sql) {
  const result = execute(db, parse(sql));
  renderResult(result);
}

function main() {
  const args = process.argv.slice(2);
  let dbPath = null;
  let scriptPath = null;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: minisql [database.json] [script.sql]\n\n${HELP}`);
      process.exit(0);
    }
    if (!dbPath) dbPath = arg;
    else if (!scriptPath) scriptPath = arg;
  }

  let db = new Database();
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      db = loadDatabase(dbPath);
      console.log(`Loaded ${db.tableNames().length} table(s) from ${dbPath}`);
    } catch (err) {
      console.error(`Error: could not load ${dbPath}: ${err.message}`);
      process.exit(1);
    }
  }

  if (scriptPath) {
    let failed = false;
    for (const stmt of splitStatements(fs.readFileSync(scriptPath, 'utf8'))) {
      try {
        runStatement(db, stmt);
      } catch (err) {
        console.error(`Error: ${err instanceof MiniSqlError ? err.message : err.message}`);
        failed = true;
      }
    }
    if (dbPath) saveDatabase(db, dbPath);
    process.exit(failed ? 1 : 0);
  }

  console.log('MiniSQL — type SQL ending with ;  (try .help, .tables, .exit)');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'minisql> ' });
  let buffer = '';

  const finish = () => {
    if (dbPath) {
      try { saveDatabase(db, dbPath); } catch (err) { console.error(`Error: ${err.message}`); }
    }
    rl.close();
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!buffer && trimmed.startsWith('.')) {
      const [cmd, ...rest] = trimmed.split(/\s+/);
      switch (cmd) {
        case '.help': console.log(HELP); break;
        case '.tables': {
          const names = db.tableNames();
          console.log(names.length ? names.join('\n') : '(no tables)');
          break;
        }
        case '.schema': {
          if (!rest[0]) { console.log('Usage: .schema <table>'); break; }
          try {
            const table = db.table(rest[0]);
            table.columns.forEach((c) => {
              const flags = [c.primaryKey ? 'PRIMARY KEY' : null, c.notNull && !c.primaryKey ? 'NOT NULL' : null, c.unique && !c.primaryKey ? 'UNIQUE' : null]
                .filter(Boolean).join(' ');
              console.log(`  ${c.name} ${c.type}${flags ? ` ${flags}` : ''}${c.defaultValue !== undefined ? ` DEFAULT ${JSON.stringify(c.defaultValue)}` : ''}`);
            });
          } catch (err) { console.log(`Error: ${err.message}`); }
          break;
        }
        case '.save': {
          const target = rest[0] || dbPath;
          if (!target) { console.log('Usage: .save <file>'); break; }
          try { saveDatabase(db, target); if (!dbPath) dbPath = target; } catch (err) { console.log(`Error: ${err.message}`); }
          break;
        }
        case '.load': {
          if (!rest[0]) { console.log('Usage: .load <file>'); break; }
          try { db = loadDatabase(rest[0]); dbPath = rest[0]; console.log(`Loaded ${db.tableNames().length} table(s)`); } catch (err) { console.log(`Error: ${err.message}`); }
          break;
        }
        case '.exit':
        case '.quit':
          finish();
          return;
        default:
          console.log(`Unknown command ${cmd} — try .help`);
      }
      rl.prompt();
      return;
    }
    buffer += (buffer ? '\n' : '') + line;
    if (statementComplete(buffer)) {
      try {
        runStatement(db, buffer);
      } catch (err) {
        console.log(`Error: ${err instanceof MiniSqlError ? err.message : err.message}`);
      }
      buffer = '';
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
  rl.prompt();
}

main();
