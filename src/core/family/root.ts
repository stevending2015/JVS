/**
 * The family tree's root — the person the tree is centred on.
 *
 * This is deliberately separate from 「本人」(is_self):
 *  - 本人 is who you are; it drives the birthday module's automatic family links;
 *  - the root is where the tree is drawn from; you may want to look at a branch
 *    that is not your own.
 *
 * The root is persisted, so reopening the app shows the same tree — unless the
 * root is changed by hand.
 */

import { getSetting, setSetting } from '../setting/repository.js';

/** Preference key holding the root person's id. */
export const KEY_FAMILY_ROOT = 'family.root';

/**
 * Read the persisted root.
 *
 * @returns The person's id, or null when none was set.
 */
export async function readFamilyRoot(): Promise<string | null> {
  const value = await getSetting(KEY_FAMILY_ROOT);
  return value === null || value.trim() === '' ? null : value;
}

/**
 * Persist the root.
 *
 * @param personId - the person's id, or null to forget the root.
 */
export async function writeFamilyRoot(personId: string | null): Promise<void> {
  await setSetting(KEY_FAMILY_ROOT, personId ?? '');
}
