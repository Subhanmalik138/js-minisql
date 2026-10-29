# MiniSQL

A tiny SQL database engine in zero-dependency Node.js. It parses a real
subset of SQL, enforces table schemas and constraints, and persists the
whole database as JSON — small enough to read in one sitting, complete
enough to actually use.

## What it can do

- **DDL**: `CREATE TABLE` (with `PRIMARY KEY`, `NOT NULL`, `UNIQUE`,
  `DEFAULT`), `DROP TABLE`, `SHOW TABLES`
- **DML**: multi-row `INSERT`, `UPDATE`, `DELETE`
- **Queries**: `SELECT` with column lists or `*`, `WHERE` (`AND` / `OR` /
  `NOT`, parentheses, `= != < > <= >=`), `ORDER BY`, `LIMIT`, `OFFSET`,
  and aggregates (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`)
- **Types**: `INTEGER`, `REAL`, `TEXT`, `BOOLEAN`, with SQL-style coercion
  and `NULL` semantics (a comparison involving `NULL` is never true)
- **Persistence**: the database lives in a JSON file, saved atomically
  (write-temp-then-rename) so a crash mid-save can't corrupt it

## Quick start

```sh
node src/cli.js mydb.json        # interactive REPL, auto-saves on exit
node src/cli.js mydb.json demo.sql   # run a script, then save
```

```sql
CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, price REAL, stock INTEGER DEFAULT 0);
INSERT INTO books VALUES (1, 'Dune', 19.99, 12), (2, 'Neuromancer', 14.50, 0);
SELECT title, price FROM books WHERE stock > 0 ORDER BY price DESC;
SELECT COUNT(*) AS total, SUM(stock) AS units, AVG(price) AS avg_price FROM books;
```

REPL meta commands: `.tables`, `.schema <table>`, `.save [file]`,
`.load <file>`, `.help`, `.exit`.

## Design decisions

1. **Parser before engine.** SQL text goes through a real tokenizer and a
   recursive-descent parser into an AST; the engine never sees raw strings.
   That separation is what makes `WHERE` precedence, errors, and testing
   tractable — and it's the same shape real databases use.
2. **Constraints enforced at the storage layer, not the parser.**
   `Table.insert` / `update` own `NOT NULL`, `UNIQUE`, and primary-key
   checks, so no execution path can bypass them.
3. **Coercion is strict.** `'42'` becomes `42` for an `INTEGER` column,
   but `'abc'` is an error, not a silent `0`. A toy database that quietly
   stores the wrong type teaches the wrong lesson.
4. **Zero dependencies.** The only runtime needs are Node 18+ builtins
   (`readline`, `node:test`). Nothing to install, nothing to audit.

## Project layout

```
src/
  database.js    tables, columns, types, constraints, serialization
  tokenizer.js   SQL tokenizer (keywords, literals, quoted identifiers)
  parser.js      recursive-descent parser producing an AST
  engine.js      expression evaluation and statement execution
  persistence.js atomic JSON save / load
  cli.js         REPL + script runner
tests/           node:test suites for database, parser, and engine
examples/demo.sql  a runnable tour of the dialect
```

## Run the tests

```sh
npm test
```

## Tech stack

Node.js 18+ (CommonJS, no dependencies), `node:test` for tests.
