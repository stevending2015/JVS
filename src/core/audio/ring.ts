/**
 * 全局响铃引擎（持续响铃）—— 倒计时的到期提醒和专注的番茄结束共用这一份。
 *
 * 为什么必须共用：两处都要「一直响到用户点掉为止」，各建一个 AudioContext 就会
 * 在两个提醒同时到来时叠出两层声音，而且浏览器对空闲上下文有数量限制。
 *
 *
 * 为什么不用打包的音频文件：响铃必须「一直响到用户点掉为止」，而一个音频文件
 * 循环播放时首尾接缝会「咔」一下；用 Web Audio 的振荡器现合成则完全无缝，
 * 而且不用往仓库里塞二进制资源（应用要保持离线自足）。
 *
 * 为什么单独一个模块：响铃状态是全局的 —— 仪表盘卡片、倒计时页、甚至弹窗外面
 * 都要知道「现在在响铃」，而 React 组件的挂载顺序不保证。先放在这里做成单例，
 * 由组件通过订阅拿到状态，避免各组件各建一份 AudioContext 互相叠音。
 *
 * 浏览器自动播放策略：AudioContext 初始是 suspended 状态，必须在一次用户手势
 * 之后 resume() 才会出声。所以这里提供两条路：
 *  1. 用户已经点过页面（armed）→ 直接起铃；
 *  2. 用户还没交互过 → 起铃失败，等第一次 pointerdown / keydown 再补上
 *     （见 armRing）。组件层据此显示「开启提醒」按钮做兜底。
 */

/** 铃响的两种状态。 */
export type RingState = 'idle' | 'ringing' | 'blocked';

/**
 * 默认来源 = 倒计时。
 *
 * 这样倒计时模块和它的回归测试一行都不用改；专注那边显式传 `'focus'`。
 */
export const DEFAULT_SOURCE = 'countdown';

/** 专注结束提醒用的来源标识。 */
export const FOCUS_RING_SOURCE = 'focus';

/** 铃响时要显示的内容，以及这次提醒的身份。 */
export interface RingPayload {
  /** 要显示的标题（倒计时可能是多个标题）。 */
  titles: string[];
  /**
   * 这次提醒的唯一标识，用于「确认过就别再响」。
   *
   * 倒计时用标题拼出来即可（同一批到期项确认一次就够）；但专注每结束一个
   * 番茄都是**新的一次**提醒 —— 如果也只按标题算，用户确认过一次「专注结束」
   * 之后，下一个番茄结束时就不会再响了。所以调用方可以显式给一个每次都不同的
   * key（如 session id）。
   */
  key: string;
}

type Listener = (state: RingState, payload: RingPayload | null) => void;

/**
 * 没有显式 key 时，用标题集合派生一个。
 *
 * 这样倒计时那套「同一批到期项确认一次就保持安静」的行为完全不变。
 *
 * @param titles - 标题列表。
 * @returns 稳定的字符串键（与顺序无关）。
 */
function derivedKey(titles: string[]): string {
  return titles.slice().sort().join('\u0000');
}

/** 一次「哔—哔」双响里，单声的长度（秒）。 */
const BURST = 0.32;
/** 两声之间的停顿（秒）。 */
const GAP = 0.2;
/** 一轮双响结束后到下一轮的间隔（秒）。 */
const CYCLE_GAP = 1.5;

/** 双响的基频。用两个略微失谐的正弦叠加，像老电话那样有一点金属味。 */
const BASE_FREQUENCY = 740;

let context: AudioContext | null = null;
let master: GainNode | null = null;
let timer: number | null = null;
let volume = 0.7;
/** 音频本身的状态：只要有任意来源要响，它就是 ringing。 */
let audioState: RingState = 'idle';
/** 是否已经发生过用户手势 —— 没发生过的话 AudioContext 起不来。 */
let armed = false;

