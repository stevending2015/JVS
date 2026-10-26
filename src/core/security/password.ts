/**
 * 应用锁：口令哈希与受保护模块的配置。
 *
 * **重要：这是界面级锁定，不是数据库加密。**
 * 数据库文件在 OPFS 里是明文的（sqlite-wasm 标准构建不带 SQLCipher），
 * 能打开 devtools 或直接读 OPFS 的人仍然可以绕过。它挡的是「同一台电脑上
 * 别人随手打开你的 JVS 就能看到全部数据」这类场景。
 *
 * 口令只存 PBKDF2-SHA256 的派生结果，不存明文；每次校验用新随机盐重新派生。
 */

import { getSetting, setSetting } from '../setting/repository.js';

/** 设置键，里面存整个 JSON 配置。 */
export const KEY_SECURITY = 'security.config';

/** 受保护范围的通配值：全部模块。 */
export const ALL_MODULES = '*';

/** 配置版本，将来改结构时用来迁移。 */
export interface SecurityConfig {
  /** 是否启用应用锁。 */
  enabled: boolean;
  /** 盐，base64。 */
  salt: string;
  /** PBKDF2 派生值，base64。 */
  hash: string;
  /** 迭代次数，存在配置里以便将来提高强度而不破坏旧口令。 */
  iterations: number;
  /** 受保护的模块 id；空数组表示只锁启动、不锁具体模块。 */
  modules: string[];
  /** 空闲多久自动上锁（毫秒）；0 表示不自动锁。 */
  autoLockMs: number;
  /** 从哪个版本开始启用（仅用于展示）。 */
  since: string;
}

/** 默认强度：足够抵抗离线暴力，手机上也在 100ms 量级。 */
export const DEFAULT_ITERATIONS = 150_000;

/** 默认空闲自动上锁时长：10 分钟。 */
export const DEFAULT_AUTO_LOCK_MS = 10 * 60 * 1000;

/** 自动上锁可选的时长（毫秒），0 = 关闭。 */
export const AUTO_LOCK_CHOICES: Array<{ ms: number; label: string }> = [
  { ms: 60_000, label: '1 分钟' },
  { ms: 5 * 60_000, label: '5 分钟' },
  { ms: DEFAULT_AUTO_LOCK_MS, label: '10 分钟' },
  { ms: 15 * 60_000, label: '15 分钟' },
  { ms: 30 * 60_000, label: '30 分钟' },
  { ms: 60 * 60_000, label: '1 小时' },
  { ms: 0, label: '不自动锁' },
];

/** 直接把 base64 编码成字符串。 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * base64 解回字节。
 *
 * 显式建在 ArrayBuffer 上（而不是默认的 ArrayBufferLike），否则 WebCrypto 的
 * BufferSource 参数在 TS 里不接受。
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 生成一个随机盐。 */
function randomSalt(): Uint8Array<ArrayBuffer> {
  const salt = new Uint8Array(new ArrayBuffer(16));
  crypto.getRandomValues(salt);
  return salt;
}

/**
 * 推导口令哈希。
 *
 * @param password - 用户输入的口令。
 * @param salt - 盐字节。
 * @param iterations - 迭代次数。
 * @returns 派生的 32 字节。
 */
async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** 定长比较，避免时序侧信道。 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

/** 口令长度下限。 */
export const MIN_PASSWORD_LENGTH = 4;

/**
 * 读出应用锁配置。
 *
 * @returns 配置，未设置时为 null。
 */
