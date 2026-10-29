'use strict';

const fs = require('fs');
const { Database } = require('./database');

/** Write the whole database as pretty JSON. Atomic-ish: write temp, then rename. */
function saveDatabase(db, path) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db.toJSON(), null, 2));
  fs.renameSync(tmp, path);
}

/** Read a JSON file back into a Database; throws a plain Error with context. */
function loadDatabase(path) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`could not read database file ${path}: ${err.message}`);
  }
  return Database.fromJSON(data);
}

module.exports = { saveDatabase, loadDatabase };