/**
 * 每个来源（倒计时 / 专注）各自待提醒的条目。
 *
 * 为什么要按来源分开：两处共用同一个铃声，但**提醒是各自的**。以前把标题合并在
 * 一个 payload 里，结果专注结束的「专注结束」被倒计时模块当成自己的一条到期项
 * 显示出来（页面上出现「到点了：开会、专注结束」）。分开之后各读各的。
 */
const active = new Map<string, RingPayload>();
/**
 * 每个来源已经被用户「知道了」确认过的键。
 *
 * 为什么要记在这里而不是组件里：铃声是全局单例，而 React 组件会卸载重挂
 * （比如从倒计时页切回仪表盘再切回来）。如果只存在组件的 ref 里，用户点过
 * 「知道了」之后一离开页面，铃又会重新响起来 —— 确认过的就该保持安静。
 * 分来源记，才不会「确认了专注」把倒计时的提醒也一并消音。
 */
const acknowledged = new Map<string, string>();
/**
 * 用户是否允许响铃（总开关，属于倒计时页面上的那个开关）。
 *
 * 放在引擎里而不是组件里，是因为仪表盘卡片和倒计时页都会触发起铃 —— 只有一
 * 个地方知道「用户把声音关了」，才不会出现「页面上一看是关的、卡片上却在响」。
 */
let enabled = true;
/** 订阅者连同它关心的来源一起记，publish 时只回各自的条目。 */
const listeners = new Map<Listener, string>();

/** 懒创建 AudioContext（必须在用户手势里或之后）。 */
function audio(): AudioContext | null {
  if (context !== null) return context;
  const Ctor = window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    context = new Ctor();
    master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);
    return context;
  } catch {
    return null;
  }
}

/**
 * 某个来源此刻该看到的状态。
 *
 * 有条目 + 音频在响 = ringing；有条目但音频没起来 = blocked（被自动播放策略挡了）；
 * 没有条目 = idle（哪怕别的来源正在响，这个来源也不该显示「正在响」）。
 *
 * @param source - 来源标识。
 * @returns 该来源的状态。
 */
function stateFor(source: string): RingState {
  if (!active.has(source)) return 'idle';
  return audioState;
}

/** 通知所有订阅者：每个人只拿到自己关心的那个来源。 */
function publish(): void {
  for (const [listener, source] of listeners) {
    listener(stateFor(source), active.get(source) ?? null);
  }
}

/**
 * 响一声「哔—哔」。
 *
 * 用两个略微失谐的三角波叠加再过一层带通，模拟电话的铃声：单音太尖太刺耳，
 * 直接方波更吵。两个频率差 6 Hz 会产生缓慢的「呜——」摆动，听感柔和很多。
 *
 * @param ctx - 音频上下文。
 * @param at - 起始时间（AudioContext 的时间轴）。
 */
function burst(ctx: AudioContext, at: number): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.9, at + 0.02);
  gain.gain.setValueAtTime(0.9, at + BURST - 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + BURST);

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = BASE_FREQUENCY;
  filter.Q.value = 1.1;

  for (const detune of [-6, 6]) {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.value = BASE_FREQUENCY;
    oscillator.detune.value = detune;
    oscillator.connect(filter);
    oscillator.start(at);
    oscillator.stop(at + BURST + 0.02);
  }

  filter.connect(gain);
  if (master !== null) gain.connect(master);
}

/**
 * 排下一轮双响。
 *
 * 用递归的 setTimeout 而不是 setInterval：setInterval 在标签页被节流时会把
 * 回调挤在一起，一次补响好几轮，听起来像卡顿。递归排期每次只排一个，
 * 被节流也只是延后，不会堆积。
 *
 * @param ctx - 音频上下文。
 */
function scheduleCycle(ctx: AudioContext): void {
  if (timer !== null) window.clearTimeout(timer);
  const now = ctx.currentTime;
  burst(ctx, now);
  burst(ctx, now + BURST + GAP);
  const next = now + BURST * 2 + GAP + CYCLE_GAP;
  timer = window.setTimeout(() => {
    if (audioState !== 'ringing' || context === null) return;
    scheduleCycle(context);
  }, Math.max(120, (next - ctx.currentTime) * 1000));
}

