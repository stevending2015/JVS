/**
 * 兼容层（re-export）。
 *
 * 响铃引擎已经提升为全局的 {@link ../../core/audio/ring.ts}：专注模块也要
 * 「同一时间只响一个铃」，所以 AudioContext 必须只有一份。
 *
 * 这里保留原来的导入路径，倒计时模块与它的回归测试都不用改。
 */

export * from '../audio/ring.js';
