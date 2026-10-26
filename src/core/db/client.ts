/**
 * UI-thread proxy for the SQLite worker, with single-owner election.
 *
 * Why this is not just `new Worker(...)`:
 *
 * The OPFS `opfs-sahpool` VFS takes EXCLUSIVE synchronous access handles on its
 * pool directory, and those handles only exist in a Dedicated Worker. Two tabs
 * each opening their own worker therefore collide with
 *
 *   NoModificationAllowedError: Access Handles cannot be created if there is
 *   another open Access Handle or Writable stream associated with the same file.
 *
 * A SharedWorker would be the obvious shared owner, but the OPFS APIs are not
 * exposed in the SharedWorker global scope ("Missing required OPFS APIs"), so it
 * cannot hold the database either.
 *
 * So: Web Locks elect exactly one owning tab. The owner runs the worker; any
 * other tab reports a clear message and then AUTOMATICALLY takes over when the
 * owner goes away, because a queued lock request is granted the moment the
 * holder releases it.
 *
 * The transport and client are cached on `globalThis` so a Vite hot reload does
 * not spawn a second worker against the live one.
 */

import type { DbInfo, DbRequest, DbResponse } from './protocol.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Transport {
  worker?: Worker;
  client?: DbClient;
}

const REGISTRY_KEY = Symbol.for('jvs.sqlite.registry');
const root = globalThis as unknown as { [key: symbol]: Transport | undefined };
const transport: Transport = (root[REGISTRY_KEY] ??= {});

const OWNER_LOCK = 'jvs-sqlite-owner';
const OPEN_TIMEOUT_MS = 30_000;

/** Shown when another tab owns the database. */
export const DB_BUSY_MESSAGE =
  '数据库已在另一个标签页中打开。关闭那个标签页后，这里会自动接管。';

export class DbClient {
  private info: DbInfo | null = null;
  private opening: Promise<DbInfo> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ownsDatabase = false;
  private ownershipQueued = false;
  private readonly holdPromise = new Promise<void>(() => {});
  private readonly takeoverListeners = new Set<() => void>();

  get databaseInfo(): DbInfo | null {
    return this.info;
  }

  /** Subscribe to "another tab released the database, we now own it". */
  onTakeover(listener: () => void): () => void {
    this.takeoverListeners.add(listener);
    return () => {
      this.takeoverListeners.delete(listener);
    };
  }

  /** Open (once) and return the database description. */
  async open(): Promise<DbInfo> {
    if (this.info !== null) return this.info;
    if (this.opening !== null) return this.opening;
    this.opening = this.start();
    try {
      this.info = await this.opening;
      return this.info;
    } finally {
      this.opening = null;
    }
  }

  /** Reconnect the transport and open again; used by the retry button. */
  async retry(): Promise<DbInfo> {
    this.failAll(new Error('已重新连接数据库'));
    this.info = null;
    if (transport.worker !== undefined) {
      transport.worker.terminate();
      transport.worker = undefined;
    }
    return this.open();
  }

  private async start(): Promise<DbInfo> {
    const owned = await this.ensureOwnership();
    if (!owned) {
      this.queueOwnershipWait();
      throw new Error(DB_BUSY_MESSAGE);
    }
    this.connect();
    await this.withTimeout(this.all('SELECT 1 AS ok'));
    return { vfs: 'opfs-sahpool', persistent: true, dbFile: '/jvs.db' };
  }

  /**
   * Try to become the single owning tab. Resolves false when someone else holds
   * the lock.
   */
  private async ensureOwnership(): Promise<boolean> {
    if (this.ownsDatabase) return true;
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (locks === undefined || typeof locks.request !== 'function') {
      // No Web Locks: this is a single-tab fallback. The OPFS error, if any, is
      // reported by the worker in a readable form.
      this.ownsDatabase = true;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      void locks.request(OWNER_LOCK, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (lock === null) {
          resolve(false);
          return;
        }
        this.ownsDatabase = true;
        resolve(true);
        await this.holdPromise;
      });
    });
  }

  /** Wait in the background for the owner to release, then take over. */
  private queueOwnershipWait(): void {
    if (this.ownershipQueued) return;
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (locks === undefined || typeof locks.request !== 'function') return;
    this.ownershipQueued = true;
    void locks.request(OWNER_LOCK, { mode: 'exclusive' }, async () => {
      this.ownsDatabase = true;
      this.ownershipQueued = false;
      try {
        this.connect();
        await this.withTimeout(this.all('SELECT 1 AS ok'));
        this.info = { vfs: 'opfs-sahpool', persistent: true, dbFile: '/jvs.db' };
        for (const listener of this.takeoverListeners) listener();
      } catch {
        // Stay in the error state; the retry button remains available.
      }
      await this.holdPromise;
    });
  }

  private async withTimeout(promise: Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('数据库初始化超时。若其他标签页正在使用，请关闭后点「重试」。'));
      }, OPEN_TIMEOUT_MS);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error as Error);
        },
      );
    });
  }

  private connect(): void {
    if (transport.worker !== undefined) {
      const worker = transport.worker;
      worker.onmessage = (event: MessageEvent) => this.dispatch(event.data as DbResponse);
      return;
    }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => this.dispatch(event.data as DbResponse);
    worker.onerror = (event) => this.failAll(new Error(event.message || 'SQLite worker 启动失败'));
    transport.worker = worker;
  }

  private dispatch(response: DbResponse): void {
    const entry = this.pending.get(response.id);
    if (entry === undefined) return;
    this.pending.delete(response.id);
    if (response.ok) entry.resolve(response.value);
    else entry.reject(new Error(response.error));
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private send(request: DbRequest): Promise<unknown> {
    const worker = transport.worker;
    if (worker === undefined) return Promise.reject(new Error('数据库尚未连接'));
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.send({ id: this.nextId++, kind: 'all', sql, params })) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
    return (await this.send({ id: this.nextId++, kind: 'run', sql, params })) as {
      changes: number;
      lastInsertRowid: number;
    };
  }

  async exec(sql: string): Promise<void> {
    await this.send({ id: this.nextId++, kind: 'exec', sql });
  }
}

transport.client ??= new DbClient();
export const db: DbClient = transport.client;