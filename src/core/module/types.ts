import type { ReactNode } from 'react';

/**
 * A feature module.
 *
 * The dashboard is the first menu: it renders one card per registered module, so
 * adding a feature means adding a module file and registering it — the shell and
 * the dashboard never change. Each module owns its own page, its own data and
 * (later) its own tables.
 */
export interface FeatureModule {
  id: string;
  title: string;
  icon: string;
  /** One line under the title on the dashboard card. */
  blurb: string;
  /** Ordering on the dashboard; lower comes first. */
  order: number;
  /** Summary content rendered inside the dashboard card. */
  dashboard: ReactNode;
  /** Full page content. Omitted for modules still being built. */
  page?: ReactNode;
  /** `planned` renders the card greyed out with a "开发中" tag. */
  status: 'ready' | 'planned';
}