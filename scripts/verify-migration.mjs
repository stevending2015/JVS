/**
 * Migration regression test: v1 database -> current schema.
 *
 * The app's Playwright suites always start from an empty profile, so they never
 * exercised the UPGRADE path — which is exactly where a real bug shipped: the DDL
 * created an index over the new `generation` column before that column existed on
 * an old table, the batch aborted at the first error, and the app could not start
 * ("no such column: generation").
 *
 * This runs the migration statements against a real SQLite (node:sqlite, Node 24)
 * with a v1-shaped database, so the ordering is covered without a browser.
 */

import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('./.schema-for-test.cjs');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A person table as shipped by schema v1: no 中式著录 columns, no family tables. */
const V1_DDL = `
CREATE TABLE person (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  gender               TEXT NOT NULL DEFAULT 'unspecified',
  relation_label       TEXT,
  note                 TEXT,
  calendar_system      TEXT,
  date_fields_json     TEXT,
  birth_timezone       TEXT,
  shichen              TEXT,
  gregorian_local_date TEXT,
  zodiac_sign          TEXT,
  shengxiao            TEXT,
  is_self              INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT
);
CREATE TABLE relation (
  id             TEXT PRIMARY KEY,
  from_person_id TEXT NOT NULL,
  to_person_id   TEXT NOT NULL,
  kind           TEXT NOT NULL
);
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
`;

function freshV1() {
  const db = new DatabaseSync(':memory:');
  db.exec(V1_DDL);
  db.exec("INSERT INTO app_meta (key, value) VALUES ('schema_version', '1')");
  db.exec(
    "INSERT INTO person (id, name, gender, created_at, updated_at) VALUES ('p1', '旧数据甲', 'male', '2026-01-01', '2026-01-01')",
  );
  return db;
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

// ---------------------------------------------------------------- the real run ---
console.log('1. v1 数据库按修复后的顺序迁移');

const db = freshV1();
db.exec(schema.DDL);
const before = columnNames(db, 'person');
for (const addition of schema.PERSON_COLUMN_ADDITIONS) {
  if (!before.includes(addition.name)) db.exec(addition.ddl);
}
db.exec(schema.DDL_INDEXES);
db.exec('DROP TABLE IF EXISTS relation');
db.exec("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '" + schema.SCHEMA_VERSION + "')");

const after = columnNames(db, 'person');
const missing = schema.REQUIRED_PERSON_COLUMNS.filter((name) => !after.includes(name));
check('every required person column exists after migration', missing.length === 0, missing.join(','));

for (const column of ['generation', 'generation_char', 'courtesy_name', 'art_name', 'ranking', 'native_place', 'burial_place', 'death_date']) {
  check(`new column present: ${column}`, after.includes(column));
}

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
check('family table created', tables.includes('family'));
check('family_child table created', tables.includes('family_child'));
check('superseded relation table dropped', !tables.includes('relation'));

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
check('index over a v2 column exists', indexes.includes('idx_person_generation'));

const legacy = db.prepare('SELECT id, name, generation FROM person').all();
check('legacy row survived the migration', legacy.length === 1 && legacy[0].name === '旧数据甲');
check('legacy row got NULL for the new column', legacy[0].generation === null, String(legacy[0].generation));

const version = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").all()[0].value;
check('schema_version bumped', version === String(schema.SCHEMA_VERSION), version);

// ------------------------------------------------------- the ordering that broke ---
console.log('2. 复现旧顺序（先建索引后补列）确实会失败');

const broken = freshV1();
broken.exec(schema.DDL);
let oldOrderError = null;
try {
  broken.exec(schema.DDL_INDEXES); // before the columns are added
} catch (error) {
  oldOrderError = error.message;
}
check('creating the index before the column fails (this was the shipped bug)', oldOrderError !== null, String(oldOrderError));
check('failure message names the missing column', /no such column|generation/i.test(String(oldOrderError)), String(oldOrderError));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;