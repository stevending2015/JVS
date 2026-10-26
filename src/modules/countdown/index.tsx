/**
 * 倒计时 module —— 列表 + 到期持续响铃。
 *
 * 响铃的语义（详见 core/countdown/settings.ts）：
 *  - 目标日期「当天」算到期（days === 0），从当天开始持续响铃；
 *  - 已经过去的日子不补响；
 *  - 铃一直响到用户点「知道了」为止，多个倒计时同时到期也只叠一个铃声循环，
 *    界面上把到期的都列出来。
 *
 * 浏览器自动播放策略：AudioContext 必须先有用户手势才出声。如果用户还没点过
 * 页面，到期时铃起不来，此时显示一条常驻横幅让用户点「开启提醒」——那一键
 * 本身就是用户手势，点完铃声立刻接上。
 */

import * as React from 'react';
import { Modal } from '../../app/Modal.js';
import { useStore } from '../../core/store.js';
import {
  armRing,
  isRingAcknowledged,
  ringNow,
  ringStatus,
  setRingEnabled,
  setRingVolume,
  startRing,
  stopRing,
  subscribeRing,
  type RingState,
} from '../../core/countdown/ring.js';
import {
  DEFAULT_RING_VOLUME,
  daysUntil,
  isDueToday,
  loadRingPreferences,
  writeRingPreferences,
} from '../../core/countdown/settings.js';

/** 到期倒计时的标题。 */
function dueTitles(countdowns: Array<{ title: string; target_date: string }>): string[] {
  return countdowns
    .filter((item) => isDueToday(item.target_date))
    .map((item) => item.title);
}

/**
 * 读偏好只做一次。
 *
 * 卡片和页面都会挂载，各自读一遍设置表是浪费；而引擎必须最先知道「用户把
 * 声音关了」，否则卡片会先起铃。用一个模块级的 Promise 去重，谁先到谁读。
 */
let preferencesLoaded: Promise<void> | null = null;

/** 载入响铃偏好（并同步给引擎），重复调用只会读一次。 */
function ensurePreferences(): Promise<void> {
  if (preferencesLoaded === null) {
    preferencesLoaded = loadRingPreferences().then(() => undefined).catch(() => undefined);
  }
  return preferencesLoaded;
}

/**
 * 响铃的全局状态钩子。
 *
 * 卡片和页面都要显示「在响铃 / 需要开启提醒」，但铃声本身只能有一份，所以
 * 这里订阅 core/countdown/ring.ts 的单例状态，而不是各建一份 AudioContext。
 *
 * @param countdowns - 全部倒计时，用来算今天哪些到期。
 * @returns 响铃状态、到期标题与操作函数。
 */
function useCountdownRing(countdowns: Array<{ id: string; title: string; target_date: string }>): {
  state: RingState;
  due: string[];
  ringing: boolean;
  blocked: boolean;
  acknowledged: boolean;
  acknowledge: () => void;
  enable: () => void;
} {
  const [state, setState] = React.useState<RingState>(ringStatus().state);
  const [ringTitles, setRingTitles] = React.useState<string[]>(ringStatus().payload?.titles ?? []);
  /** 已经响过的「到期集合」：用于只触发一次，不重复起铃。 */
  const firedRef = React.useRef<string>('');
  /** 用户点过「知道了」之后要反映到界面上，所以它也要进 state。 */
  const [acknowledged, setAcknowledged] = React.useState(false);

  const due = React.useMemo(() => dueTitles(countdowns), [countdowns]);
  const dueKey = due.join('\u0000');

  // 偏好要读回来引擎才知道声音是开是关；在读到之前先别起铃。
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void ensurePreferences().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => subscribeRing((next, payload) => {
    setState(next);
    setRingTitles(payload?.titles ?? []);
  }), []);

  // 到期就起铃（起铃是幂等的，多个倒计时同时到期也只有一个铃声循环）。
  React.useEffect(() => {
    if (!ready) return;
    if (due.length === 0) return;
    if (firedRef.current === dueKey) return;
    firedRef.current = dueKey;
    // 没有用户手势时 AudioContext 起不来，startRing 会把状态置为 'blocked'，
    // 界面随后显示「开启提醒」按钮。
    void startRing(due);
  }, [ready, dueKey, due]);

  // 确认状态跟着到期集合走：确认过的这批不再自动响。
  React.useEffect(() => {
    setAcknowledged(due.length > 0 && isRingAcknowledged(due));
  }, [dueKey, due]);

  const acknowledge = React.useCallback(() => {
    stopRing();
    setAcknowledged(true);
  }, []);

  const enable = React.useCallback(() => {
    // 用户点了这个按钮 = 一次用户手势，此刻 resume() 一定能成功。
    void ringNow(due).then((ok) => {
      if (ok) setAcknowledged(false);
    });
  }, [due]);

  return {
    state,
    due: ringTitles.length > 0 ? ringTitles : due,
    ringing: state === 'ringing',
    blocked: state === 'blocked',
    acknowledged,
    acknowledge,
    enable,
  };
}

