/**
 * Family tree layout.
 *
 * Two halves:
 *  - above the focus person: a pedigree chart (direct ancestors), doubling in
 *    width per generation
 *  - below: descendant layout built around MARRIAGE nodes
 *
 * The descendant half follows GEDCOM's union model literally: one person is
 * followed by one small marriage node per union, each of which carries exactly
 * one spouse and that marriage's children. This is what makes remarriage and
 * polygamy render correctly — an earlier version picked a single family per
 * person, so a second wife's children were not merely misdrawn but never visited.
 *
 * Roles: the BLOOD descendant in a marriage is the 主人; the person who joined by
 * marriage is the 配偶 and is drawn lighter and indented. In an 入赘 union the
 * blood descendant is the wife, so she becomes 主人 without any gender guessing.
 */

import type { Person } from '../person/types.js';
import type { Family, FamilyChild } from './types.js';

export const BOX = {
  width: 132,
  height: 54,
  gapX: 26,
  gapY: 44,
  spouseGap: 18,
  /** Horizontal slot width for one ancestor box. */
  slot: 172,
};

/** Side length of the little diamond that marks a marriage. */
export const MARRIAGE_NODE = 15;

/** Gap between an owner row and its marriage row. */
const MARRIAGE_GAP = 34;
/** Gap between a marriage row and the children row beneath it. */
const CHILD_GAP = 40;

export interface PlacedBox {
  personId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `owner` is the blood descendant, `spouse` joined by marriage. */
  role: 'owner' | 'spouse';
}

export interface PlacedMarriage {
  familyId: string;
  spouseId: string | null;
  /** 婚配方式（初婚/继配/侧室/入赘/未婚）。 */
  kind: string;
  /** Centre of the diamond. */
  x: number;
  y: number;
  divorced: boolean;
  /** Spouse box position, when there is a spouse. */
  spouseBox: { x: number; y: number } | null;
}

