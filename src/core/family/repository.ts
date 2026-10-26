/**
 * Family tree persistence.
 *
 * All relation writes go through here so the invariants are enforced in one place
 * instead of being trusted to the UI:
 *
 *  - a person appears in at most one family as a child with pedigree `birth`
 *  - the same two partners only ever share one family
 *  - nobody is both partner and child of the same family
 *  - adding a parent must not create a cycle (checked before linking)
 */

import { db } from '../db/client.js';
import { readFamilyRoot } from './root.js';
import type { Person, PersonInput } from '../person/types.js';
import { PersonRepository } from '../person/repository.js';
import { newId } from '../util/id.js';
import { detachStatements } from '../person/purge.js';
import type { Family, FamilyChild, FamilyKind, Pedigree, PersonRelations } from './types.js';
import { PEDIGREE_LABELS } from './types.js';

const FAMILY_COLUMNS =
  'id, husband_id, wife_id, kind, marriage_date, divorce_date, note, created_at, updated_at';
const CHILD_COLUMNS =
  'id, family_id, child_id, pedigree, birth_order, created_at, updated_at';

export class FamilyRepository {
  constructor(private readonly persons: PersonRepository) {}

  // ---------------------------------------------------------------- people ---

  listPersons(): Promise<Person[]> {
    return this.persons.list();
  }

  createPerson(input: PersonInput): Promise<Person> {
    return this.persons.create(input);
  }

  updatePerson(id: string, input: PersonInput): Promise<Person> {
    return this.persons.update(id, input);
  }

  /**
   * Remove a person from the tree but KEEP the person record.
   *
   * They disappear as anybody's parent, child or spouse, yet stay in the birthday /
   * friends list with all their own data — the "remove from the tree" half of the
   * delete decision.
   */
  async detachPerson(id: string): Promise<void> {
    for (const statement of detachStatements(id)) {
      await db.run(statement.sql, statement.params);
    }
  }

  async removePerson(id: string): Promise<void> {
    // PersonRepository.remove performs the full purge (relations, note pointers,
    // empty families, the row itself), so every delete path behaves identically.
    await this.persons.remove(id);
  }

  selfId(): Promise<string | null> {
    return this.persons.selfId();
  }

  markSelf(id: string): Promise<void> {
    return this.persons.markSelf(id);
  }

  // --------------------------------------------------------------- families ---

  async listFamilies(): Promise<Family[]> {
    return db.all<Family>(`SELECT ${FAMILY_COLUMNS} FROM family WHERE deleted_at IS NULL`);
  }

  async listChildren(): Promise<FamilyChild[]> {
    return db.all<FamilyChild>(`SELECT ${CHILD_COLUMNS} FROM family_child WHERE deleted_at IS NULL`);
  }

  /**
   * Recompute 世次 (generation) from the structure.
   *
   * A generation is a property of the tree, not something a user should have to
   * keep in sync by hand. Deriving it matters in practice: a person added before
   * their parents existed was "世 1" forever, and filling only the blanks never
   * corrected it once the parents arrived.
   *
   * The graph is walked from 本人 (or from a root when 本人 is unset): a spouse has
   * the same generation, a parent is one above their child. The numbering is then
   * shifted so an existing value keeps acting as the base — type 「第 5 世」 on the
   * founder and everyone else follows relative to it.
   *
   * @returns How many people were rewritten.
   */
  async syncGenerations(): Promise<number> {
    const persons = await this.persons.list();
    if (persons.length === 0) return 0;
    const families = await this.listFamilies();
    const links = await this.listChildren();

    // Undirected graph: spouse 0, parent -> child +1.
    const edges = new Map<string, Array<{ to: string; delta: number }>>();
    const link2 = (a: string, b: string, delta: number): void => {
      edges.set(a, [...(edges.get(a) ?? []), { to: b, delta }]);
    };
    for (const family of families) {
      if (family.husband_id === null || family.wife_id === null) continue;
      link2(family.husband_id, family.wife_id, 0);
      link2(family.wife_id, family.husband_id, 0);
    }
    const parentOf = new Map<string, string[]>();
    for (const link of links) {
      const family = families.find((candidate) => candidate.id === link.family_id);
      if (family === undefined) continue;
      for (const parentId of [family.husband_id, family.wife_id]) {
        if (parentId === null) continue;
        link2(parentId, link.child_id, 1);
        link2(link.child_id, parentId, -1);
        parentOf.set(link.child_id, [...(parentOf.get(link.child_id) ?? []), parentId]);
      }
    }

    // 基准：人指定的根就是第一代；没指定根时退回「本人」，再退回最年长的一代。
    const savedRoot = await readFamilyRoot().catch(() => null);
    const savedRootPerson =
      savedRoot === null ? undefined : persons.find((person) => person.id === savedRoot);
    const self = persons.find((person) => person.is_self === 1);
    const seed =
      savedRootPerson ??
      self ??
      persons.find((person) => (parentOf.get(person.id) ?? []).length === 0) ??
      persons[0];
    if (seed === undefined) return 0;

    const relative = new Map<string, number>();
    const queue: string[] = [seed.id];
    relative.set(seed.id, 0);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const level = relative.get(id) as number;
      for (const edge of edges.get(id) ?? []) {
        if (relative.has(edge.to)) continue;
        relative.set(edge.to, level + edge.delta);
        queue.push(edge.to);
      }
    }

