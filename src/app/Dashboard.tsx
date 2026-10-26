/**
 * The dashboard: the first menu.
 *
 * It knows nothing about individual features — it renders one card per
 * registered module. Adding a feature adds a card here for free.
 *
 * 应用锁在这里体现为「卡片被盖住」：受保护模块的卡片在锁定时不显示内容，
 * 点它等同于点右上角的锁按钮 —— 弹口令框，输对后解锁并直接进入这个模块。
 */

import * as React from 'react';
import { listModules } from '../core/module/registry.js';

export interface DashboardProps {
  /** 打开某个模块。 */
  onOpen: (id: string) => void;
  /** 当前是否锁定。 */
  locked?: boolean;
  /** 判断某个模块是否受保护。 */
  isProtected?: (id: string) => boolean;
  /** 点了被锁住的卡片（应该弹口令框，并在解锁后进入该模块）。 */
  onLockedOpen?: (id: string) => void;
}

export function Dashboard({
  onOpen,
  locked = false,
  isProtected,
  onLockedOpen,
}: DashboardProps): React.ReactElement {
  const modules = listModules();
  return (
    <section className="dashboard">
      <h2 className="dashboard__title">仪表盘</h2>
      <div className="card-grid">
        {modules.map((module) => {
          const covered = locked && (isProtected?.(module.id) ?? false);
          return (
            <button
              key={module.id}
              type="button"
              className={[
                'card',
                module.status === 'planned' ? 'card--planned' : '',
                covered ? 'card--locked' : '',
              ].filter(Boolean).join(' ')}
              disabled={module.page === undefined && !covered}
              aria-label={covered ? `${module.title}（已锁定，点击解锁）` : undefined}
              onClick={() => {
                if (covered) onLockedOpen?.(module.id);
                else onOpen(module.id);
              }}
            >
              <header className="card__head">
                <span className="card__icon" aria-hidden="true">{module.icon}</span>
                <span className="card__title">{module.title}</span>
                {module.status === 'planned' && <span className="card__tag">开发中</span>}
              </header>
              {covered ? (
                // 锁住时卡片正文整块被盖掉，连摘要都不给看。
                <div className="card__cover">
                  <span className="card__cover-icon" aria-hidden="true">🔒</span>
                  <span className="card__cover-text">已锁定 · 点击解锁</span>
                </div>
              ) : (
                <>
                  <div className="card__body">{module.dashboard}</div>
                  <footer className="card__foot">{module.blurb}</footer>
                </>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