/**
 * 真正开始响铃。
 *
 * resume() 是异步的：调用它之后 state 不会立刻变成 'running'，所以这里 await
 * 它的 Promise，再看最终结果。在没有用户手势的情况下 resume() 会被拒绝，
 * 这正是「被自动播放策略挡住」的可靠信号。
 *
 * @returns 是否成功开始（false 表示被自动播放策略挡住了）。
 */
async function begin(): Promise<boolean> {
  const ctx = audio();
  if (ctx === null) return false;
  if (ctx.state === 'suspended') {
    // 没有用户手势时 resume() 会失败（Promise reject），这就是「被策略挡住」的信号。
    try {
      await ctx.resume();
    } catch {
      return false;
    }
    if (ctx.state === 'suspended') return false;
  }
  if (master === null) return false;
  master.gain.setValueAtTime(0.0001, ctx.currentTime);
  master.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), ctx.currentTime + 0.12);
  scheduleCycle(ctx);
  return true;
}

/** 停止响铃并淡出。 */
function end(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  const ctx = context;
  if (ctx !== null && master !== null) {
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
  }
}

/**
 * 开始（保持）响铃。
 *
 * 幂等：已经在响时不重启铃声，只更新要显示的到期清单 —— 多个倒计时同时到期
 * 不该叠出好几层声音。
 *
 * 已经确认过（用户点过「知道了」）的到期集合不会再响，除非调用方显式要求
 * 重新提醒（{@link ringNow}）—— 手动点「开始响铃」时用户就是想再听一遍。
 *
 * @param next - 本次要提醒的标题。
 * @param force - 即使确认过也强制重新响。
 * @param keyHint - 可选的身份键（见 RingPayload.key）。
 * @param bypassMute - 跳过引擎的总开关。
 *
 *   引擎的总开关是给**倒计时**用的（用户可以把倒计时声音关掉）。专注有自己的
 *   「结束提示音」开关，两者互不隶属 —— 如果专注也去动这个总开关，用户关掉
 *   倒计时声音就会连专注一起哑掉，反之亦然。所以专注响铃时显式跳过它，
 *   自己判断自己的开关。
 *
 * @returns 是否真的响起来了（false = 被自动播放策略挡住，等用户手势）。
 */
export async function startRing(
  next: string[],
  force = false,
  keyHint?: string,
  bypassMute = false,
  source = DEFAULT_SOURCE,
): Promise<boolean> {
  const previous = active.get(source);
  const merged = new Set<string>(previous?.titles ?? []);
  for (const title of next) merged.add(title);
  const key = keyHint ?? derivedKey([...merged]);
  const acked = acknowledged.get(source);
  if (!force && acked !== undefined && acked === key) {
    // 用户已经确认过了，保持安静。
    return stateFor(source) === 'ringing';
  }

  const payload: RingPayload = { titles: [...merged], key };

  if (!enabled && !bypassMute) {
    // 用户把声音关了：记下要显示的清单（界面上要显示「到点了」）但不出声。
    active.set(source, payload);
    publish();
    return false;
  }

  active.set(source, payload);
  if (audioState === 'ringing') {
    // 已经在响（可能是另一个来源在响）：共用同一个铃声，不重新起一遍。
    publish();
    return true;
  }
  const ok = await begin();
  audioState = ok ? 'ringing' : 'blocked';
  publish();
  return ok;
}

/**
 * 设置响铃总开关。
 *
 * 关掉时正在响的铃立刻停 —— 用户已经明确不要声音了。
 *
 * @param on - 是否允许响铃。
 */
export function setRingEnabled(on: boolean): void {
  enabled = on;
  if (!enabled) {
    end();
    audioState = 'idle';
    publish();
  }
}

/**
 * 停止响铃（用户已确认）。
 *
 * 同时记下这次的到期集合，之后不再自动响 —— 用户确认过就是确认过，翻页面、
 * 刷新都不该又响起来。
 */
