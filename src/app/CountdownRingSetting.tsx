/**
 * 倒计时到期提醒的设置（共享组件）。
 *
 * 为什么要抽出来：响铃开关和音量原来只做在倒计时页底部，用户得先知道有
 * 「倒计时」这个模块、还得滚到页面最下面才找得到。现在全局 ⚙ 设置面板里
 * 也有一份，两处共用这个组件 —— 不会出现「一边显示开着、另一边其实关了」。
 *
 * 状态为什么存在引擎里而不是组件里：引擎（core/countdown/ring.ts）是全局单例，
 * 只有它知道「用户把声音关了」，这样仪表盘卡片和倒计时页两个挂载点都不会
 * 在用户关掉声音之后又自己响起来。
 */

import * as React from 'react';
import {
  loadRingPreferences,
  writeRingPreferences,
  type RingPreferences,
} from '../core/countdown/settings.js';
import { setRingEnabled, setRingVolume } from '../core/countdown/ring.js';

export interface CountdownRingSettingProps {
  /** 额外的类名，挂在最外层容器上。 */
  className?: string;
  /** 偏好变化时的回调（保存成功后通知外部）。 */
  onChanged?: (preferences: RingPreferences) => void;
}

/**
 * 到期提醒设置块。
 *
 * 只读写本地数据库，不发任何网络请求。
 *
 * @param props - 组件属性。
 * @returns 设置界面。
 */
export function CountdownRingSetting({ className, onChanged }: CountdownRingSettingProps): React.ReactElement {
  const [enabled, setEnabled] = React.useState(true);
  const [volume, setVolume] = React.useState(0.7);
  const [loaded, setLoaded] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const prefs = await loadRingPreferences();
      if (!alive) return;
      setEnabled(prefs.enabled);
      setVolume(prefs.volume);
      // 把偏好同步进引擎 —— 否则引擎不知道用户已经关了声音。
      setRingEnabled(prefs.enabled);
      setRingVolume(prefs.volume);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 保存偏好。
   *
   * 先落库再同步引擎：万一写库失败，界面上的状态也不至于和引擎不一致。
   *
   * @param next - 新的偏好。
   */
  const persist = React.useCallback((next: RingPreferences): void => {
    setRingEnabled(next.enabled);
    setRingVolume(next.volume);
    void writeRingPreferences(next).then(() => {
      setSaved(true);
      onChanged?.(next);
    }).catch(() => undefined);
  }, [onChanged]);

  // 「已保存」提示几秒后自己消失。
  React.useEffect(() => {
    if (!saved) return undefined;
    const timer = window.setTimeout(() => setSaved(false), 2200);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const rootClass = className === undefined ? 'cd-sound' : `cd-sound ${className}`;

  return (
    <div className={rootClass}>
      <h4 className="cd-sound__title">到期提醒</h4>
      <label className="cd-sound__toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded}
          onChange={(event) => {
            const next = event.target.checked;
            setEnabled(next);
            persist({ enabled: next, volume });
          }}
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
          disabled={!loaded || !enabled}
          onChange={(event) => {
            const next = Number(event.target.value);
            setVolume(next);
            persist({ enabled, volume: next });
          }}
          aria-label="铃声音量"
        />
        <span className="cd-sound__value">{Math.round(volume * 100)}%</span>
      </label>
      <p className="cd-sound__hint">
        目标日期当天开始持续响铃，直到你点「知道了」。开关与音量会保存下来。
      </p>
      {saved && <p className="settings__ok">已保存</p>}
    </div>
  );
}
