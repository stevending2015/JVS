/**
 * 环境声播放器。
 *
 * 移植自词光 word-atlas 的 sfx 实现（MIT）：用 Web Audio 的 AudioBufferSourceNode
 * 循环播放，而不是 `<audio loop>` —— 后者在 mp3 结尾会有可闻的缝隙，而
 * BufferSource 可以精确设定 loopStart / loopEnd，跳过解码器在首尾留的静音填充，
 * 循环才是无缝的。
 *
 * 浏览器策略：音频必须在一次用户手势之后才能出声，所以真正播放要等第一次
 * 点击/按键之后（见 armAmbience）。
 *
 * 七段素材随应用打包在 public/ambience/，离线可用。
 */

/** 一段环境声。 */
export interface AmbienceTrack {
  id: AmbienceId;
  label: string;
  /** 列表里显示的小图标。 */
  icon: string;
}

export type AmbienceId = 'stars' | 'rain' | 'sea' | 'forest' | 'fire' | 'voyage' | 'cafe';

export const AMBIENCE_TRACKS: AmbienceTrack[] = [
  { id: 'stars', label: '星空音乐', icon: '✨' },
  { id: 'rain', label: '雨天图书馆', icon: '🌧' },
  { id: 'sea', label: '清晨海岸', icon: '🌊' },
  { id: 'forest', label: '林间早晨', icon: '🌲' },
  { id: 'fire', label: '夜晚壁炉', icon: '🔥' },
  { id: 'voyage', label: '远航船舱', icon: '⛵' },
  { id: 'cafe', label: '安静咖啡馆', icon: '☕' },
];

/** 素材路径。 */
const BASE = '/ambience';

/** 默认音量。 */
export const DEFAULT_AMBIENCE_VOLUME = 0.45;

/** 正在播放的一段。 */
interface Playing {
  id: AmbienceId;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

let context: AudioContext | null = null;
let master: GainNode | null = null;
let playing: Playing | null = null;
let volume = DEFAULT_AMBIENCE_VOLUME;
/** 解码结果缓存，切回来时不用重新解码。 */
const buffers = new Map<AmbienceId, AudioBuffer>();
/** 正在加载的请求，避免连点导致重复解码。 */
const loading = new Map<AmbienceId, Promise<AudioBuffer | null>>();

/** 懒创建 AudioContext（必须在用户手势里或之后）。 */
function audio(): AudioContext | null {
  if (context !== null) return context;
  const Ctor = window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    context = new Ctor();
    master = context.createGain();
    master.gain.value = 1;
    master.connect(context.destination);
    return context;
  } catch {
    return null;
  }
}

/** 取一段音频的解码结果。 */
async function load(id: AmbienceId): Promise<AudioBuffer | null> {
  const cached = buffers.get(id);
  if (cached !== undefined) return cached;
  const running = loading.get(id);
  if (running !== undefined) return running;

  const task = (async (): Promise<AudioBuffer | null> => {
    const ctx = audio();
    if (ctx === null) return null;
    try {
      const response = await fetch(`${BASE}/amb-${id}.mp3`);
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      buffers.set(id, buffer);
      return buffer;
    } catch {
      return null;
    } finally {
      loading.delete(id);
    }
  })();

  loading.set(id, task);
  return task;
}

/** 当前这台的音量目标（考虑是否被压低）。 */
function level(): number {
  return volume;
}

/** 把增益平滑过渡到目标值。 */
function fadeTo(gain: GainNode, value: number, seconds: number): void {
  const ctx = audio();
  if (ctx === null) return;
  gain.gain.cancelScheduledValues(ctx.currentTime);
  gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(value, ctx.currentTime + seconds);
}

/**
 * 切换到某一段环境声（null = 关闭）。
 *
 * 同一段重复调用只是调整音量；换段时旧的那段淡出、新的淡入，会有短暂交叠，
 * 听起来比硬切自然。
 *
 * @param id - 目标片段，null 表示静音。
 * @param nextVolume - 音量 0–1。
 */
export async function setAmbience(id: AmbienceId | null, nextVolume = volume): Promise<void> {
  volume = Math.max(0, Math.min(1, nextVolume));
  const ctx = audio();
  if (ctx === null) return;
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);

  // 同一段：只调音量。
  if (playing !== null && playing.id === id) {
    fadeTo(playing.gain, level(), 0.4);
    return;
  }

  const old = playing;
  playing = null;
  if (old !== null) {
    fadeTo(old.gain, 0, 1.2);
    try {
      old.source.stop(ctx.currentTime + 1.3);
    } catch {
      // 已经停过就忽略。
    }
  }

  if (id === null) return;
  const buffer = await load(id);
  if (buffer === null || master === null) return;
  // 等待期间用户可能又换了目标。
  if (playing !== null) return;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  // 跳过解码器在首尾塞的静音，循环才没有缝。
  const padding = Math.min(0.06, buffer.duration / 8);
  source.loopStart = padding;
  source.loopEnd = Math.max(padding + 0.1, buffer.duration - padding);

  const gain = ctx.createGain();
  gain.gain.value = 0;
  source.connect(gain).connect(master);
  source.start(0, padding);
  playing = { id, source, gain };
  fadeTo(gain, level(), 2);
}

/**
 * 只调音量，不换曲。
 *
 * @param nextVolume - 0–1。
 */
export function setAmbienceVolume(nextVolume: number): void {
  volume = Math.max(0, Math.min(1, nextVolume));
  if (playing !== null) fadeTo(playing.gain, level(), 0.2);
}

/** 当前在播的片段。 */
export function currentAmbience(): AmbienceId | null {
  return playing?.id ?? null;
}

/**
 * 等第一次用户手势后再恢复播放。
 *
 * 浏览器不允许页面加载时自动出声；记下想播哪段，等用户第一次点击/按键时补上。
 *
 * @param desired - 期望播放的片段。
 * @param nextVolume - 音量。
 * @returns 清理函数。
 */
export function armAmbience(desired: AmbienceId | null, nextVolume: number): () => void {
  let armed = false;
  const arm = (): void => {
    if (armed) return;
    armed = true;
    void setAmbience(desired, nextVolume);
    removeEventListener('pointerdown', arm);
    removeEventListener('keydown', arm);
  };
  addEventListener('pointerdown', arm, { once: true });
  addEventListener('keydown', arm, { once: true });
  return () => {
    removeEventListener('pointerdown', arm);
    removeEventListener('keydown', arm);
  };
}

/** 停止并释放 AudioContext（页面卸载时用）。 */
export function stopAmbience(): void {
  if (playing !== null) {
    try {
      playing.source.stop();
    } catch {
      // 忽略。
    }
    playing = null;
  }
}