export async function readSecurityConfig(): Promise<SecurityConfig | null> {
  const raw = await getSetting(KEY_SECURITY).catch(() => null);
  if (raw === null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as SecurityConfig;
    if (typeof parsed.hash !== 'string' || typeof parsed.salt !== 'string') return null;
    return {
      enabled: parsed.enabled !== false,
      salt: parsed.salt,
      hash: parsed.hash,
      iterations: Number.isFinite(parsed.iterations) ? parsed.iterations : DEFAULT_ITERATIONS,
      modules: Array.isArray(parsed.modules) ? parsed.modules : [],
      autoLockMs: Number.isFinite(parsed.autoLockMs) ? Number(parsed.autoLockMs) : DEFAULT_AUTO_LOCK_MS,
      since: typeof parsed.since === 'string' ? parsed.since : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * 设置口令（首次启用或修改）。
 *
 * @param password - 新口令。
 * @param modules - 受保护模块；含 ALL_MODULES 表示全部。
 */
export async function setPassword(password: string, modules: string[]): Promise<SecurityConfig> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`口令至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  const salt = randomSalt();
  const hash = await derive(password, salt, DEFAULT_ITERATIONS);
  const config: SecurityConfig = {
    enabled: true,
    salt: toBase64(salt),
    hash: toBase64(hash),
    iterations: DEFAULT_ITERATIONS,
    modules,
    autoLockMs: DEFAULT_AUTO_LOCK_MS,
    since: new Date().toISOString(),
  };
  await setSetting(KEY_SECURITY, JSON.stringify(config));
  return config;
}

/**
 * 修改受保护模块，口令不变。
 *
 * @param modules - 新的模块列表。
 */
export async function setProtectedModules(modules: string[]): Promise<void> {
  const config = await readSecurityConfig();
  if (config === null) return;
  await setSetting(KEY_SECURITY, JSON.stringify({ ...config, modules }));
}

/**
 * 修改空闲自动上锁时长。
 *
 * @param ms - 毫秒；0 表示不自动锁。
 */
export async function setAutoLockMs(ms: number): Promise<void> {
  const config = await readSecurityConfig();
  if (config === null) return;
  const safe = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : DEFAULT_AUTO_LOCK_MS;
  await setSetting(KEY_SECURITY, JSON.stringify({ ...config, autoLockMs: safe }));
}

/**
 * 关闭应用锁（同时清掉口令）。
 */
export async function clearPassword(): Promise<void> {
  await setSetting(KEY_SECURITY, '');
}

/**
 * 校验口令。
 *
 * @param password - 用户输入。
 * @param config - 当前配置；不传则读库。
 * @returns 是否正确。
 */
export async function verifyPassword(
  password: string,
  config?: SecurityConfig | null,
): Promise<boolean> {
  const current = config === undefined ? await readSecurityConfig() : config;
  if (current === null) return true;
  const hash = await derive(password, fromBase64(current.salt), current.iterations);
  return equalBytes(hash, fromBase64(current.hash));
}

/**
 * 某个模块是否在受保护范围内。
 *
 * @param config - 应用锁配置。
 * @param moduleId - 模块 id。
 * @returns 是否需要口令。
 */
export function isModuleProtected(config: SecurityConfig | null, moduleId: string): boolean {
  if (config === null || !config.enabled) return false;
  if (config.modules.includes(ALL_MODULES)) return true;
  return config.modules.includes(moduleId);
}

/**
 * 是否只锁「全部模块」—— 这种模式下启动就要求口令，不需要进模块再问。
 *
 * @param config - 应用锁配置。
 * @returns 是否全锁。
 */
export function isGlobalLock(config: SecurityConfig | null): boolean {
  return config !== null && config.enabled && config.modules.includes(ALL_MODULES);
}

/** 会话内是否已解锁（表签名：会话级，关标签页即失效）。 */
const SESSION_KEY = 'jvs.unlocked';

/** 读取会话解锁标记。 */
export function readSessionUnlock(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

/** 记录会话已解锁。 */
export function markSessionUnlocked(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // 隐私模式可能禁用 sessionStorage：忽略，下次重新问。
  }
}

/** 清除会话解锁标记（「立即锁定」按钮用）。 */
export function clearSessionUnlock(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // 忽略。
  }
}

/**
 * 校验并导出当前配置里的口令哈希，供备份文件携带。
 *
 * @returns 哈希三元组；未设口令时为 null。
 */
export async function passwordFingerprint(): Promise<{ salt: string; hash: string; iterations: number } | null> {
  const config = await readSecurityConfig();
  if (config === null || !config.enabled) return null;
  return { salt: config.salt, hash: config.hash, iterations: config.iterations };
}

/**
 * 用备份文件里携带的哈希校验口令（用于导入前验证）。
 *
 * @param password - 用户输入。
 * @param fingerprint - 备份里的哈希。
 * @returns 是否正确。
 */
export async function verifyFingerprint(
  password: string,
  fingerprint: { salt: string; hash: string; iterations: number },
): Promise<boolean> {
  const hash = await derive(password, fromBase64(fingerprint.salt), fingerprint.iterations);
  return equalBytes(hash, fromBase64(fingerprint.hash));
}