export function stopRing(source = DEFAULT_SOURCE): void {
  const current = active.get(source);
  if (current !== undefined) {
    acknowledged.set(source, current.key);
    active.delete(source);
  }
  // 还有别的来源要响就继续响 —— 停专注不该顺带把倒计时的铃也停掉。
  if (active.size === 0) {
    end();
    audioState = 'idle';
  }
  publish();
}

/**
 * 等第一次用户手势后再起铃。
 *
 * 浏览器不允许页面加载时自动出声；如果用户在倒计时到期前从未点过页面，
 * AudioContext 会一直是 suspended。这时挂一个一次性的手势监听，用户第一次
 * 点击/按键时把铃补上。
 *
 * @returns 清理函数。
 */
export function armRing(): () => void {
  const arm = (): void => {
    armed = true;
    removeEventListener('pointerdown', arm);
    removeEventListener('keydown', arm);
    if (audioState === 'blocked') {
      // 状态是 blocked 说明用户还没确认过（确认过就不会再进来），
      // 现在有了手势，直接把铃补上。
      void begin().then((ok) => {
        audioState = ok ? 'ringing' : 'blocked';
        publish();
      });
    }
  };
  addEventListener('pointerdown', arm);
  addEventListener('keydown', arm);
  return () => {
    removeEventListener('pointerdown', arm);
    removeEventListener('keydown', arm);
  };
}

/**
 * 当前铃响状态。
 *
 * @returns 状态与到期清单。
 */
export function ringStatus(source = DEFAULT_SOURCE): { state: RingState; payload: RingPayload | null } {
  return { state: stateFor(source), payload: active.get(source) ?? null };
}

/**
 * 这批到期倒计时是不是已经被用户确认过了。
 *
 * 确认之后就保持安静 —— 翻页面、刷新都不再自动响。界面上据此把横幅改成
 * 「已确认」的说法，而不是一直显示「铃声当前是关闭的」。
 *
 * @param titles - 要检查的到期标题。
 * @returns 是否已确认。
 */
export function isRingAcknowledged(
  titles: string[],
  key?: string,
  source = DEFAULT_SOURCE,
): boolean {
  const acked = acknowledged.get(source);
  const wanted = key ?? (titles.length > 0 ? derivedKey(titles) : '');
  if (acked === undefined || wanted === '') return false;
  return wanted === acked;
}

/**
 * 订阅铃响状态。
 *
 * @param listener - 状态变化时调用，回调参数是（状态, 到期清单）。
 * @returns 退订函数。
 */
export function subscribeRing(listener: Listener, source = DEFAULT_SOURCE): () => void {
  listeners.set(listener, source);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 设置铃声音量。
 *
 * @param next - 0–1。
 */
export function setRingVolume(next: number): void {
  volume = Math.max(0, Math.min(1, next));
  const ctx = context;
  if (ctx !== null && master !== null && audioState === 'ringing') {
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), ctx.currentTime);
    master.gain.linearRampToValueAtTime(Math.max(0.0001, volume), ctx.currentTime + 0.15);
  }
}

/**
 * 用户点过页面之后可以直接起铃（不必再等手势）。
 *
 * 供组件在手势回调里调用：那一刻手势已经发生，resume() 一定成功。
 *
 * @param next - 本次要提醒的标题。
 * @param key - 可选的身份键（专注每结束一次都要新的，见 RingPayload.key）。
 * @returns 是否成功。
 */
export async function ringNow(
  next: string[],
  key?: string,
  bypassMute = false,
  source = DEFAULT_SOURCE,
): Promise<boolean> {
  armed = true;
  // 用户是主动点的「开启提醒 / 开始响铃」，所以强制响 —— 即便之前确认过。
  // 但总开关仍然尊重：用户把声音整个关了，就不该因为点一下又响起来。
  return startRing(next, true, key, bypassMute, source);
}

/** 页面是否已经发生过用户手势。 */
export function isRingArmed(): boolean {
  return armed;
}