export interface LayoutResult {
  boxes: PlacedBox[];
  marriages: PlacedMarriage[];
  /** Owner -> marriage node paths (orthogonal). */
  ownerToMarriage: string[];
  /** Marriage node -> child paths (orthogonal). */
  childPaths: string[];
  /** Straight marriage ties between the diamond and the spouse box. */
  spouseTies: Array<{ x1: number; y1: number; x2: number; y2: number; divorced: boolean }>;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface Maps {
  persons: Map<string, Person>;
  families: Map<string, Family>;
  familiesByPartner: Map<string, Family[]>;
  childrenByFamily: Map<string, FamilyChild[]>;
  birthFamilyByChild: Map<string, Family>;
}

function buildMaps(persons: Person[], families: Family[], children: FamilyChild[]): Maps {
  const personById = new Map(persons.map((p) => [p.id, p]));
  const familyById = new Map(families.map((f) => [f.id, f]));
  const familiesByPartner = new Map<string, Family[]>();
  for (const family of families) {
    for (const partner of [family.husband_id, family.wife_id]) {
      if (partner === null) continue;
      const list = familiesByPartner.get(partner) ?? [];
      list.push(family);
      familiesByPartner.set(partner, list);
    }
  }
  const childrenByFamily = new Map<string, FamilyChild[]>();
  const birthFamilyByChild = new Map<string, Family>();
  for (const row of children) {
    const list = childrenByFamily.get(row.family_id) ?? [];
    list.push(row);
    childrenByFamily.set(row.family_id, list);
    if (row.pedigree === 'birth' && !birthFamilyByChild.has(row.child_id)) {
      birthFamilyByChild.set(row.child_id, familyById.get(row.family_id) as Family);
    }
  }
  for (const list of childrenByFamily.values()) {
    list.sort((a, b) => (a.birth_order ?? 999) - (b.birth_order ?? 999));
  }
  return { persons: personById, families: familyById, familiesByPartner, childrenByFamily, birthFamilyByChild };
}

// ---------------------------------------------------------------- descendants ---

interface MarriageUnit {
  family: Family;
  spouseId: string | null;
  children: DescNode[];
  width: number;
}

interface DescNode {
  personId: string;
  marriages: MarriageUnit[];
  /** Width of the whole subtree rooted at this person. */
  width: number;
}

/** Width of a marriage unit: its spouse pair or its children, whichever is wider. */
function marriageWidth(spouseId: string | null, childrenWidth: number): number {
  const spousePart = spouseId === null
    ? MARRIAGE_NODE
    : MARRIAGE_NODE + BOX.spouseGap + BOX.width;
  return Math.max(spousePart, childrenWidth, MARRIAGE_NODE);
}

interface BuildOptions {
  /** Expand daughters' descendants. Traditional 族谱 keep them as 「适某」 only. */
  expandFemale: boolean;
}

/**
 * Whether to descend into a child's own family.
 *
 * Male line always expands. A daughter's descendants stay collapsed unless the
 * user asked for them, or unless she is the blood side of an 入赘 union.
 */
function shouldExpand(maps: Maps, child: Person, options: BuildOptions): boolean {
  if (options.expandFemale) return true;
  if (child.gender !== 'female') return true;
  const marriages = maps.familiesByPartner.get(child.id) ?? [];
  return marriages.some((family) => family.kind === 'uxorilocal');
}

function buildDescendant(
  maps: Maps,
  personId: string,
  options: BuildOptions,
  seen: Set<string>,
): DescNode {
  if (seen.has(personId)) return { personId, marriages: [], width: BOX.width };
  seen.add(personId);

  const families = maps.familiesByPartner.get(personId) ?? [];
  const marriages: MarriageUnit[] = [];

  for (const family of families) {
    const spouseId = family.husband_id === personId ? family.wife_id : family.husband_id;
    const rows = maps.childrenByFamily.get(family.id) ?? [];
    const children: DescNode[] = [];

    for (const row of rows) {
      const child = maps.persons.get(row.child_id);
      if (child === undefined) continue;
      if (shouldExpand(maps, child, options)) {
        children.push(buildDescendant(maps, child.id, options, seen));
      } else {
        // Show the person, but not their descendants.
        children.push({ personId: child.id, marriages: [], width: BOX.width });
      }
    }

    const childrenWidth =
      children.reduce((sum, child) => sum + child.width, 0) +
      Math.max(0, children.length - 1) * BOX.gapX;

    marriages.push({
      family,
      spouseId,
      children,
      width: marriageWidth(spouseId, childrenWidth),
    });
  }

  const marriagesWidth =
    marriages.reduce((sum, unit) => sum + unit.width, 0) +
    Math.max(0, marriages.length - 1) * BOX.gapX;

  return {
    personId,
    marriages,
    width: Math.max(BOX.width, marriagesWidth),
  };
}

function placeDescendants(node: DescNode, centerX: number, y: number, out: LayoutResult): void {
  out.boxes.push({
    personId: node.personId,
    x: centerX - BOX.width / 2,
    y,
    width: BOX.width,
    height: BOX.height,
    role: 'owner',
  });

  if (node.marriages.length === 0) return;

  const totalWidth =
    node.marriages.reduce((sum, unit) => sum + unit.width, 0) +
    Math.max(0, node.marriages.length - 1) * BOX.gapX;
  const marriageY = y + BOX.height + MARRIAGE_GAP;
  const childrenY = marriageY + BOX.height + CHILD_GAP;
  const busY = y + BOX.height + MARRIAGE_GAP / 2;

  let cursor = centerX - totalWidth / 2;

  for (const unit of node.marriages) {
    const unitCenter = cursor + unit.width / 2;
    const hasSpouse = unit.spouseId !== null;
    const divorced = unit.family.divorce_date !== null;

    // Anchor the children on the marriage node when there is a partner, otherwise
    // straight off the owner: a one-partner family needs no diamond, and drawing
    // one for every single parent just added clutter.
    let anchorX = centerX;
    let anchorY = y + BOX.height;
    let anchorTop = centerX;

    if (hasSpouse) {
      const conversationWidth = MARRIAGE_NODE + BOX.spouseGap + BOX.width;
      const startX = unitCenter - conversationWidth / 2;
      const diamondCenterX = startX + MARRIAGE_NODE / 2;
      const diamondCenterY = marriageY + BOX.height / 2;
      const spouseBox = { x: startX + MARRIAGE_NODE + BOX.spouseGap, y: marriageY };

      out.spouseTies.push({
        x1: startX + MARRIAGE_NODE,
        y1: diamondCenterY,
        x2: spouseBox.x,
        y2: diamondCenterY,
        divorced,
      });
      out.boxes.push({
        personId: unit.spouseId as string,
        x: spouseBox.x,
        y: marriageY,
        width: BOX.width,
        height: BOX.height,
        role: 'spouse',
      });
      out.marriages.push({
        familyId: unit.family.id,
        spouseId: unit.spouseId,
        kind: unit.family.kind,
        x: diamondCenterX,
        y: diamondCenterY,
        divorced,
        spouseBox,
      });

      // Owner -> diamond, routed on a horizontal bus so many marriages stay legible.
      out.ownerToMarriage.push(
        `M ${centerX} ${y + BOX.height} V ${busY} H ${diamondCenterX} V ${diamondCenterY - MARRIAGE_NODE / 2}`,
      );

      anchorX = diamondCenterX;
      anchorY = diamondCenterY + MARRIAGE_NODE / 2;
      anchorTop = diamondCenterX;
    }

    const childrenWidth =
      unit.children.reduce((sum, child) => sum + child.width, 0) +
      Math.max(0, unit.children.length - 1) * BOX.gapX;
    let childCursor = unitCenter - childrenWidth / 2;
    const childBusY = hasSpouse
      ? anchorY + CHILD_GAP / 2
      : y + BOX.height + (childrenY - y - BOX.height) / 2;

    for (const child of unit.children) {
      const childCenter = childCursor + child.width / 2;
      out.childPaths.push(
        `M ${anchorX} ${anchorY} V ${childBusY} H ${childCenter} V ${childrenY}`,
      );
      placeDescendants(child, childCenter, childrenY, out);
      childCursor += child.width + BOX.gapX;
    }

    cursor += unit.width + BOX.gapX;
  }
}

// ------------------------------------------------------------------ ancestors ---

interface AncNode {
  personId: string;
  father: AncNode | null;
  mother: AncNode | null;
}

/**
 * Build the pedigree chain upward, returning a node for EVERY person even when no
 * parents are recorded (otherwise almost every real family drew no ancestors).
 */
function buildAncestor(maps: Maps, personId: string, depth: number): AncNode {
  const node: AncNode = { personId, father: null, mother: null };
  if (depth <= 0) return node;
  const family = maps.birthFamilyByChild.get(personId);
  if (family === undefined) return node;
  if (family.husband_id !== null && maps.persons.has(family.husband_id)) {
    node.father = buildAncestor(maps, family.husband_id, depth - 1);
  }
  if (family.wife_id !== null && maps.persons.has(family.wife_id)) {
    node.mother = buildAncestor(maps, family.wife_id, depth - 1);
  }
  return node;
}

function placeAncestors(
  node: AncNode,
  centerX: number,
  childY: number,
  depth: number,
  out: LayoutResult,
): void {
  const y = childY - BOX.height - BOX.gapY;
  const father = node.father;
  const mother = node.mother;
  if (father === null && mother === null) return;

  const fatherX = father === null ? null : centerX - BOX.slot / 2;
  const motherX = mother === null ? null : centerX + BOX.slot / 2;
  const busY = y + BOX.height + BOX.gapY / 2;

  if (father !== null && fatherX !== null) {
    out.boxes.push({ personId: father.personId, x: fatherX - BOX.width / 2, y, width: BOX.width, height: BOX.height, role: 'owner' });
    out.childPaths.push(`M ${centerX} ${childY} V ${busY} H ${fatherX} V ${y + BOX.height}`);
  }
  if (mother !== null && motherX !== null) {
    out.boxes.push({ personId: mother.personId, x: motherX - BOX.width / 2, y, width: BOX.width, height: BOX.height, role: 'owner' });
    out.childPaths.push(`M ${centerX} ${childY} V ${busY} H ${motherX} V ${y + BOX.height}`);
  }
  if (father !== null && mother !== null && fatherX !== null && motherX !== null) {
    out.spouseTies.push({
      x1: fatherX + BOX.width / 2,
      y1: y + BOX.height / 2,
      x2: motherX - BOX.width / 2,
      y2: y + BOX.height / 2,
      divorced: false,
    });
  }

  if (father !== null && fatherX !== null && depth > 1) placeAncestors(father, fatherX, y, depth - 1, out);
  if (mother !== null && motherX !== null && depth > 1) placeAncestors(mother, motherX, y, depth - 1, out);
}

/**
 * Build the whole layout.
 * @param input - persons, families, links, the focus person, and whether to expand daughters.
 * @returns Placed boxes, marriage nodes and line paths.
 */
export function layoutTree(input: {
  focusId: string;
  persons: Person[];
  families: Family[];
  children: FamilyChild[];
  ancestorDepth?: number;
  expandFemale?: boolean;
}): LayoutResult {
  const maps = buildMaps(input.persons, input.families, input.children);
  const out: LayoutResult = {
    boxes: [],
    marriages: [],
    ownerToMarriage: [],
    childPaths: [],
    spouseTies: [],
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
  };

  if (!maps.persons.has(input.focusId)) return out;

  const options: BuildOptions = { expandFemale: input.expandFemale ?? false };
  const root = buildDescendant(maps, input.focusId, options, new Set<string>());
  placeDescendants(root, root.width / 2, 0, out);

  const ancestorDepth = input.ancestorDepth ?? 4;
  placeAncestors(buildAncestor(maps, input.focusId, ancestorDepth), root.width / 2, 0, ancestorDepth, out);

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const box of out.boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  out.minX = Number.isFinite(minX) ? minX : 0;
  out.minY = Number.isFinite(minY) ? minY : 0;
  out.maxX = Number.isFinite(maxX) ? maxX : 0;
  out.maxY = Number.isFinite(maxY) ? maxY : 0;
  return out;
}