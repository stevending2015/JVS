/**
 * Hard-delete verification.
 *
 * Deletion is intentionally NOT a soft delete: the row must be gone from the
 * database, not tombstoned. This runs the real purge statements against a real
 * SQLite (node:sqlite) so the claim is checked rather than assumed.
 *
 * The scenario mirrors a real family: a couple with one child, plus a note that
 * points at the mother.
 */

import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('./.schema-for-test.cjs');
const { purgeStatements, detachStatements } = require('./.purge-for-test.cjs');

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

function buildFamily() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema.DDL);
  const now = '2026-01-01T00:00:00Z';
  const person = db.prepare(
    'INSERT INTO person (id, name, gender, created_at, updated_at) VALUES (?,?,?,?,?)',
  );
  person.run('p-father', '陈守业', 'male', now, now);
  person.run('p-mother', '示例祖辈乙', 'female', now, now);
  person.run('p-child', '陈建国', 'male', now, now);

  db.prepare(
    'INSERT INTO family (id, husband_id, wife_id, kind, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('f-1', 'p-father', 'p-mother', 'marriage', now, now);

  db.prepare(
    'INSERT INTO family_child (id, family_id, child_id, pedigree, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('fc-1', 'f-1', 'p-child', 'birth', now, now);

  db.prepare(
    'INSERT INTO note (id, title, body_md, created_at, updated_at, person_id) VALUES (?,?,?,?,?,?)',
  ).run('n-1', '关于母亲', '', now, now, 'p-mother');

  return db;
}

function purge(db, personId) {
  for (const statement of purgeStatements(personId)) db.prepare(statement.sql).run(...statement.params);
}

function ids(db, sql, params = []) {
  return db.prepare(sql).all(...params).map((row) => row.id);
}

// ------------------------------------------------------------------ scenario ---
console.log('1. 删除一位配偶：本人消失、子嗣保留、家庭保留');

const db = buildFamily();
purge(db, 'p-mother');

check('the person row is gone (hard delete, not tombstoned)',
  ids(db, "SELECT id FROM person WHERE id = 'p-mother'").length === 0);
check('no tombstone column value remains for them',
  db.prepare('SELECT COUNT(*) AS n FROM person WHERE deleted_at IS NOT NULL').all()[0].n === 0);
check('the other parent is untouched',
  ids(db, "SELECT id FROM person WHERE id = 'p-father'").length === 1);
check('the child is untouched',
  ids(db, "SELECT id FROM person WHERE id = 'p-child'").length === 1);
check('the family survives so the child keeps a parent',
  ids(db, "SELECT id FROM family WHERE id = 'f-1'").length === 1);
check('the deleted partner slot is cleared',
  db.prepare("SELECT husband_id, wife_id FROM family WHERE id = 'f-1'").all()[0].wife_id === null);
check('the remaining parent keeps the slot',
  db.prepare("SELECT husband_id FROM family WHERE id = 'f-1'").all()[0].husband_id === 'p-father');
check('the child keeps its family link',
  ids(db, "SELECT id FROM family_child WHERE id = 'fc-1'").length === 1);
check('the note survives but loses the dangling pointer',
  db.prepare("SELECT person_id FROM note WHERE id = 'n-1'").all()[0].person_id === null);
check('no row anywhere still points at the deleted person',
  db.prepare('SELECT COUNT(*) AS n FROM family_child WHERE child_id = ?').all('p-mother')[0].n === 0
  && db.prepare('SELECT COUNT(*) AS n FROM family WHERE husband_id = ? OR wife_id = ?').all('p-mother', 'p-mother')[0].n === 0
  && db.prepare('SELECT COUNT(*) AS n FROM note WHERE person_id = ?').all('p-mother')[0].n === 0);

// ------------------------------------------------------- removing the survivors ---
console.log('2. 依次删除剩下的人：空家庭会被回收');

purge(db, 'p-child');
check('child row gone', ids(db, "SELECT id FROM person WHERE id = 'p-child'").length === 0);
check('family still kept while a parent remains',
  ids(db, "SELECT id FROM family WHERE id = 'f-1'").length === 1);
check('child link gone', ids(db, 'SELECT id FROM family_child').length === 0);

purge(db, 'p-father');
check('last person gone', ids(db, 'SELECT id FROM person').length === 0);
check('the now-empty family is reclaimed', ids(db, "SELECT id FROM family WHERE id = 'f-1'").length === 0);
check('no family rows left at all', ids(db, 'SELECT id FROM family').length === 0);
check('the note is still there (it is the user writing, not the person)',
  ids(db, "SELECT id FROM note WHERE id = 'n-1'").length === 1);

// ---------------------------------------------------------------- detach only ---
console.log('3. 仅移出族谱：解除关系，但本人保留在亲友列表');

const detached = buildFamily();
for (const statement of detachStatements('p-mother')) {
  detached.prepare(statement.sql).run(...statement.params);
}

check('the person row SURVIVES a detach',
  ids(detached, "SELECT id FROM person WHERE id = 'p-mother'").length === 1);
check('their birth data is untouched',
  detached.prepare("SELECT name FROM person WHERE id = 'p-mother'").all()[0].name === '示例祖辈乙');
check('no family_child link remains',
  detached.prepare('SELECT COUNT(*) AS n FROM family_child WHERE child_id = ?').all('p-mother')[0].n === 0);
check('no family slot still points at them',
  detached.prepare('SELECT COUNT(*) AS n FROM family WHERE husband_id = ? OR wife_id = ?').all('p-mother', 'p-mother')[0].n === 0);
check('the family stays so the child keeps the other parent',
  ids(detached, "SELECT id FROM family WHERE id = 'f-1'").length === 1);
check('the note keeps its pointer (the person still exists)',
  detached.prepare("SELECT person_id FROM note WHERE id = 'n-1'").all()[0].person_id === 'p-mother');
check('detach never deletes other people',
  ids(detached, 'SELECT id FROM person').length === 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;