/**
 * 媒体加载：插画和音频按需取，只缓存「当前正在学的那组」。
 *
 * 为什么不进数据库：整库媒体有 551 MB（插画 185 MB + 音频 366 MB），塞进
 * SQLite 会让数据库膨胀到不可收拾，而且每次查询都要跨 worker 搬大 BLOB。
 *
 * 缓存策略（用户定下的）：**只缓存当前学习的那 20–30 个词**，约 1.4–2 MB。
 *  - 一组媒体的量级：每词 ≈ 68 KB（插画 28 + 英音 8 + 美音 10 + 例句 22）
 *  - 换一组就清旧的，内存占用有上限
 *  - 关掉页面就丢，下次重新拉 —— 3 MB 在正常网络下不到一秒
 *
 * 媒体源是可替换的：现在用本地目录（开发期），以后接 CDN 只换一个实现。
 */

import { WORD_MEDIA, type WordEntry, type WordMediaKind } from './types.js';

/** 一个媒体源只负责「给我这个文件」。 */
export interface MediaSource {
  /** 源的名字，显示在设置里。 */
  readonly name: string;
  /**
   * 取一个媒体文件。
   *
   * @param wordId - 词 id。
   * @param kind - 媒体种类。
   * @returns 字节；没有这个文件时返回 null。
   */
  fetch(wordId: string, kind: WordMediaKind): Promise<Blob | null>;
}

/** 每次换组时最多留多少条缓存，防止无限增长。 */
export const MEDIA_CACHE_LIMIT = 240;

/** 媒体种类对应的文件扩展名。 */
const EXTENSION: Record<WordMediaKind, string> = {
  img: 'webp',
  uk: 'mp3',
  us: 'mp3',
  ex: 'mp3',
  ex2: 'mp3',
};

/**
 * 本地静态目录源。
 *
 * 开发期指向 word-atlas 的 `public/atlas/`（由 vite 的 publicDir 或代理提供）。
 * 生产环境换成 CDN 源即可，读取层的缓存逻辑完全复用。
 */
export class LocalMediaSource implements MediaSource {
  readonly name = '本地词库';

  constructor(private readonly baseUrl = '/word-media') {}

  async fetch(wordId: string, kind: WordMediaKind): Promise<Blob | null> {
    const folder = kind === 'img' ? 'img' : `audio/${kind}`;
    const url = `${this.baseUrl}/${folder}/${wordId}.${EXTENSION[kind]}`;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return await response.blob();
    } catch {
      return null;
    }
  }
}

/**
 * HTTP 源：从远端静态托管取（阿里云 / CDN）。
 *
 * 与本地源的唯一区别是 base URL；缓存层完全共享。
 *
 * 远端可能是三种目录布局之一，取决于服务器把 `public/` 挂在哪：
 *   - `<base>/atlas/img/x.webp`        （挂 public/ 的上一级）
 *   - `<base>/img/x.webp`              （直接挂 atlas/）
 *   - `<base>/public/atlas/img/x.webp` （挂仓库根）
 *
 * 首次取文件时按顺序试，**记住成功的那一种前缀**，之后所有请求直接用，
 * 不会每个文件都先撞一次 404。
 */
export class HttpMediaSource implements MediaSource {
  readonly name = '网络词库';

  /** 探测成功后缓存的前缀（例如 `/atlas` 或 空串）。 */
  private prefix: string | null = null;

  constructor(readonly baseUrl: string) {}

  /** 候选前缀，按「最可能」排序：服务器实际是 public/atlas，所以 atlas 优先。 */
  private static readonly PREFIXES = ['/atlas', '', '/public/atlas'];

