/**
 * Shell: header, hash routing, module page host, and the app lock.
 *
 * Hash routing (not a router library) keeps reloads and deep links working, which
 * matters for a PWA that is restored from the home screen.
 *
 * 锁的模型（用户指定）：
 *  - 设了口令、且勾过受保护模块时，右上角出现锁形按钮
 *  - 锁定时，**仪表盘上**受保护的模块卡片被一把锁盖住
 *  - 点被锁的卡片 = 点右上角的锁按钮 → 弹口令框 → 输对后解锁全部模块
 *    并直接进入刚才点的那张卡片
 *  - 解锁状态下点锁按钮 → 立刻锁上（不用口令）
 * 锁状态存 sessionStorage：刷新保持，关掉标签页后重新锁上。
 */

import * as React from 'react';
import { getModule } from '../core/module/registry.js';
import { useStore } from '../core/store.js';
import {
  DEFAULT_AUTO_LOCK_MS,
  clearSessionUnlock,
  isModuleProtected,
  markSessionUnlocked,
  readSecurityConfig,
  readSessionUnlock,
  type SecurityConfig,
} from '../core/security/password.js';
import { AmbienceButton } from './AmbienceButton.js';
import { Dashboard } from './Dashboard.js';
import { LockOverlay, UnlockDialog } from './LockGate.js';
import { SettingsPanel } from './SettingsPanel.js';

/** 多久检查一次是否该自动上锁。比最短可选时长（1 分钟）小得多，锁得及时又不费电。 */
const IDLE_CHECK_MS = 5_000;

