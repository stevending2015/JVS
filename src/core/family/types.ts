/**
 * Family tree domain types, following GEDCOM 7's two-record model.
 *
 * A `Family` is a union of up to two partners; children are attached to it with
 * an explicit pedigree. This is why "sibling" is not stored anywhere: siblings are
 * simply children of the same family, and storing them would be derived data that
 * drifts out of sync.
 */

/** How a child belongs to a family (入嗣方式). */
export type Pedigree = 'birth' | 'adopted' | 'step' | 'foster' | 'inherit' | 'uxorilocal';

/** What kind of union this family is (婚配方式). */
export type FamilyKind = 'marriage' | 'subsequent' | 'concubine' | 'uxorilocal' | 'unmarried';

export const PEDIGREE_LABELS: Record<Pedigree, string> = {
  birth: '亲生',
  adopted: '收养',
  step: '继子女',
  foster: '寄养',
  inherit: '过继',
  uxorilocal: '入赘',
};

export const FAMILY_KIND_LABELS: Record<FamilyKind, string> = {
  marriage: '初婚',
  subsequent: '继配',
  concubine: '侧室',
  uxorilocal: '入赘',
  unmarried: '未婚',
};

export const PEDIGREES = Object.keys(PEDIGREE_LABELS) as Pedigree[];
export const FAMILY_KINDS = Object.keys(FAMILY_KIND_LABELS) as FamilyKind[];

export interface Family {
  id: string;
  husband_id: string | null;
  wife_id: string | null;
  kind: string;
  marriage_date: string | null;
  divorce_date: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface FamilyChild {
  id: string;
  family_id: string;
  child_id: string;
  pedigree: string;
  birth_order: number | null;
  created_at: string;
  updated_at: string;
}

/** A person together with the relations needed to draw or list them. */
export interface PersonRelations {
  person: import('../person/types.js').Person;
  parents: { father: import('../person/types.js').Person | null; mother: import('../person/types.js').Person | null };
  spouses: Array<{ spouse: import('../person/types.js').Person; family: Family }>;
  children: Array<{ child: import('../person/types.js').Person; pedigree: Pedigree; birthOrder: number | null; familyId: string }>;
}