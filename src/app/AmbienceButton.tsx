/**
 * 顶部栏右上角的环境声按钮。
 *
 * 点开是一个小面板：七段背景音 + 静音 + 音量滑杆。选择存进设置表，下次打开
 * JVS 自动接着放（但要等第一次点击/按键，浏览器才允许出声）。
 */

import * as React from 'react';
import { getSetting, setSetting } from '../core/setting/repository.js';
import { useStore } from '../core/store.js';
import {
  AMBIENCE_TRACKS,
  DEFAULT_AMBIENCE_VOLUME,
  armAmbience,
  setAmbience,
  setAmbienceVolume,
  type AmbienceId,
} from '../core/ambience/player.js';

/** 设置键。 */
const KEY_AMBIENCE = 'ambience.id';
const KEY_AMBIENCE_VOLUME = 'ambience.volume';

/** 读出保存的偏好。 */
async function readPrefs(): Promise<{ id: AmbienceId | null; volume: number }> {
  const [savedId, savedVolume] = await Promise.all([
    getSetting(KEY_AMBIENCE).catch(() => null),
    getSetting(KEY_AMBIENCE_VOLUME).catch(() => null),
  ]);
  const volume = savedVolume === null ? DEFAULT_AMBIENCE_VOLUME : Number(savedVolume);
  const known = AMBIENCE_TRACKS.some((track) => track.id === savedId);
  return {
    id: known ? (savedId as AmbienceId) : null,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : DEFAULT_AMBIENCE_VOLUME,
  };
}

export function AmbienceButton(): React.ReactElement {
  const { ready } = useStore();
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState<AmbienceId | null>(null);
  const [volume, setVolume] = React.useState(DEFAULT_AMBIENCE_VOLUME);
  /** 音频是否真的在响（解码 + 播放是异步的，不能靠渲染时判断）。 */
  const [playing, setPlaying] = React.useState(false);
  const box = React.useRef<HTMLDivElement>(null);
  const loadedRef = React.useRef(false);

  // 必须等数据库就绪才能读设置 —— 之前不等，刷新后读不到偏好，
  // 选择就丢了。ready 变 true 时读一次。
  React.useEffect(() => {
    if (!ready || loadedRef.current) return;
    loadedRef.current = true;
    let dispose = (): void => undefined;
    void (async () => {
      const prefs = await readPrefs();
      setActive(prefs.id);
      setVolume(prefs.volume);
      if (prefs.id !== null) {
        dispose = armAmbience(prefs.id, prefs.volume);
      }
    })();
    return () => dispose();
  }, [ready]);

  // 点外面 / Esc 关闭面板。
  React.useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: Event): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** 选一段（再点一次同段 = 关闭）。 */
  async function pick(id: AmbienceId | null): Promise<void> {
    const next = active === id ? null : id;
    setActive(next);
    await setSetting(KEY_AMBIENCE, next ?? '').catch(() => undefined);
    await setAmbience(next, volume).catch(() => undefined);
    // 播放是异步的：解码完成后才知道是否真的在响。
    setPlaying(next !== null);
  }

  /** 调音量并保存。 */
  function changeVolume(next: number): void {
    setVolume(next);
    setAmbienceVolume(next);
    void setSetting(KEY_AMBIENCE_VOLUME, String(next)).catch(() => undefined);
  }

  const on = active !== null;

  return (
    <div className="amb" ref={box}>
      <button
        type="button"
        className={`amb__btn${on ? ' is-on' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="环境声"
        title={on ? `环境声：${AMBIENCE_TRACKS.find((t) => t.id === active)?.label ?? ''}` : '环境声'}
      >
        <span aria-hidden="true">{on ? '🎧' : '🔇'}</span>
        {on && (
          <span className={`amb__bars${playing ? ' is-playing' : ''}`} aria-hidden="true">
            <i /><i /><i />
          </span>
        )}
      </button>

      {open && (
        <div className="amb__pop" role="dialog" aria-label="环境声">
          <p className="amb__title">环境声 · 专注陪伴</p>
          <ul className="amb__list">
            {AMBIENCE_TRACKS.map((track) => {
              const selected = active === track.id;
              return (
                <li key={track.id}>
                  <button
                    type="button"
                    className={selected ? 'is-on' : ''}
                    aria-pressed={selected}
                    onClick={() => void pick(track.id)}
                  >
                    <span className="amb__icon" aria-hidden="true">{track.icon}</span>
                    <span className="amb__label">{track.label}</span>
                    {selected && <span className="amb__check" aria-hidden="true">✓</span>}
                  </button>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                className={!on ? 'is-on' : ''}
                aria-pressed={!on}
                onClick={() => void pick(null)}
              >
                <span className="amb__icon" aria-hidden="true">🤫</span>
                <span className="amb__label">安静</span>
                {!on && <span className="amb__check" aria-hidden="true">✓</span>}
              </button>
            </li>
          </ul>

          <label className="amb__volume">
            <span>音量</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              disabled={!on}
              onChange={(event) => changeVolume(Number(event.target.value))}
              aria-label="环境声音量"
            />
            <span className="amb__volume-value">{Math.round(volume * 100)}%</span>
          </label>

          <p className="amb__note">
            {on && !playing
              ? '正在载入…或点一下页面任意位置开始播放（浏览器要求先有交互）'
              : '七段背景音随应用离线可用。'}
          </p>
        </div>
      )}
    </div>
  );
}