/**
 * 哪些事件算「有人在使用」。
 *
 * 用 pointermove 而不是 mousemove：触摸设备上也算活动。
 * 每个事件只写一个 ref 的值，开销可以忽略，不需要额外节流。
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

function useHashRoute(): [string, (next: string) => void] {
  const read = () => (typeof location === 'undefined' ? '/' : location.hash.replace(/^#/, '') || '/');
  const [route, setRoute] = React.useState(read);
  React.useEffect(() => {
    const onChange = () => setRoute(read());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  const navigate = React.useCallback((next: string) => {
    location.hash = next === '/' ? '' : next;
    setRoute(next);
  }, []);
  return [route, navigate];
}

export function App(): React.ReactElement {
  const [route, navigate] = useHashRoute();
  const store = useStore();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [unlockOpen, setUnlockOpen] = React.useState(false);
  /** 打开设置前的口令弹窗 —— 和模块解锁无关，设了口令就永远要问。 */
  const [settingsPrompt, setSettingsPrompt] = React.useState(false);
  /** 解锁后要进入的模块（点被锁卡片时记下）。 */
  const [pendingModule, setPendingModule] = React.useState<string | null>(null);
  const [security, setSecurity] = React.useState<SecurityConfig | null>(null);
  const [unlocked, setUnlocked] = React.useState(() => readSessionUnlock());
  /** 被空闲自动锁上时的提示，几秒后自己消失。 */
  const [autoLockedNotice, setAutoLockedNotice] = React.useState(false);

  const reloadSecurity = React.useCallback(() => {
    void readSecurityConfig().catch(() => null).then(setSecurity);
  }, []);

  React.useEffect(() => {
    if (!store.ready) return;
    reloadSecurity();
  }, [store.ready, reloadSecurity]);

  /**
   * 空闲自动上锁。
   *
   * 只在「已解锁 + 配了自动锁时长」时盯着；任何一次交互都会重置计时。
   * 到点后清掉会话解锁标记，受保护的模块立刻重新被盖住。
   */
  const autoLockMs =
    security !== null && security.enabled && security.modules.length > 0
      ? (security.autoLockMs ?? DEFAULT_AUTO_LOCK_MS)
      : 0;
  const lastActivity = React.useRef(Date.now());

  // 解锁的那一刻起算，避免刚解锁就被判为空闲。
  React.useEffect(() => {
    if (unlocked) lastActivity.current = Date.now();
  }, [unlocked]);

  React.useEffect(() => {
    if (!unlocked || autoLockMs <= 0) return undefined;
    const bump = (): void => {
      lastActivity.current = Date.now();
    };
    for (const event of ACTIVITY_EVENTS) addEventListener(event, bump, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current < autoLockMs) return;
      clearSessionUnlock();
      setUnlocked(false);
      setUnlockOpen(false);
      setSettingsOpen(false);
      setPendingModule(null);
      setAutoLockedNotice(true);
    }, Math.min(IDLE_CHECK_MS, Math.max(500, autoLockMs / 4)));
    return () => {
      for (const event of ACTIVITY_EVENTS) removeEventListener(event, bump);
      window.clearInterval(timer);
    };
  }, [unlocked, autoLockMs]);

  // 提示 6 秒后消失。
  React.useEffect(() => {
    if (!autoLockedNotice) return undefined;
    const timer = window.setTimeout(() => setAutoLockedNotice(false), 6000);
    return () => window.clearTimeout(timer);
  }, [autoLockedNotice]);

  // A route may carry a query string for deep links (#/m/notes?note=<id>); the
  // module id is only the path part.
  const [path] = route.split('?');
  const moduleId = (path ?? '').startsWith('/m/') ? (path ?? '').slice(3) : null;
  const active = moduleId === null ? undefined : getModule(moduleId);

  /** 锁按钮只在「设了口令 + 至少一个模块受保护」时出现。 */
  const lockAvailable =
    security !== null && security.enabled && security.modules.length > 0;
  const locked = lockAvailable && !unlocked;

  /** 直接访问受保护模块的深链时，页面层也盖一把锁（卡片锁的兜底）。 */
  const pageCovered = locked && moduleId !== null && isModuleProtected(security, moduleId);

  function protectedById(id: string): boolean {
    return isModuleProtected(security, id);
  }

  /** 点右上角锁按钮。 */
  function onLockClick(): void {
    if (unlocked) {
      clearSessionUnlock();
      setUnlocked(false);
      return;
    }
    setPendingModule(null);
    setUnlockOpen(true);
  }

  /** 点被锁住的卡片：和点锁按钮一样，只是解锁后要进这个模块。 */
  function onLockedCard(id: string): void {
    setPendingModule(id);
    setUnlockOpen(true);
  }

  function unlock(): void {
    markSessionUnlocked();
    setUnlocked(true);
    setUnlockOpen(false);
    const target = pendingModule;
    setPendingModule(null);
    if (target !== null) navigate(`/m/${target}`);
  }

  return (
    <div className="app">
      {/*
        数据库状态只播报、不显示：右上角原来那行「SQLite · OPFS 已就绪」占地方，
        已经去掉。但状态本身对屏幕阅读器有用，也让自动化测试有个明确的开机信号，
        所以留一个视觉隐藏的 live region。
      */}
      <p className="sr-only" role="status" aria-live="polite">
        {store.error !== null ? `数据库异常：${store.error}` : store.ready ? 'SQLite · OPFS 已就绪' : '正在打开数据库'}
      </p>
      <header className="app__bar">
        <button type="button" className="app__brand" onClick={() => navigate('/')}>
          JVS
        </button>
        <nav className="app__nav">
          <button type="button" className={moduleId === null ? 'is-active' : ''} onClick={() => navigate('/')}>
            仪表盘
          </button>
        </nav>
        <div className="app__right">
          {lockAvailable && (
            <button
              type="button"
              className={`app__lock${locked ? ' is-locked' : ''}`}
              title={locked ? '已锁定，点击输入口令解锁' : '点击锁定受保护的模块'}
              aria-label={locked ? '解锁' : '锁定'}
              aria-pressed={locked}
              onClick={onLockClick}
            >
              <span aria-hidden="true">{locked ? '🔒' : '🔓'}</span>
            </button>
          )}
          <AmbienceButton />
          <button
            type="button"
            className="app__gear"
            title="设置"
            aria-label="设置"
            onClick={() => {
              if (security !== null && security.enabled) setSettingsPrompt(true);
              else setSettingsOpen(true);
            }}
          >
            ⚙
          </button>
        </div>
      </header>

      {autoLockedNotice && (
        <div className="autolock-notice" role="status">
          🔒 长时间无操作，受保护的模块已自动上锁
        </div>
      )}

      <main className="app__main">
        {store.error !== null && (
          <div className="banner banner--bad">
            <span>SQLite 初始化失败：{store.error}</span>
            <button
              type="button"
              className="banner__action"
              onClick={() => void store.retry()}
            >
              重试
            </button>
          </div>
        )}
        {!store.ready && store.error === null && <div className="banner">正在初始化数据库…</div>}

        {store.ready && moduleId === null && (
          <Dashboard
            onOpen={(id) => navigate(`/m/${id}`)}
            locked={locked}
            isProtected={protectedById}
            onLockedOpen={onLockedCard}
          />
        )}

        {store.ready && moduleId !== null && (
          <>
            <button type="button" className="back" onClick={() => navigate('/')}>← 返回仪表盘</button>
            {pageCovered ? (
              <LockOverlay
                scopeLabel={active?.title ?? moduleId}
                onUnlock={() => {
                  setPendingModule(null);
                  setUnlockOpen(true);
                }}
              />
            ) : active === undefined || active.page === undefined ? (
              <div className="banner">模块「{moduleId}」尚未实现。</div>
            ) : (
              <section className="module-page">
                <h2>{active.icon} {active.title}</h2>
                {active.page}
              </section>
            )}
          </>
        )}
      </main>

      {security !== null && (
        <UnlockDialog
          config={security}
          open={unlockOpen}
          title="🔓 解锁"
          hint="输入口令以解锁受保护的模块。"
          onClose={() => {
            setUnlockOpen(false);
            setPendingModule(null);
          }}
          onUnlock={unlock}
        />
      )}

      {/*
        设置单独把关：即使当前已经解锁了模块，点齿轮仍要重新输口令。
        这样「别人用着已解锁的会话」也进不去设置改口令或导入数据。
      */}
      {security !== null && (
        <UnlockDialog
          config={security}
          open={settingsPrompt}
          title="⚙ 打开设置"
          hint="设置里能改口令和导入数据，需要单独验证。"
          onClose={() => setSettingsPrompt(false)}
          onUnlock={() => {
            setSettingsPrompt(false);
            setSettingsOpen(true);
          }}
        />
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          reloadSecurity();
        }}
      />
    </div>
  );
}