    // 编号以「根」为基准：根是第 1 世，往下每一代 +1。
    //
    // 不用已有的世次值当锚点：那会让过时的数字自我延续 —— 父母还没录入时算成
    // 世 1 的人，等父母来了也永远是世 1。
    const base = 1 - (relative.get(seed.id) ?? 0);

    const now = new Date().toISOString();
    let updated = 0;
    for (const person of persons) {
      const level = relative.get(person.id);
      if (level === undefined) continue;
      const generation = Math.max(1, level + base);
      if (person.generation === generation) continue;
      await db.run(
        'UPDATE person SET generation = ?, updated_at = ? WHERE id = ?',
        [generation, now, person.id],
      );
      updated += 1;
    }
    return updated;
  }

  async createFamily(input: {
    husbandId?: string | null;
    wifeId?: string | null;
    kind?: FamilyKind;
    marriageDate?: string | null;
    note?: string | null;
  }): Promise<Family> {
    const husbandId = input.husbandId ?? null;
    const wifeId = input.wifeId ?? null;
    if (husbandId !== null && wifeId !== null) {
      if (husbandId === wifeId) throw new Error('配偶不能是自己');
      const existing = await this.familyOfPair(husbandId, wifeId);
      if (existing !== null) return existing;
    }
    const now = new Date().toISOString();
    const family: Family = {
      id: newId(),
      husband_id: husbandId,
      wife_id: wifeId,
      kind: input.kind ?? 'marriage',
      marriage_date: input.marriageDate ?? null,
      divorce_date: null,
      note: input.note ?? null,
      created_at: now,
      updated_at: now,
    };
    await db.run(
      `INSERT INTO family (${FAMILY_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        family.id, family.husband_id, family.wife_id, family.kind, family.marriage_date,
        family.divorce_date, family.note, family.created_at, family.updated_at,
      ],
    );
    return family;
  }

  /** Families where the person is a partner. */
  async familiesOf(personId: string): Promise<Family[]> {
    return db.all<Family>(
      `SELECT ${FAMILY_COLUMNS} FROM family
       WHERE deleted_at IS NULL AND (husband_id = ? OR wife_id = ?)
       ORDER BY created_at`,
      [personId, personId],
    );
  }

  async familyOfPair(a: string, b: string): Promise<Family | null> {
    const rows = await db.all<Family>(
      `SELECT ${FAMILY_COLUMNS} FROM family
       WHERE deleted_at IS NULL
         AND ((husband_id = ? AND wife_id = ?) OR (husband_id = ? AND wife_id = ?))
       LIMIT 1`,
      [a, b, b, a],
    );
    return rows.length === 0 ? null : rows[0];
  }

  /** The family a person was born into, if recorded. */
  async birthFamilyOf(personId: string): Promise<{ family: Family; child: FamilyChild } | null> {
    const rows = await db.all<FamilyChild>(
      `SELECT ${CHILD_COLUMNS} FROM family_child
       WHERE deleted_at IS NULL AND child_id = ? AND pedigree = 'birth'
       ORDER BY created_at LIMIT 1`,
      [personId],
    );
    if (rows.length === 0) return null;
    const families = await db.all<Family>(
      `SELECT ${FAMILY_COLUMNS} FROM family WHERE id = ? AND deleted_at IS NULL`,
      [rows[0].family_id],
    );
    return families.length === 0 ? null : { family: families[0], child: rows[0] };
  }

  async parentsOf(personId: string): Promise<{ father: Person | null; mother: Person | null }> {
    const birth = await this.birthFamilyOf(personId);
    if (birth === null) return { father: null, mother: null };
    const father = birth.family.husband_id === null ? null : await this.persons.get(birth.family.husband_id);
    const mother = birth.family.wife_id === null ? null : await this.persons.get(birth.family.wife_id);
    return { father, mother };
  }

  async childrenOf(personId: string): Promise<PersonRelations['children']> {
    const families = await this.familiesOf(personId);
    const result: PersonRelations['children'] = [];
    for (const family of families) {
      const rows = await db.all<FamilyChild>(
        `SELECT ${CHILD_COLUMNS} FROM family_child WHERE deleted_at IS NULL AND family_id = ?
         ORDER BY birth_order IS NULL, birth_order, created_at`,
        [family.id],
      );
      for (const row of rows) {
        const child = await this.persons.get(row.child_id);
        if (child !== null) {
          result.push({
            child,
            pedigree: row.pedigree as Pedigree,
            birthOrder: row.birth_order,
            familyId: family.id,
          });
        }
      }
    }
    return result;
  }

  async spousesOf(personId: string): Promise<PersonRelations['spouses']> {
    const families = await this.familiesOf(personId);
    const result: PersonRelations['spouses'] = [];
    for (const family of families) {
      const otherId = family.husband_id === personId ? family.wife_id : family.husband_id;
      if (otherId === null) continue;
      const spouse = await this.persons.get(otherId);
      if (spouse !== null) result.push({ spouse, family });
    }
    return result;
  }

  async relationsOf(personId: string): Promise<PersonRelations | null> {
    const person = await this.persons.get(personId);
    if (person === null) return null;
    return {
      person,
      parents: await this.parentsOf(personId),
      spouses: await this.spousesOf(personId),
      children: await this.childrenOf(personId),
    };
  }

  // -------------------------------------------------------------- mutations ---

  /**
   * Guard against a cycle: the proposed partner/child chain must not lead back.
   * @param ancestorId - person who would become an ancestor.
   * @param descendantId - person who would become a descendant.
   */
  async assertNoCycle(ancestorId: string, descendantId: string): Promise<void> {
    if (ancestorId === descendantId) throw new Error('不能把自己设为自己的亲属');
    const seen = new Set<string>([descendantId]);
    const queue = [descendantId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const children = await this.childrenOf(current);
      for (const entry of children) {
        if (entry.child.id === ancestorId) throw new Error('该关系会形成循环，已阻止');
        if (!seen.has(entry.child.id)) {
          seen.add(entry.child.id);
          queue.push(entry.child.id);
        }
      }
    }
  }

  /** Attach an existing child to an existing family. */
  async linkChild(input: {
    familyId: string;
    childId: string;
    pedigree?: Pedigree;
    birthOrder?: number | null;
  }): Promise<FamilyChild> {
    const pedigree = input.pedigree ?? 'birth';
    if (pedigree === 'birth') {
      const existing = await this.birthFamilyOf(input.childId);
      if (existing !== null && existing.family.id !== input.familyId) {
        throw new Error('此人已有亲生家庭记录；请先解除原关系，或改用「过继/收养」');
      }
    }
    const family = await db.all<Family>(
      `SELECT ${FAMILY_COLUMNS} FROM family WHERE id = ? AND deleted_at IS NULL`,
      [input.familyId],
    );
    if (family.length === 0) throw new Error('家庭记录不存在');
    if (family[0].husband_id === input.childId || family[0].wife_id === input.childId) {
      throw new Error('此人已是该家庭的配偶，不能再作为子女');
    }
    const now = new Date().toISOString();
    const row: FamilyChild = {
      id: newId(),
      family_id: input.familyId,
      child_id: input.childId,
      pedigree,
      birth_order: input.birthOrder ?? null,
      created_at: now,
      updated_at: now,
    };
    await db.run(
      `INSERT INTO family_child (${CHILD_COLUMNS}) VALUES (?,?,?,?,?,?,?)`,
      [
        row.id, row.family_id, row.child_id, row.pedigree, row.birth_order, row.created_at, row.updated_at,
      ],
    );
    return row;
  }

  /** The family to attach this person's children to, creating one if needed. */
  async ensureOwnFamily(person: Person): Promise<Family> {
    const existing = await this.familiesOf(person.id);
    if (existing.length > 0) return existing[0];
    const asHusband = person.gender !== 'female';
    return this.createFamily(asHusband ? { husbandId: person.id } : { wifeId: person.id });
  }

  /** Create a person and register them as a parent of `personId`. */

  /**
   * Fill in 世次 from the relation when the form left it blank.
   *
   * Traditional 族谱 derive generation from the lineage, so a spouse shares their
   * partner's 世次 and a child sits one generation below their parent. Doing this
   * here keeps the data consistent even when a caller forgets to prefill the field.
   *
   * @param input - submitted person.
   * @param generation - generation implied by the relation, or null when unknown.
   * @returns Input with a generation filled in when it was missing.
   */
  private withGeneration(input: PersonInput, generation: number | null): PersonInput {
    if (input.generation !== undefined && input.generation !== null) return input;
    return { ...input, generation };
  }
    /**
     * Attach an EXISTING person as a parent.
     *
     * Relations are linking operations first and creation second: the birthday
     * module may already own this person, and creating a second row for the same
     * human is exactly the duplication the single `person` table exists to prevent.
     */
    async linkParent(personId: string, parentId: string, role: 'father' | 'mother'): Promise<void> {
      if (personId === parentId) throw new Error('不能把自己设为自己的父母');
      const anchor = await this.persons.get(personId);
      if (anchor === null) throw new Error('记录不存在');
      const parent = await this.persons.get(parentId);
      if (parent === null) throw new Error('要关联的成员不存在');
      await this.assertNoCycle(parentId, personId);

      const expected = anchor.generation === null ? null : Math.max(1, anchor.generation - 1);
      await this.inheritGeneration(parentId, expected);

      const birth = await this.birthFamilyOf(personId);
      if (birth !== null) {
        const slot = role === 'father' ? 'husband_id' : 'wife_id';
        const current = role === 'father' ? birth.family.husband_id : birth.family.wife_id;
        if (current === parentId) return;
        if (current !== null) throw new Error(`此人已有${role === 'father' ? '父' : '母'}亲记录`);
        await db.run(`UPDATE family SET ${slot} = ?, updated_at = ? WHERE id = ?`, [
          parentId, new Date().toISOString(), birth.family.id,
        ]);
        return;
      }
      const family = await this.createFamily(
        role === 'father' ? { husbandId: parentId } : { wifeId: parentId },
      );
      await this.linkChild({ familyId: family.id, childId: personId, pedigree: 'birth' });
    }

    /** Marry two EXISTING people (or remarry: a second union becomes 继配). */
    async linkSpouse(
      personId: string,
      spouseId: string,
      kind?: FamilyKind,
      marriageDate?: string | null,
    ): Promise<void> {
      if (personId === spouseId) throw new Error('配偶不能是自己');
      const anchor = await this.persons.get(personId);
      if (anchor === null) throw new Error('记录不存在');
      const spouse = await this.persons.get(spouseId);
      if (spouse === null) throw new Error('要关联的成员不存在');

      // A second union is 继配 unless told otherwise: that is what a remarriage
      // means in a 族谱, and defaulting to 初婚 made every remarriage read wrong.
      // Count actual SPOUSES, not families. A person can already own a partner-less
      // family (created when a child was added before any spouse existed); counting
      // that as "already married" made the very first 配偶 come out as 继配.
      const existing = await this.spousesOf(personId);
      const resolvedKind: FamilyKind = kind ?? (existing.length > 0 ? 'subsequent' : 'marriage');
      await this.inheritGeneration(spouseId, anchor.generation);

      // Keep GEDCOM's HUSB/WIFE split as a layout hint: place by gender where known.
      const anchorIsHusband = anchor.gender !== 'female';
      await this.createFamily({
        husbandId: anchorIsHusband ? anchor.id : spouse.id,
        wifeId: anchorIsHusband ? spouse.id : anchor.id,
        kind: resolvedKind,
        marriageDate: marriageDate ?? null,
      });
    }

    /** Attach an EXISTING person as a child. */
    async linkExistingChild(
      personId: string,
      childId: string,
      pedigree: Pedigree = 'birth',
      familyId?: string,
    ): Promise<void> {
      if (personId === childId) throw new Error('不能把自己设为自己的子女');
      const parent = await this.persons.get(personId);
      if (parent === null) throw new Error('记录不存在');
      const child = await this.persons.get(childId);
      if (child === null) throw new Error('要关联的成员不存在');
      await this.assertNoCycle(childId, personId);
      await this.inheritGeneration(childId, parent.generation === null ? null : parent.generation + 1);

      let targetFamily: Family | null = null;
      if (familyId !== undefined) {
        const rows = await db.all<Family>(
          `SELECT ${FAMILY_COLUMNS} FROM family WHERE id = ? AND deleted_at IS NULL`,
          [familyId],
        );
        targetFamily = rows.length === 0 ? null : rows[0];
      }
      if (targetFamily === null) targetFamily = await this.ensureOwnFamily(parent);

      const siblings = await db.all<{ n: number | null }>(
        'SELECT MAX(birth_order) AS n FROM family_child WHERE family_id = ? AND deleted_at IS NULL',
        [targetFamily.id],
      );
      await this.linkChild({
        familyId: targetFamily.id,
        childId,
        pedigree,
        birthOrder: (siblings[0]?.n ?? 0) + 1,
      });
    }

    /** Fill in 世次 from the relation, but only when the person has none yet. */
    private async inheritGeneration(personId: string, generation: number | null): Promise<void> {
      if (generation === null) return;
      const person = await this.persons.get(personId);
      if (person === null || person.generation !== null) return;
      await db.run('UPDATE person SET generation = ?, updated_at = ? WHERE id = ?', [
        generation, new Date().toISOString(), personId,
      ]);
    }

    /** Create a person and register them as a parent of `personId`. */
    async addParent(personId: string, input: PersonInput, role: 'father' | 'mother'): Promise<Person> {
      const anchor = await this.persons.get(personId);
      if (anchor === null) throw new Error('记录不存在');

      // Check the slot BEFORE creating: a rejected create must not leave an orphan.
      const birth = await this.birthFamilyOf(personId);
      if (birth !== null) {
        const current = role === 'father' ? birth.family.husband_id : birth.family.wife_id;
        if (current !== null) throw new Error(`此人已有${role === 'father' ? '父' : '母'}亲记录`);
      }

      const parent = await this.persons.create(
        this.withGeneration(input, anchor.generation === null ? null : Math.max(1, anchor.generation - 1)),
      );
      await this.linkParent(personId, parent.id, role);
      return parent;
    }

    /** Create a person and register them as a spouse of `personId`. */
    async addSpouse(
      personId: string,
      input: PersonInput,
      kind?: FamilyKind,
      marriageDate?: string | null,
    ): Promise<Person> {
      const anchor = await this.persons.get(personId);
      if (anchor === null) throw new Error('记录不存在');
      const spouse = await this.persons.create(this.withGeneration(input, anchor.generation));
      await this.linkSpouse(personId, spouse.id, kind, marriageDate);
      return spouse;
    }

    /** Create a person and attach them as a child of `personId`. */
    async addChild(
      personId: string,
      input: PersonInput,
      pedigree: Pedigree = 'birth',
      familyId?: string,
    ): Promise<Person> {
      const parent = await this.persons.get(personId);
      if (parent === null) throw new Error('记录不存在');
      const child = await this.persons.create(
        this.withGeneration(input, parent.generation === null ? null : parent.generation + 1),
      );
      await this.linkExistingChild(personId, child.id, pedigree, familyId);
      return child;
    }
    /**
     * Mark a marriage as ended (divorced) or restore it.
     *
     * Kept as a date rather than a boolean so the record can say when, and so the
     * tree can draw the dashed 「离」 tie.
     *
     * @param familyId - family unit.
     * @param divorced - true to mark, false to clear.
     * @param date - ISO date; defaults to today when marking.
     */
  async setDivorced(familyId: string, divorced: boolean, date?: string): Promise<void> {
    const now = new Date().toISOString();
    const value = divorced ? (date ?? now.slice(0, 10)) : null;
    await db.run('UPDATE family SET divorce_date = ?, updated_at = ? WHERE id = ?', [value, now, familyId]);
  }

  async unlinkChild(familyChildId: string): Promise<void> {
    const now = new Date().toISOString();
    await db.run('UPDATE family_child SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      now, now, familyChildId,
    ]);
  }

  async removeFamily(familyId: string): Promise<void> {
    const now = new Date().toISOString();
    await db.run('UPDATE family SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, familyId]);
    await db.run('UPDATE family_child SET deleted_at = ?, updated_at = ? WHERE family_id = ?', [
      now, now, familyId,
    ]);
  }

  /** Human-readable pedigree label. */
  static pedigreeLabel(pedigree: string): string {
    return PEDIGREE_LABELS[pedigree as Pedigree] ?? pedigree;
  }
}