  /** 把前缀 + 词 id 拼成 URL。 */
  private buildUrl(prefix: string, wordId: string, kind: WordMediaKind): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    const file = `${wordId}.${EXTENSION[kind]}`;
    const folder = kind === 'img' ? 'img' : `audio/${kind}`;
    return `${base}${prefix}/${folder}/${file}`;
  }

  /** 取一个词的全部候选 URL（已确定前缀时只有一个）。 */
  private candidates(wordId: string, kind: WordMediaKind): string[] {
    if (this.prefix !== null) return [this.buildUrl(this.prefix, wordId, kind)];
    return HttpMediaSource.PREFIXES.map((prefix) => this.buildUrl(prefix, wordId, kind));
  }

  async fetch(wordId: string, kind: WordMediaKind): Promise<Blob | null> {
    const tried = this.prefix === null ? HttpMediaSource.PREFIXES : [this.prefix];
    for (let index = 0; index < tried.length; index += 1) {
      const prefix = tried[index] as string;
      const url = this.buildUrl(prefix, wordId, kind);
      try {
        const response = await fetch(url, { mode: 'cors' });
        if (!response.ok) continue;
        const blob = await response.blob();
        // 有些服务器把 SPA 的 index.html 兜底返回 200，误当媒体会把图片搞坏。
        if (blob.type.startsWith('text/html')) continue;
        // 第一次成功就把前缀记下来，后续零浪费。
        this.prefix = prefix;
        return blob;
      } catch {
        // CORS 或网络错误：换下一个候选。
      }
    }
    return null;
  }

  /**
   * 测一下这个地址能不能真的取到媒体，顺便定下前缀。
   *
   * @returns 成功时的示例 URL，失败时为 null。
   */
  async probe(): Promise<string | null> {
    for (const prefix of HttpMediaSource.PREFIXES) {
      const url = this.buildUrl(prefix, 'abandon', 'img');
      try {
        const response = await fetch(url, { mode: 'cors' });
        if (!response.ok) continue;
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('image')) continue;
        this.prefix = prefix;
        return url;
      } catch {
        // 继续试。
      }
    }
    return null;
  }
}

/**
 * 当前组的媒体缓存。
 *
 * 键是 `词id:种类`，值是 object URL。换组时整体清空，并 revoke 掉旧的 URL ——
 * 不 revoke 会泄漏内存，backing blob 永远不会释放。
 */
export class WordMediaCache {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private source: MediaSource | null = null;

  /** 换一个媒体源，并清掉现有缓存。 */
  useSource(source: MediaSource): void {
    if (this.source === source) return;
    this.source = source;
    this.clear();
  }

  /** 当前源的显示名。 */
  get sourceName(): string {
    return this.source?.name ?? '未配置';
  }

  /** 已缓存的媒体条数。 */
  get size(): number {
    return this.urls.size;
  }

  /**
   * 取一个媒体的 object URL。
   *
   * @param wordId - 词 id。
   * @param kind - 媒体种类。
   * @returns 可用于 img/audio 的 URL，或 null。
   */
  async get(wordId: string, kind: WordMediaKind): Promise<string | null> {
    if (this.source === null) return null;
    const key = `${wordId}:${kind}`;
    const hit = this.urls.get(key);
    if (hit !== undefined) return hit;

    // 同一个媒体的并发请求合并：做题时图片和音频会同时要。
    const running = this.pending.get(key);
    if (running !== undefined) return running;

    const task = (async (): Promise<string | null> => {
      try {
        const blob = await this.source?.fetch(wordId, kind);
        if (blob === null || blob === undefined) return null;
        const url = URL.createObjectURL(blob);
        // 超出上限就先清空，宁可重拉也不要无限占用内存。
        if (this.urls.size >= MEDIA_CACHE_LIMIT) this.clear();
        this.urls.set(key, url);
        return url;
      } catch {
        return null;
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, task);
    return task;
  }

  /**
   * 预取一组词的媒体。
   *
   * 进「今日复习」时调用：把这批词的插画和发音先拉下来，做题时不会卡。
   *
   * @param entries - 这一组的词条。
   * @param onProgress - 每完成一个词回调一次（已完成数、总数）。
   */
  async prefetch(
    entries: WordEntry[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    // 换组时先清空，保证缓存里只有当前这一组。
    this.clear();
    const total = entries.length;
    let done = 0;
    for (const entry of entries) {
      const tasks: Array<Promise<string | null>> = [];
      if ((entry.media & WORD_MEDIA.img) !== 0) tasks.push(this.get(entry.id, 'img'));
      if ((entry.media & WORD_MEDIA.uk) !== 0) tasks.push(this.get(entry.id, 'uk'));
      if ((entry.media & WORD_MEDIA.us) !== 0) tasks.push(this.get(entry.id, 'us'));
      if ((entry.media & WORD_MEDIA.ex) !== 0) tasks.push(this.get(entry.id, 'ex'));
      await Promise.all(tasks);
      done += 1;
      onProgress?.(done, total);
    }
  }

  /** 清空缓存并释放 object URL。 */
  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pending.clear();
  }
}

/** 全局唯一的缓存实例。 */
export const wordMedia = new WordMediaCache();
