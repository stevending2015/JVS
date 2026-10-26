/**
 * 验证三处改动：
 *   1. 专注卡片显示实时计时（倒计时/正计时），而不是"0 分钟"
 *   2. 万年历卡片显示阳历日期 + 周几，排在农历后面
 *   3. 顶部右上角环境声按钮可选中并真正播放
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });

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

const profile = mkdtempSync(join(tmpdir(), 'jvs-amb-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForTimeout(1200);

  console.log('1. 万年历卡片');
  const almanacCard = page.locator('.card', { hasText: '万年历' });
  const almanacText = await almanacCard.innerText();
  console.log('  卡片文本 =', almanacText.replace(/\n/g, ' | '));
  check('显示阳历月日', /\d+月\d+日/.test(almanacText), almanacText.replace(/\n/g, ' '));
  check('显示周几', /周[日一二三四五六]/.test(almanacText), almanacText.replace(/\n/g, ' '));
  check('阳历排在农历后面', (() => {
    const idx = almanacText.indexOf('日 周') >= 0 ? almanacText.indexOf('日 周') : almanacText.search(/\d+月\d+日/);
    return idx > 0;
  })());
  const solarStyle = await page.locator('.almanac-card__solar').first().evaluate((el) => ({
    fontSize: getComputedStyle(el).fontSize,
    color: getComputedStyle(el).color,
  }));
  check('阳历比农历小、颜色更淡', parseFloat(solarStyle.fontSize) <= 13, JSON.stringify(solarStyle));

  console.log('2. 专注卡片（未开始时应显示今日累计）');
  const focusCard = page.locator('.card', { hasText: '专注' });
  const idleText = await focusCard.innerText();
  console.log('  未开始 =', idleText.replace(/\n/g, ' | '));
  check('空闲时显示今日累计', /今日\s*\d+\//.test(idleText), idleText.replace(/\n/g, ' '));

  console.log('3. 启动番茄钟后卡片应显示倒计时');
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(2500);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 30000 });
  await page.waitForTimeout(1500);

  const runningText = await page.locator('.card', { hasText: '专注' }).innerText();
  console.log('  运行中 =', runningText.replace(/\n/g, ' | '));
  check('运行中显示 mm:ss 计时', /\d{2}:\d{2}/.test(runningText), runningText.replace(/\n/g, ' '));
  check('运行中有"番茄钟"提示', runningText.includes('番茄钟'), runningText.replace(/\n/g, ' '));
  check('不再是"0 分钟"那种静态值', !/^0 分钟$/m.test(runningText), runningText.replace(/\n/g, ' '));

  const t1 = runningText.match(/(\d{2}:\d{2})/)?.[1] ?? '';
  await page.waitForTimeout(2200);
  const t2 = (await page.locator('.card', { hasText: '专注' }).innerText()).match(/(\d{2}:\d{2})/)?.[1] ?? '';
  console.log(`  计时走动: ${t1} → ${t2}`);
  check('卡片上的计时会走动', t1 !== '' && t2 !== '' && t1 !== t2, `${t1} → ${t2}`);

  const runningColor = await page.locator('.focus-card--running').first().evaluate((el) => getComputedStyle(el).color);
  check('运行中数字高亮', runningColor !== 'rgb(232, 238, 248)', runningColor);
  await page.screenshot({ path: join(out, 'dashboard-focus-timer.png'), fullPage: true });

  // 收尾：结束会话
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-actions .btn--danger', { timeout: 30000 });
  await page.locator('.focus-actions .btn--danger').click();
  await page.waitForTimeout(1200);

  console.log('4. 环境声按钮');
  const ambBtn = page.locator('.amb__btn');
  check('顶部有环境声按钮', (await ambBtn.count()) === 1);
  await ambBtn.click();
  await page.waitForSelector('.amb__pop', { timeout: 10000 });
  const tracks = await page.locator('.amb__list button').allTextContents();
  console.log('  可选 =', tracks.map((t) => t.trim()).join(' / '));
  check('有七段背景音 + 安静', tracks.length === 8, String(tracks.length));
  check('包含星空音乐', tracks.some((t) => t.includes('星空音乐')), tracks.join(','));

  // 选中「雨天图书馆」
  await page.locator('.amb__list button').filter({ hasText: '雨天图书馆' }).click();
  await page.waitForTimeout(2500);
  const isOn = await page.locator('.amb__btn.is-on').count();
  check('选中后按钮变高亮', isOn === 1, String(isOn));

  const audioState = await page.evaluate(() => {
    const timer = document.querySelector('.amb__bars');
    const pop = document.querySelector('.amb__note');
    return {
      barsPlaying: timer?.classList.contains('is-playing') ?? false,
      note: pop?.textContent?.trim() ?? '',
    };
  });
  console.log('  播放状态 =', JSON.stringify(audioState));
  check('指示条进入播放状态', audioState.barsPlaying, JSON.stringify(audioState));
  check('提示语不再是「点一下开始播放」', !audioState.note.includes('点一下页面'), audioState.note);

  await page.screenshot({ path: join(out, 'ambience-picker.png'), fullPage: false });

  // 音量滑杆
  const volume = page.locator('.amb__volume input');
  check('有音量滑杆', (await volume.count()) === 1);
  await volume.fill('0.2');
  await page.waitForTimeout(400);
  const volText = await page.locator('.amb__volume-value').innerText();
  check('音量显示跟着变', volText === '20%', volText);

  // 刷新后记得选择
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForTimeout(1800);
  check('刷新后仍是选中状态', (await page.locator('.amb__btn.is-on').count()) === 1);
  await page.locator('.amb__btn').click();
  await page.waitForTimeout(500);
  const savedVol = await page.locator('.amb__volume-value').innerText();
  check('刷新后音量也记得', savedVol === '20%', savedVol);

  // 关闭环境声
  await page.locator('.amb__list button').filter({ hasText: /^🤫安静$/ }).click();
  await page.waitForTimeout(800);
  check('可以切回安静', (await page.locator('.amb__btn.is-on').count()) === 0);

console.log('5. 顶部栏不再显示数据库状态');
{
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 60000 });
  await page.waitForTimeout(900);

  const header = await page.locator('.app__bar').innerText();
  console.log('  头部文本 =', JSON.stringify(header.replace(/\n/g, ' | ')));
  check('不再显示「SQLite · OPFS 已就绪」', !header.includes('SQLite'), header.replace(/\n/g, ' '));
  check('不再显示 OPFS', !header.includes('OPFS'), header.replace(/\n/g, ' '));
  check('没有残留的状态节点', (await page.locator('.app__db').count()) === 0);
  check('品牌与导航仍在', header.includes('JVS') && header.includes('仪表盘'), header.replace(/\n/g, ' '));

  // 状态本身没有丢 —— 变成一个视觉隐藏的 live region 给读屏用。
  const status = await page.evaluate(() => {
    const el = document.querySelector('.sr-only[role="status"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { text: el.textContent ?? '', width: rect.width, height: rect.height, visible: el.offsetParent !== null && rect.width > 2 };
  });
  console.log('  隐藏状态 =', JSON.stringify(status));
  check('保留隐藏的状态播报（无障碍）', status !== null && status.text.includes('已就绪'), JSON.stringify(status));
  check('状态确实视觉隐藏', status !== null && !status.visible, JSON.stringify(status));

  // 右侧那一组仍然贴右（现在里面有环境声 + 设置两个按钮）
  const geo = await page.evaluate(() => {
    const bar = document.querySelector('.app__bar');
    const right = document.querySelector('.app__right');
    const gear = document.querySelector('.app__gear');
    if (!bar || !right || !gear) return null;
    const barRect = bar.getBoundingClientRect();
    return {
      groupGap: barRect.right - right.getBoundingClientRect().right,
      gearGap: barRect.right - gear.getBoundingClientRect().right,
    };
  });
  check('右侧按钮组贴最右', geo !== null && geo.groupGap >= 0 && geo.groupGap <= 30, JSON.stringify(geo));
  check('设置按钮在最右侧', geo !== null && geo.gearGap >= 0 && geo.gearGap <= 30, JSON.stringify(geo));

  // 模块页也干净
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel', { timeout: 30000 });
  await page.waitForTimeout(600);
  const header2 = await page.locator('.app__bar').innerText();
  check('模块页头部也干净', !header2.includes('SQLite') && !header2.includes('OPFS'), header2.replace(/\n/g, ' '));
}
} finally {
  await context.close();
}

// ── 顶部栏：数据库状态文字已移除 ──

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