/** Dashboard card: 最近的三项倒计时，到期的那项会被标出来。 */
export function CountdownCard(): React.ReactElement {
  const { countdowns } = useStore();
  const sorted = [...countdowns].sort((a, b) => a.target_date.localeCompare(b.target_date));
  const { ringing, blocked, due, acknowledge } = useCountdownRing(countdowns);
  if (sorted.length === 0) return <p className="card__empty">还没有倒计时</p>;
  return (
    <ul className="mini-list">
      {sorted.slice(0, 3).map((item) => {
        const days = daysUntil(item.target_date);
        const isDue = days === 0;
        return (
          <li key={item.id}>
            <span className="mini-list__name">{item.title}</span>
            <span className={`mini-list__meta${isDue ? ' is-due' : ''}`}>
              {isDue ? '就是今天 🔔' : days > 0 ? `${days} 天` : `已过 ${-days} 天`}
            </span>
          </li>
        );
      })}
      {due.length > 0 && (
        <li className="mini-list__note">
          {ringing
            ? `🔔 正在响铃：${due.join('、')}`
            : blocked
              ? `⏰ 到点了：${due.join('、')}（去倒计时页开启提醒）`
              : `⏰ 到点了：${due.join('、')}`}
          {ringing && (
            <button type="button" className="link" onClick={acknowledge}>知道了</button>
          )}
        </li>
      )}
    </ul>
  );
}

