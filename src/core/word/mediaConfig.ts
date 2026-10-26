/**
 * 媒体源配置。
 *
 * 媒体有两种来源：
 *   - 本地：开发期由 vite 中间件从 word-atlas 目录提供 /word-media；
 *   - 远端：媒体上传到静态托管（阿里云 / CDN）后，填一个基地址即可。
 *
 * 地址存在 setting 表里，换设备/换网络都能改。留空则用本地。
 */

import { getSetting, setSetting } from '../setting/repository.js';
import { HttpMediaSource, LocalMediaSource, wordMedia, type MediaSource } from './media.js';

/** 设置键：远端媒体基地址。 */
export const KEY_WORD_MEDIA_BASE = 'word.mediaBase';

/** 本地媒体路径（由 vite 中间件提供）。 */
export const LOCAL_MEDIA_BASE = '/word-media';

/**
 * 默认远端地址：媒体部署所在的服务器。
 *
 * 公开版本不设默认远端；未配置时使用本地媒体。
 */
export const DEFAULT_REMOTE_BASE = ''; // 公开版本默认仅使用本地媒体，不探测私人服务器。

/**
 * 按当前配置挑一个媒体源，并装进全局缓存。
 *
 * 顺序：
 *   1. 设置里存了地址 → 用它；
 *   2. 没存 → 默认使用本地；若自行设置了默认远端则先探测；
 *   3. 还不通 → 本地 /word-media。
 *
 * **只在真正要用媒体时调用**（打开词光模块 / 开始学习），不要在模块顶层跑：
 * 那会让每次打开 JVS 都向远端发一次探测，服务器抖动还会在无关页面的控制台里
 * 留下 CORS 报错。
 *
 * @returns 实际使用的源。
 */
let resolving: Promise<MediaSource> | null = null;

export async function applyMediaSource(force = false): Promise<MediaSource> {
  if (!force && resolving !== null) return resolving;
  resolving = resolveMediaSource();
  return resolving;
}

async function resolveMediaSource(): Promise<MediaSource> {
  const saved = await getSetting(KEY_WORD_MEDIA_BASE).catch(() => null);
  const base = (saved ?? '').trim();

  if (base !== '') {
    const source: MediaSource = base === 'local' ? new LocalMediaSource(LOCAL_MEDIA_BASE) : new HttpMediaSource(base);
    wordMedia.useSource(source);
    return source;
  }

  // 没配置过：先看默认远端通不通。
  //
  // 注意用同一个实例探测并保留 —— probe() 会把可用的路径前缀记在实例上，
  // 换成新建实例就白探了，后面每个文件又得重新撞 404。
  if (!DEFAULT_REMOTE_BASE) {
    const source = new LocalMediaSource(LOCAL_MEDIA_BASE);
    wordMedia.useSource(source);
    return source;
  }
  const remote = new HttpMediaSource(DEFAULT_REMOTE_BASE);
  const remoteOk = await withTimeout(remote.probe(), 3000);
  const source: MediaSource = remoteOk !== null ? remote : new LocalMediaSource(LOCAL_MEDIA_BASE);
  wordMedia.useSource(source);
  return source;
}

/**
 * 给探测加超时：服务器不可达时不要让界面一直等。
 *
 * @param task - 探测任务。
 * @param ms - 超时毫秒。
 * @returns 任务结果，超时返回 null。
 */
async function withTimeout<T>(task: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 保存远端地址并立即生效。
 *
 * @param baseUrl - http(s) 地址；空字符串表示「自动」（公开版本默认本地），
 *                  填 `local` 表示强制用本地目录。
 * @returns 切换后的源。
 */
export async function setMediaBase(baseUrl: string): Promise<MediaSource> {
  const trimmed = baseUrl.trim();
  await setSetting(KEY_WORD_MEDIA_BASE, trimmed);
  if (trimmed === '') return applyMediaSource(true);
  const source: MediaSource = trimmed === 'local'
    ? new LocalMediaSource(LOCAL_MEDIA_BASE)
    : new HttpMediaSource(trimmed);
  wordMedia.useSource(source);
  resolving = Promise.resolve(source);
  return source;
}

/**
 * 测试一个地址能否取到媒体。
 *
 * @param baseUrl - 基地址。
 * @returns 成功时的示例 URL，失败为 null。
 */
export async function probeMediaBase(baseUrl: string): Promise<string | null> {
  const trimmed = baseUrl.trim();
  if (trimmed === '') return null;
  return new HttpMediaSource(trimmed).probe();
}

/**
 * 用户输入的地址是否可用。
 *
 * 空字符串（自动）和 `local`（强制本地）都算合法。
 *
 * @param value - 用户输入。
 * @returns 是否合法。
 */
export function isValidMediaBase(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'local') return true;
  return /^https?:\/\/[^\s]+$/i.test(trimmed);
}
