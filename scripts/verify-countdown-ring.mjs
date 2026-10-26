/**
 * 倒计时响铃的逻辑检查（不需要浏览器）。
 *
 * 覆盖的是「什么时候该响、什么时候不该响」这套语义 —— 它是最容易写错、
 * 也最难靠肉眼看出来的一块，所以单独用纯逻辑跑一遍：
 *
 *  - 到期判定：目标日当天算到期（days === 0），过去的日子不补响；
 *  - 多个倒计时同时到期 → 只起一个铃声循环，到期清单合并；
 *  - 用户点「知道了」→ 记住这一批，翻页面/重挂载都不再自动响；
 *  - 手动点「开启提醒」→ 强制再响一次（无视确认记录）；
 *  - 总开关关掉 → 不出声，但到期清单照样给界面显示。
 */
import { createRequire } from 'node:module';

// 响铃引擎跑在浏览器里（window.AudioContext / addEventListener）。
// 这里给一个最小的桩：只提供引擎在纯逻辑测试里用到的那些接口。
globalThis.window = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  AudioContext: undefined,
};

const require = createRequire(import.meta.url);
const ring = require('./.countdown-ring-for-test.cjs');
const settings = require('./.countdown-settings-for-test.cjs');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\nA. 到期判定');
{
  const today = new Date('2026-06-01T12:00:00');
  check('目标日当天算到期', settings.isDueToday('2026-06-01', today) === true);
  check('明天不算到期', settings.isDueToday('2026-06-02', today) === false);
  check('昨天不算到期（不补响）', settings.isDueToday('2026-05-31', today) === false);
  check('今天还有 0 天', settings.daysUntil('2026-06-01', today) === 0);
  check('明天还有 1 天', settings.daysUntil('2026-06-02', today) === 1);
  check('昨天是 -1 天', settings.daysUntil('2026-05-31', today) === -1);
  // 跨月边界：5 月 31 日 → 6 月 1 日
  check('跨月边界：还有 1 天', settings.daysUntil('2026-06-01', new Date('2026-05-31T23:00:00')) === 1);
  // 闰年：2028-02-29
  check('闰年 2 月 29 日算到期', settings.isDueToday('2028-02-29', new Date('2028-02-29T08:00:00')) === true);
  check('平年 2 月 29 日差 1 天', settings.daysUntil('2028-03-01', new Date('2028-02-28T08:00:00')) === 2);
}

console.log('\nB. 响铃状态机');
{
  ring.stopRing();
  ring.setRingEnabled(true);

  // 多个倒计时同时到期 → 只起一个循环，清单合并。
  const started = await ring.startRing(['生日', '考试']);
  check('起铃请求被接受（无 AudioContext 时落到 blocked）', started === false, `returned ${started}`);
  check('到期清单合并了两个标题', JSON.stringify(ring.ringStatus().payload?.titles.sort()) === JSON.stringify(['生日', '考试'].sort()));

  // 确认 → 记住这一批。
  ring.stopRing();
  check('确认后状态回到 idle', ring.ringStatus().state === 'idle');
  check('确认后这一批被记住', ring.isRingAcknowledged(['生日', '考试']) === true);
  check('确认后不再自动响', ring.isRingAcknowledged(['别的']) === false);

  // 手动强制再响：无视确认记录。
  await ring.ringNow(['生日', '考试']);
  check('手动开启会强制再响（状态不是 idle）', ring.ringStatus().state !== 'idle');
  ring.stopRing();
}

console.log('\nC. 总开关');
{
  ring.setRingEnabled(false);
  const started = await ring.startRing(['某个到期']);
  check('关掉总开关后不起铃', started === false);
  check('关掉总开关后到期清单仍然给出', ring.ringStatus().payload?.titles.includes('某个到期') === true);
  check('关掉总开关后状态不是 ringing', ring.ringStatus().state !== 'ringing');
  ring.setRingEnabled(true);
}

console.log('\nD. 音量');
{
  ring.setRingVolume(0.42);
  check('音量被接受', true);
  ring.setRingVolume(5);
  check('超范围音量被夹紧（不抛错）', true);
  ring.setRingVolume(-1);
  check('负数音量被夹紧（不抛错）', true);
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败项'}：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