/** 倒计时页。 */
export function CountdownPage(): React.ReactElement {
  const { countdowns, addCountdown, removeCountdown } = useStore();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** 响铃总开关。 */
  const [soundOn, setSoundOn] = React.useState(true);
  /** 铃声音量。 */
  const [volume, setVolume] = React.useState(DEFAULT_RING_VOLUME);
  /** 偏好读回来之前不让 UI 抖动 —— 直接用默认值即可，读取是异步的。 */
  const [prefsLoaded, setPrefsLoaded] = React.useState(false);

  const { due, ringing, blocked, acknowledged, acknowledge, enable } = useCountdownRing(countdowns);

  // 读一次偏好，把读到的结果显示出来（引擎那边由 ensurePreferences 同步）。
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const prefs = await loadRingPreferences();
      if (!alive) return;
      setSoundOn(prefs.enabled);
      setVolume(prefs.volume);
      setPrefsLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 保存偏好，并把开关同步给引擎（引擎里才有「关了就立刻停」的效果）。
  React.useEffect(() => {
    if (!prefsLoaded) return;
    setRingEnabled(soundOn);
    void writeRingPreferences({ enabled: soundOn, volume }).catch(() => undefined);
  }, [soundOn, volume, prefsLoaded]);

  // 页面打开时如果铃被自动播放策略挡住了，挂一个一次性的手势监听：
  // 用户第一次点击/按键就把铃补上（和「开启提醒」按钮是同一个效果）。
  // armRing 不用再传标题 —— 要显示的到期清单已经由 startRing 记在引擎里了。
  React.useEffect(() => {
    if (!blocked) return undefined;
    return armRing();
  }, [blocked]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // Read the values BEFORE awaiting: React nulls `currentTarget` once the
    // handler yields, which is exactly what threw "Cannot read properties of
    // null (reading 'reset')" here before.
    const data = new FormData(event.currentTarget);
    const title = String(data.get('title') ?? '').trim();
    const date = String(data.get('date') ?? '');
    if (title === '' || date === '') {
      setError('名称与日期都不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addCountdown(title, date);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sorted = [...countdowns].sort((a, b) => a.target_date.localeCompare(b.target_date));

  return (
    <div className="panel">
      <div className="list-head">
        <h3>共 {countdowns.length} 项</h3>
        <span className="list-head__count" />
        <button type="button" className="btn btn--add" onClick={() => { setError(null); setOpen(true); }}>
          ＋ 添加倒计时
        </button>
      </div>

      {/*
        到期横幅：几种状态各有各的说法。
        - ringing：正在响 → 给一个「知道了」把它停掉。
        - blocked：浏览器还没给过用户手势，铃起不来 → 给一个「开启提醒」按钮。
        - acknowledged：用户已经确认过 → 保持安静，但仍然列出是哪几项到期。
        - 其余（声音被关了）→ 给一个手动起铃的入口。
      */}
      {due.length > 0 && (
        <div className={`banner cd-ring${ringing ? ' banner--ring' : ''}`} role="status" aria-live="polite">
          <span className="cd-ring__icon" aria-hidden="true">{ringing ? '🔔' : acknowledged ? '✅' : '⏰'}</span>
          <span className="cd-ring__text">
            <b>到点了：{due.join('、')}</b>
            {ringing && <span className="cd-ring__sub">正在持续响铃，直到你点「知道了」。</span>}
            {blocked && <span className="cd-ring__sub">浏览器要求先有一次点击才能出声，点下面的按钮开启提醒。</span>}
            {acknowledged && !ringing && <span className="cd-ring__sub">已确认，铃声已停止。</span>}
            {!ringing && !blocked && !acknowledged && <span className="cd-ring__sub">铃声当前是关闭的。</span>}
          </span>
          <div className="cd-ring__actions">
            {blocked && (
              <button type="button" className="btn btn--primary" onClick={enable}>开启提醒</button>
            )}
            {!blocked && !ringing && soundOn && (
              <button type="button" className="btn btn--primary" onClick={enable}>开始响铃</button>
            )}
            {ringing && (
              <button type="button" className="btn btn--primary" onClick={acknowledge}>知道了</button>
            )}
          </div>
        </div>
      )}

      {countdowns.length === 0 && <p className="card__empty">还没有倒计时，点右上角添加</p>}

      <ul className="person-list">
        {sorted.map((item) => {
          const days = daysUntil(item.target_date);
          const isDue = days === 0;
          return (
            <li key={item.id} className={isDue ? 'is-due' : undefined}>
              <div>
                <strong>{item.title}</strong>
                {isDue && <span className="cd-due-tag">就是今天</span>}
              </div>
              <div className="person-list__meta">{item.target_date}</div>
              <div className={`person-list__next${isDue ? ' is-due' : ''}`}>
                {days >= 0 ? `还有 ${days} 天` : `已过 ${-days} 天`}
              </div>
              <div className="person-list__actions">
                <button type="button" className="link" onClick={() => void removeCountdown(item.id)}>删除</button>
              </div>
            </li>
          );
        })}
      </ul>

      <section className="cd-sound">
        <h4 className="cd-sound__title">到期提醒</h4>
        <label className="cd-sound__toggle">
          <input
            type="checkbox"
            checked={soundOn}
            onChange={(event) => setSoundOn(event.target.checked)}
          />
          到期持续响铃
        </label>
        <label className="cd-sound__volume">
          <span>音量</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            disabled={!soundOn}
            onChange={(event) => {
              const next = Number(event.target.value);
              setVolume(next);
              setRingVolume(next);
            }}
            aria-label="铃声音量"
          />
          <span className="cd-sound__value">{Math.round(volume * 100)}%</span>
        </label>
        <p className="cd-sound__hint">
          目标日期当天开始持续响铃，直到你点「知道了」。开关与音量会保存下来。
        </p>
      </section>

      {/*
        设置面板里也有一份同样的设置（app/CountdownRingSetting.tsx）。
        这里保留页面内的这一份，是因为「到期提醒」就在这条横幅旁边 ——
        响着的时候能立刻把声音关掉，比跑去设置里翻快得多。
      */}

      <Modal open={open} title="添加倒计时" onClose={() => setOpen(false)}>
        <form className="form" onSubmit={(e) => void submit(e)}>
          <label>名称<input name="title" required autoFocus /></label>
          <label>目标日期<input name="date" type="date" required /></label>
          {error !== null && <div className="banner banner--bad">{error}</div>}
          <div className="form__actions">
            <button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
            <button type="button" onClick={() => setOpen(false)} disabled={busy}>取消</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
