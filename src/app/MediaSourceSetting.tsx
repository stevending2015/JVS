/**
 * 媒体源设置（共享组件）。
 *
 * 为什么要抽出来：媒体源以前只藏在「词光 atlas → 统计」页的最底部，找不到。
 * 现在它有两个入口 —— 全局 ⚙ 设置面板和模块内的统计页 —— 两处必须共用同一份
 * 状态与同一套提示文案，否则用户在一边改了地址，另一边还显示旧值。
 *
 * 关键约束：**绝不在挂载时探测远端**。
 * mediaConfig.ts 的注释写得很清楚：探测只在真正要用媒体时发生。设置面板是全局的，
 * 每次打开 JVS 都去 ping 一次私人服务器既慢又会在控制台里留下 CORS 报错。
 * 所以这里只在用户点「测试连接」或「保存」时才发请求。
 */

import * as React from 'react';
import { getSetting } from '../core/setting/repository.js';
import { wordMedia } from '../core/word/media.js';
import {
  KEY_WORD_MEDIA_BASE,
  isValidMediaBase,
  probeMediaBase,
  setMediaBase,
} from '../core/word/mediaConfig.js';

/** 提示的几种类型，决定用什么颜色显示。 */
export type MediaHintTone = 'ok' | 'bad';

/** 一条提示消息。 */
export interface MediaHint {
  /** 提示文案。 */
  text: string;
  /** 语气：成功 / 失败。 */
  tone: MediaHintTone;
}

export interface MediaSourceSettingProps {
  /** 额外的类名，挂在最外层容器上。 */
  className?: string;
  /** 状态变化的回调（保存成功后通知外部刷新展示）。 */
  onSaved?: () => void;
}

/**
 * 媒体源设置块。
 *
 * 只读数据库里的已保存地址（不联网），并展示当前生效的源名与缓存条数。
 *
 * @param props - 组件属性。
 * @returns 设置界面。
 */
export function MediaSourceSetting({ className, onSaved }: MediaSourceSettingProps): React.ReactElement {
  const [base, setBase] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [hint, setHint] = React.useState<MediaHint | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  /** 当前生效的源名与缓存条数；媒体源换掉时缓存会被清空，所以跟着变。 */
  const [status, setStatus] = React.useState({ name: wordMedia.sourceName, size: wordMedia.size });

  /**
   * 读一次已保存的地址并刷新状态。
   *
   * 只读本地数据库，不发任何网络请求。
   *
   * @returns 读完后 promise 结束。
   */
  const refresh = React.useCallback(async (): Promise<void> => {
    const saved = await getSetting(KEY_WORD_MEDIA_BASE).catch(() => null);
    const value = saved ?? '';
    setBase(value);
    setStatus({ name: sourceLabel(value), size: wordMedia.size });
    setLoaded(true);
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 测试当前输入的地址能不能真的取到媒体。
   *
   * 只有用户点了按钮才会走到这里 —— 这是唯一允许发起远端请求的时机之一。
   *
   * @returns 测试结束。
   */
  async function test(): Promise<void> {
    setBusy(true);
    setHint(null);
    try {
      if (!isValidMediaBase(base)) {
        setHint({ text: '地址要以 http:// 或 https:// 开头', tone: 'bad' });
        return;
      }
      if (base.trim() === '' || base.trim() === 'local') {
        // 这两个值不是远端地址，没有可探测的对象，直接说明即可。
        setHint({
          text: base.trim() === 'local' ? 'local 表示强制用本地媒体目录，不需要测试。' : '留空表示自动选择，不需要测试。',
          tone: 'ok',
        });
        return;
      }
      const found = await probeMediaBase(base);
      setHint(
        found === null
          ? { text: '取不到媒体：检查地址、路径，以及服务器是否允许跨域（CORS）', tone: 'bad' }
          : { text: `连接成功：${found}`, tone: 'ok' },
      );
    } catch (e) {
      setHint({ text: (e as Error).message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 保存地址并立即切换到新源。
   *
   * 这里**不探测**：保存的是用户填的地址，不是「探到了什么」。
   * 探测是「测试连接」按钮的活儿 —— 用户想验地址时自己点。
   * 切换源后旧缓存里的 object URL 全部作废，所以顺手清掉。
   *
   * @returns 保存结束。
   */
  async function save(): Promise<void> {
    setBusy(true);
    setHint(null);
    try {
      if (!isValidMediaBase(base)) {
        setHint({ text: '地址要以 http:// 或 https:// 开头', tone: 'bad' });
        return;
      }
      const source = await setMediaBase(base);
      // 换源后旧缓存全部失效（object URL 还挂在旧源上）。
      wordMedia.clear();
      setStatus({ name: source.name, size: wordMedia.size });
      onSaved?.();
      setHint({
        text: `已切换到「${source.name}」。下一组词会从新地址拉取。`,
        tone: 'ok',
      });
    } catch (e) {
      setHint({ text: (e as Error).message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  // 同时挂 .wa-mediabase：词光 atlas 自己的验证脚本按这个类名找设置区。
  return (
    <div className={className === undefined ? 'mediabase wa-mediabase' : `mediabase wa-mediabase ${className}`}>
      {/*
        .wa-today__hint 是词光 atlas 里既有的提示样式，验证脚本按它找
        「当前：网络词库」这一行，所以模块内那处沿用同一个类名。
      */}
      <p className="mediabase__status wa-today__hint">
        插画和音频从哪取。留空 = 自动（先试远端，连不上用本地）；填 local 强制本地。
        当前：<b>{status.name}</b> · 已缓存 {status.size} 个媒体文件。
      </p>
      <div className="mediabase__row">
        <input
          className="mediabase__input"
          placeholder="留空自动 / https://media.example.com / local"
          value={base}
          disabled={!loaded}
          onChange={(event) => setBase(event.target.value)}
          aria-label="媒体基地址"
        />
        <button type="button" className="btn" disabled={busy} onClick={() => void test()}>
          {busy ? '检测中…' : '测试连接'}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          保存
        </button>
      </div>
      {hint !== null && (
        <p
          className={[
            'mediabase__hint',
            // .wa-today__hint 是词光 atlas 里既有的提示样式，
            // 验证脚本按它取提示文案，所以模块内那处沿用同一个类名。
            'wa-today__hint',
            hint.tone === 'ok' ? 'mediabase__hint--ok' : 'mediabase__hint--bad',
          ].join(' ')}
        >
          {hint.text}
        </p>
      )}
    </div>
  );
}

/**
 * 显示当前媒体源的名称。
 *
 * `wordMedia.sourceName` 只在真正装上源之后才有值，没打开过词光模块的话
 * 它会一直是「未配置」—— 但设置里明明存着地址。所以这里先看缓存里有没有源，
 * 没有的话按已保存的地址推一个名字出来（和 setMediaBase 的分支保持一致）。
 *
 * @param savedBase - 已保存的基地址（可能为空）。
 * @returns 源的显示名。
 */
function sourceLabel(savedBase: string): string {
  const current = wordMedia.sourceName;
  if (current !== '未配置') return current;
  const trimmed = savedBase.trim();
  if (trimmed === 'local') return '本地词库';
  if (trimmed === '') return '未配置（自动）';
  return '网络词库';
}
