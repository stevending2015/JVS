/**
 * 倒计时响铃引擎（持续响铃）。
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

/** 铃响时同时要显示的到期倒计时。 */
export interface RingPayload {
  /** 到期倒计时的标题（可能有多个）。 */
  titles: string[];
}

type Listener = (state: RingState, payload: RingPayload | null) => void;

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
let state: RingState = 'idle';
let payload: RingPayload | null = null;
/** 是否已经发生过用户手势 —— 没发生过的话 AudioContext 起不来。 */
let armed = false;
/**
 * 已经被用户「知道了」确认过的到期集合（按标题排序后拼成的键）。
 *
 * 为什么要记在这里而不是组件里：铃声是全局单例，而 React 组件会卸载重挂
 * （比如从倒计时页切回仪表盘再切回来）。如果只存在组件的 ref 里，用户点过
 * 「知道了」之后一离开页面，铃又会重新响起来 —— 确认过的就该保持安静。
 */
let acknowledgedKey = '';
/**
 * 用户是否允许响铃（总开关）。
 *
 * 放在引擎里而不是组件里，是因为仪表盘卡片和倒计时页都会触发起铃 —— 只有一
 * 个地方知道「用户把声音关了」，才不会出现「页面上一看是关的、卡片上却在响」。
 */
let enabled = true;
const listeners = new Set<Listener>();

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

/** 通知所有订阅者状态变了。 */
function publish(): void {
  for (const listener of listeners) listener(state, payload);
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
    if (state !== 'ringing' || context === null) return;
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
 * @param next - 本次到期的倒计时标题。
 * @param force - 即使确认过也强制重新响。
 * @returns 是否真的响起来了（false = 被自动播放策略挡住，等用户手势）。
 */
export async function startRing(next: string[], force = false): Promise<boolean> {
  const merged = new Set<string>(payload?.titles ?? []);
  for (const title of next) merged.add(title);
  const key = [...merged].sort().join('\u0000');
  if (!force && acknowledgedKey !== '' && key === acknowledgedKey) {
    // 用户已经确认过了，保持安静。
    return state === 'ringing';
  }
  if (!enabled) {
    // 用户把声音关了：记下到期清单（界面上要显示「到点了」）但不出声。
    payload = { titles: [...merged] };
    publish();
    return false;
  }
  payload = { titles: [...merged] };
  if (state === 'ringing') {
    publish();
    return true;
  }
  const ok = await begin();
  state = ok ? 'ringing' : 'blocked';
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
    state = 'idle';
    publish();
  }
}

/**
 * 停止响铃（用户已确认）。
 *
 * 同时记下这次的到期集合，之后不再自动响 —— 用户确认过就是确认过，翻页面、
 * 刷新都不该又响起来。
 */
export function stopRing(): void {
  if (payload !== null) acknowledgedKey = payload.titles.slice().sort().join('\u0000');
  end();
  state = 'idle';
  publish();
}

/**
 * 等第一次用户手势后再起铃。
 *
 * 浏览器不允许页面加载时自动出声；如果用户在倒计时到期前从未点过页面，
 * AudioContext 会一直是 suspended。这时挂一个一次性的手势监听，用户第一次
 * 点击/按键时把铃补上。
 *
 * @param next - 本次到期的倒计时标题。
 * @returns 清理函数。
 */
export function armRing(next: string[]): () => void {
  const arm = (): void => {
    armed = true;
    removeEventListener('pointerdown', arm);
    removeEventListener('keydown', arm);
    if (state === 'blocked') {
      // 状态是 blocked 说明用户还没确认过（确认过就不会再进来），
      // 现在有了手势，直接把铃补上。
      void begin().then((ok) => {
        state = ok ? 'ringing' : 'blocked';
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
export function ringStatus(): { state: RingState; payload: RingPayload | null } {
  return { state, payload };
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
export function isRingAcknowledged(titles: string[]): boolean {
  if (acknowledgedKey === '' || titles.length === 0) return false;
  return titles.slice().sort().join('\u0000') === acknowledgedKey;
}

/**
 * 订阅铃响状态。
 *
 * @param listener - 状态变化时调用，回调参数是（状态, 到期清单）。
 * @returns 退订函数。
 */
export function subscribeRing(listener: Listener): () => void {
  listeners.add(listener);
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
  if (ctx !== null && master !== null && state === 'ringing') {
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
 * @param next - 本次到期的倒计时标题。
 * @returns 是否成功。
 */
export async function ringNow(next: string[]): Promise<boolean> {
  armed = true;
  // 用户是主动点的「开启提醒 / 开始响铃」，所以强制响 —— 即便之前确认过。
  // 但总开关仍然尊重：用户把声音整个关了，就不该因为点一下又响起来。
  return startRing(next, true);
}

/** 页面是否已经发生过用户手势。 */
export function isRingArmed(): boolean {
  return armed;
}
