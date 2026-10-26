/**
 * Two ways to remove somebody from the family tree.
 *
 * 1. DETACH — the person leaves the tree but stays in the birthday / friends list.
 *    Their own data (birthday, notes, timezone) is untouched; only the relations go.
 * 2. PURGE  — the person is deleted outright. Deletion is a HARD delete: no
 *    tombstone, no copy left behind in the file.
 *
 * Both must clear the relations first, otherwise the tree ends up pointing at
 * somebody who is no longer connected:
 *
 *  1. child links (`family_child`)
 *  2. partner slots — the FAMILY row is kept, because its children still need it
 *     and must keep their other parent
 *  3. families left with no partners AND no children are dropped
 *
 * PURGE adds: notes keep existing but lose the pointer, then the person row goes.
 *
 * This module deliberately has no database-client import, so the exact statements
 * can be executed directly against a real SQLite in `scripts/verify-purge.mjs`.
 */

export interface PurgeStatement {
  sql: string;
  params: unknown[];
}

/**
 * Statements that remove a person from every RELATION, keeping the person row.
 * @param personId - person to detach.
 * @returns Ordered statements.
 */
export function detachStatements(personId: string): PurgeStatement[] {
  return [
    // 1) No longer anybody's child.
    { sql: 'DELETE FROM family_child WHERE child_id = ?', params: [personId] },

    // 2) No longer a partner. The family survives so the children keep the other parent.
    { sql: 'UPDATE family SET husband_id = NULL WHERE husband_id = ?', params: [personId] },
    { sql: 'UPDATE family SET wife_id = NULL WHERE wife_id = ?', params: [personId] },

    // 3) Families nobody belongs to any more.
    {
      sql: `DELETE FROM family
             WHERE husband_id IS NULL
               AND wife_id IS NULL
               AND id NOT IN (SELECT family_id FROM family_child)`,
      params: [],
    },
  ];
}

/**
 * Statements that purge a person outright: detach, then delete the row.
 * @param personId - person to purge.
 * @returns Ordered statements.
 */
export function purgeStatements(personId: string): PurgeStatement[] {
  return [
    ...detachStatements(personId),

    // Notes are the user's own writing; keep them, drop the dangling pointer.
    { sql: 'UPDATE note SET person_id = NULL WHERE person_id = ?', params: [personId] },

    // The person.
    { sql: 'DELETE FROM person WHERE id = ?', params: [personId] },
  ];
}