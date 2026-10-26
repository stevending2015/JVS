/**
 * GEDCOM 7 export.
 *
 * The schema was designed around GEDCOM's two-record model, so exporting is mostly
 * serialisation. Notes:
 *  - INDI names are emitted as-is (CJK names have no reliable given/surname split
 *    from a single field, and most tools accept a name without slashes)
 *  - dates go from ISO to GEDCOM `DD MMM YYYY`
 *  - 入嗣方式 becomes `FAMC` + `PEDI`; the finer Chinese pedigree is mirrored in a
 *    custom `_PEDI` tag so it survives a round trip through our own importer
 */

import type { Person } from '../person/types.js';
import { PEDIGREE_LABELS, type Family, type FamilyChild, type Pedigree } from './types.js';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** ISO date or bare year -> GEDCOM date. */
function gedcomDate(value: string | null): string | null {
  if (value === null || value === '') return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso !== null) {
    const day = String(Number(iso[3]));
    const month = MONTHS[Number(iso[2]) - 1] ?? 'JAN';
    return `${day} ${month} ${iso[1]}`;
  }
  if (/^\d{4}$/.test(value)) return value;
  return value;
}

function sexCode(gender: string): string | null {
  if (gender === 'male') return 'M';
  if (gender === 'female') return 'F';
  if (gender === 'other') return 'X';
  return null;
}

/** Map our pedigree onto GEDCOM's PEDI vocabulary. */
function pediCode(pedigree: string): string {
  if (pedigree === 'birth') return 'birth';
  if (pedigree === 'adopted') return 'adopted';
  if (pedigree === 'foster') return 'foster';
  return 'other';
}

/**
 * Serialise the whole family to a GEDCOM 7 document.
 * @param input - persons, families and their links.
 * @returns The file contents.
 */
export function exportGedcom(input: {
  persons: Person[];
  families: Family[];
  children: FamilyChild[];
}): string {
  const lines: string[] = [];
  const indiRef = new Map<string, string>();
  const famRef = new Map<string, string>();

  input.persons.forEach((person, index) => indiRef.set(person.id, `@I${index + 1}@`));
  input.families.forEach((family, index) => famRef.set(family.id, `@F${index + 1}@`));

  const famcByChild = new Map<string, FamilyChild[]>();
  const famsByPartner = new Map<string, string[]>();
  for (const row of input.children) {
    const list = famcByChild.get(row.child_id) ?? [];
    list.push(row);
    famcByChild.set(row.child_id, list);
  }
  for (const family of input.families) {
    for (const partner of [family.husband_id, family.wife_id]) {
      if (partner === null) continue;
      const list = famsByPartner.get(partner) ?? [];
      list.push(family.id);
      famsByPartner.set(partner, list);
    }
  }

  const now = new Date();
  lines.push('0 HEAD');
  lines.push('1 GEDC');
  lines.push('2 VERS 7.0');
  lines.push('1 CHAR UTF-8');
  lines.push(`1 DATE ${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`);
  lines.push('1 SOUR JVS');
  lines.push('2 NAME JVS 一体化个人生活应用');

  for (const person of input.persons) {
    const ref = indiRef.get(person.id) as string;
    lines.push(`0 ${ref} INDI`);
    lines.push(`1 NAME ${person.name}`);
    if (person.courtesy_name !== null) lines.push(`1 NAME ${person.courtesy_name}`);
    lines.push('2 TYPE 字');
    if (person.art_name !== null) {
      lines.push(`1 NAME ${person.art_name}`);
      lines.push('2 TYPE 号');
    }
    const sex = sexCode(person.gender);
    if (sex !== null) lines.push(`1 SEX ${sex}`);
    if (person.gregorian_local_date !== null) {
      const date = gedcomDate(person.gregorian_local_date);
      if (date !== null) {
        lines.push('1 BIRT');
        lines.push(`2 DATE ${date}`);
      }
    }
    const death = gedcomDate(person.death_date);
    if (death !== null) {
      lines.push('1 DEAT');
      lines.push(`2 DATE ${death}`);
      if (person.burial_place !== null) lines.push(`2 PLAC ${person.burial_place}`);
    }
    if (person.native_place !== null) {
      lines.push('1 RESI');
      lines.push(`2 PLAC ${person.native_place}`);
    }
    if (person.generation !== null) lines.push(`1 _GENERATION ${person.generation}`);
    if (person.generation_char !== null) lines.push(`1 _GENCHAR ${person.generation_char}`);
    if (person.ranking !== null) lines.push(`1 _RANKING ${person.ranking}`);
    if (person.note !== null) {
      const noteLines = person.note.split(/\r?\n/);
      lines.push('1 NOTE');
      lines.push(`2 CONT ${noteLines[0]}`);
      for (const extra of noteLines.slice(1)) lines.push(`2 CONT ${extra}`);
    }
    for (const row of famcByChild.get(person.id) ?? []) {
      const famRefValue = famRef.get(row.family_id);
      if (famRefValue === undefined) continue;
      lines.push(`1 FAMC ${famRefValue}`);
      lines.push(`2 PEDI ${pediCode(row.pedigree)}`);
      if (row.pedigree !== pediCode(row.pedigree)) {
        lines.push(`2 _PEDI ${PEDIGREE_LABELS[row.pedigree as Pedigree] ?? row.pedigree}`);
      }
    }
    for (const familyId of famsByPartner.get(person.id) ?? []) {
      const famRefValue = famRef.get(familyId);
      if (famRefValue !== undefined) lines.push(`1 FAMS ${famRefValue}`);
    }
  }

  for (const family of input.families) {
    lines.push(`0 ${famRef.get(family.id) as string} FAM`);
    if (family.husband_id !== null) lines.push(`1 HUSB ${indiRef.get(family.husband_id) as string}`);
    if (family.wife_id !== null) lines.push(`1 WIFE ${indiRef.get(family.wife_id) as string}`);
    for (const row of input.children.filter((c) => c.family_id === family.id)) {
      const childRef = indiRef.get(row.child_id);
      if (childRef !== undefined) lines.push(`1 CHIL ${childRef}`);
    }
    const marriage = gedcomDate(family.marriage_date);
    if (marriage !== null) {
      lines.push('1 MARR');
      lines.push(`2 DATE ${marriage}`);
    }
    if (family.divorce_date !== null) {
      lines.push('1 DIV');
      lines.push(`2 DATE ${gedcomDate(family.divorce_date) as string}`);
    }
    if (family.note !== null) lines.push(`1 NOTE ${family.note.replace(/\r?\n/g, ' ')}`);
  }

  lines.push('0 TRLR');
  return `${lines.join('\r\n')}\r\n`;
}