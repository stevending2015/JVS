/**
 * 验证「设置 / 应用锁 / 数据备份导入」。
 *
 * 锁的交互模型（用户指定）：
 *   - 右上角锁形按钮只在「设了口令 + 至少勾了一个受保护模块」时出现
 *   - 锁定后，所有受保护模块上覆盖一把锁
 *   - 点右上角锁按钮 → 弹口令框 → 输对解锁
 *   - 解锁状态下点它 → 立刻锁上
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const PASSWORD = 'test-1234';
const backupPath = join(out, 'test-backup.jvsbackup');
const badPath = join(out, 'not-a-backup.json');

async function ready(page) {
  await page.waitForFunction(
    () => document.body.innerText.includes('SQLite · OPFS 已就绪'),
    undefined,
    { timeout: 90000 },
  );
}

/**
 * 打开设置。设过口令时齿轮会先弹口令框，这里自动填 PASSWORD。
 * 想测「没口令时直接进」的用例传 withPassword: false。
 */
async function openSettings(page, { withPassword = true } = {}) {
  await page.locator('.app__gear').click();
  // 可能先出现口令框
  const dialog = page.locator('.lockdialog');
  if (await dialog.count() > 0) {
    if (!withPassword) {
      // 交给调用方自己处理
      return;
    }
    await page.locator('.lockdialog input[type="password"]').fill(PASSWORD);
    await page.locator('.lockdialog button[type="submit"]').click();
    await page.waitForTimeout(1200);
  }
  await page.waitForSelector('.settings__tabs', { timeout: 15000 });
}

async function closeSettings(page) {
  await page.locator('.modal__close').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
}

async function isLocked(page) {
  return (await page.locator('.app__lock.is-locked').count()) === 1;
}

const profile = mkdtempSync(join(tmpdir(), 'jvs-sec-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--no-sandbox'], viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ready(page);
  await page.waitForTimeout(1000);

  console.log('1. 设置按钮与面板');
  check('顶部有设置按钮', (await page.locator('.app__gear').count()) === 1);
  check('没设口令时没有锁按钮', (await page.locator('.app__lock').count()) === 0);
  await openSettings(page);
  check('没设口令时齿轮直接打开设置', (await page.locator('.settings').count()) === 1);
  check('没设口令时不弹口令框', (await page.locator('.lockdialog').count()) === 0);
  const tabs = await page.locator('.settings__tabs button').allTextContents();
  check('两个标签页 安全/数据', tabs.some((t) => t.includes('安全')) && tabs.some((t) => t.includes('数据')), tabs.join(','));

  console.log('2. 设了口令但没选模块 → 不出现锁按钮');
  const pwFields = page.locator('.settings__form input[type="password"]');
  await pwFields.nth(0).fill(PASSWORD);
  await pwFields.nth(1).fill(PASSWORD);
  check('未选模块时启用按钮禁用', await page.getByRole('button', { name: '启用应用锁' }).isDisabled());
  await closeSettings(page);
  check('未选模块时仍没有锁按钮', (await page.locator('.app__lock').count()) === 0);

  console.log('3. 只保护「笔记」→ 出现锁按钮，卡片被盖锁');
  await openSettings(page);
  await page.locator('.settings__scope .settings__grid .settings__check').filter({ hasText: '笔记' }).locator('input').check();
  const pw2 = page.locator('.settings__form input[type="password"]');
  await pw2.nth(0).fill(PASSWORD);
  await pw2.nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: '启用应用锁' }).click();
  await page.waitForTimeout(1800);
  await closeSettings(page);
  // 关闭面板后 App 会异步重读安全配置，等锁按钮真的出现再断言。
  await page.waitForSelector('.app__lock', { timeout: 15000 });
  await page.waitForTimeout(400);

  check('出现锁按钮', (await page.locator('.app__lock').count()) === 1);
  check('刚启用后处于锁定状态', await isLocked(page));

  console.log('4. 仪表盘上受保护的卡片被盖锁');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 20000 });
  await page.waitForTimeout(900);

  check('笔记卡片被盖锁', (await page.locator('.card--locked').count()) === 1);
  const lockedCard = page.locator('.card--locked');
  const cardText = await lockedCard.innerText();
  console.log('  被锁卡片 =', cardText.replace(/\n/g, ' | '));
  check('卡片上显示锁图标', (await lockedCard.locator('.card__cover-icon').innerText()) === '🔒');
  check('卡片提示点击解锁', cardText.includes('已锁定'), cardText.replace(/\n/g, ' '));
  check('卡片正文被盖住、不泄露摘要', (await lockedCard.locator('.card__body').count()) === 0);
  check('其他卡片不受影响', (await page.locator('.card:not(.card--locked)').count()) > 3);

  console.log('5. 点被锁卡片 → 弹口令框（不跳转）');
  await lockedCard.click();
  await page.waitForSelector('.lockdialog', { timeout: 15000 });
  check('点卡片弹出解锁框', (await page.locator('.lockdialog').count()) === 1);
  check('没有跳转到模块页', new URL(page.url()).hash === '', page.url());

  await page.locator('.lockdialog input[type="password"]').fill('wrong');
  await page.locator('.lockdialog button[type="submit"]').click();
  await page.waitForTimeout(1000);
  const err = await page.locator('.lockdialog .form__error').innerText().catch(() => '');
  check('错误口令被拒', err.includes('不正确'), err);
  check('对话框仍开着', (await page.locator('.lockdialog').count()) === 1);

  console.log('6. 输入正确口令 → 解锁全部模块并进入刚才点的模块');
  await page.locator('.lockdialog input[type="password"]').fill(PASSWORD);
  await page.locator('.lockdialog button[type="submit"]').click();
  await page.waitForTimeout(2000);
  check('解锁成功', !(await isLocked(page)));
  check('自动进入了笔记模块', (await page.locator('.panel').count()) > 0, page.url());
  check('笔记内容可见', (await page.locator('.lockoverlay').count()) === 0);

  // 回仪表盘：所有卡片都解锁
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 20000 });
  await page.waitForTimeout(800);
  check('解锁后卡片不再被盖锁', (await page.locator('.card--locked').count()) === 0);

  console.log('7. 解锁状态下点锁按钮 → 立刻锁上');
  await page.locator('.app__lock').click();
  await page.waitForTimeout(700);
  check('点击后立刻锁定', await isLocked(page));
  check('锁定时不弹口令框', (await page.locator('.lockdialog').count()) === 0);
  await page.waitForTimeout(500);
  check('卡片重新被盖锁', (await page.locator('.card--locked').count()) === 1);

  console.log('7b. 锁定状态下直接开深链 → 页面也有兜底锁');
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lockoverlay', { timeout: 20000 });
  check('深链页面被盖锁', (await page.locator('.lockoverlay').count()) === 1);
  check('深链里笔记内容不可见', (await page.locator('.note').count()) === 0);
  // 兜底锁上的按钮也能解锁
  await page.locator('.lockoverlay__btn').click();
  await page.waitForSelector('.lockdialog', { timeout: 15000 });
  check('兜底锁的按钮能弹口令框', (await page.locator('.lockdialog').count()) === 1);
  await page.locator('.lockdialog input[type="password"]').fill(PASSWORD);
  await page.locator('.lockdialog button[type="submit"]').click();
  await page.waitForTimeout(1800);
  check('兜底锁也能解开', (await page.locator('.lockoverlay').count()) === 0);

  console.log('7c. 解锁后刷新保持解锁');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForTimeout(1500);
  check('刷新后仍是解锁', !(await isLocked(page)));

  console.log('7e. 已解锁状态下打开设置，仍要口令');
  await page.locator('.app__gear').click();
  await page.waitForSelector('.lockdialog', { timeout: 15000 });
  check('已解锁时打开设置仍要口令', (await page.locator('.lockdialog').count()) === 1);
  const settingsHint = await page.locator('.lockdialog__hint').innerText();
  check('设置口令框有独立说明', settingsHint.includes('设置'), settingsHint);

  // 错误口令进不去
  await page.locator('.lockdialog input[type="password"]').fill('bad');
  await page.locator('.lockdialog button[type="submit"]').click();
  await page.waitForTimeout(1000);
  check('错误口令打不开设置', (await page.locator('.settings').count()) === 0);
  check('错误后仍停在口令框', (await page.locator('.lockdialog').count()) === 1);

  // 取消也进不去
  await page.locator('.lockdialog .btn:not(.btn--primary)').click();
  await page.waitForTimeout(600);
  check('取消后设置没打开', (await page.locator('.settings').count()) === 0);

  // 正确口令进得去
  await page.locator('.app__gear').click();
  await page.waitForSelector('.lockdialog', { timeout: 15000 });
  await page.locator('.lockdialog input[type="password"]').fill(PASSWORD);
  await page.locator('.lockdialog button[type="submit"]').click();
  await page.waitForSelector('.settings__tabs', { timeout: 15000 });
  check('正确口令能打开设置', (await page.locator('.settings').count()) === 1);
  await closeSettings(page);

  console.log('7d. 「全部模块」也能锁');
  await openSettings(page);
  await page.locator('.settings__scope .settings__check').first().check();
  await page.getByRole('button', { name: '保存范围' }).click();
  await page.waitForTimeout(1500);
  await closeSettings(page);
  await page.locator('.app__lock').click();
  await page.waitForTimeout(800);
  check('全部保护时按钮可锁定', await isLocked(page));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 20000 });
  await page.waitForTimeout(900);
  const totalCards = await page.locator('.card').count();
  check('全部保护时所有卡片都被盖锁', (await page.locator('.card--locked').count()) === totalCards, `${await page.locator('.card--locked').count()}/${totalCards}`);

  // 解回去，只保护笔记
  await page.locator('.app__lock').click();
  await page.waitForSelector('.lockdialog', { timeout: 15000 });
  await page.locator('.lockdialog input[type="password"]').fill(PASSWORD);
  await page.locator('.lockdialog button[type="submit"]').click();
  await page.waitForTimeout(1600);
  await openSettings(page);
  await page.locator('.settings__scope .settings__check').first().uncheck();
  await page.waitForTimeout(300);
  await page.locator('.settings__scope .settings__grid .settings__check').filter({ hasText: '笔记' }).locator('input').check();
  await page.getByRole('button', { name: '保存范围' }).click();
  await page.waitForTimeout(1300);
  await closeSettings(page);

  console.log('8. 导出备份');
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.locator('textarea').first().fill('# 备份测试笔记\n\n这条用于验证导入。');
  await page.locator('button:has-text("保存")').first().click();
  await page.waitForSelector('.note', { timeout: 20000 });
  await page.waitForTimeout(900);

  await openSettings(page);
  await page.getByRole('tab', { name: /数据/ }).click();
  await page.waitForTimeout(700);
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: /导出全部数据/ }).click();
  const download = await downloadPromise;
  await download.saveAs(backupPath);
  const backupText = readFileSync(backupPath, 'utf8');
  console.log(`  备份大小: ${Math.round(backupText.length / 1024)} KB`);
  check('导出得到备份文件', existsSync(backupPath) && backupText.length > 100);

  const envelope = JSON.parse(backupText);
  check('备份格式标识正确', envelope.format === 'jvs-backup', String(envelope.format));
  check('备份带口令指纹', envelope.password !== null, JSON.stringify(envelope.password));
  check('备份含笔记', (envelope.counts.note ?? 0) >= 1, String(envelope.counts.note));
  check('备份包含 word_entry 表', Array.isArray(envelope.tables.word_entry), String(envelope.counts.word_entry));
  check('备份不含天气缓存', envelope.tables.weather_cache === undefined);

  console.log('9. 导入非法文件被拒');
  writeFileSync(badPath, JSON.stringify({ hello: 'world' }), 'utf8');
  await page.locator('.settings__filebtn input[type="file"]').setInputFiles(badPath);
  await page.waitForTimeout(1300);
  const badErr = await page.locator('.settings__pane .form__error').innerText().catch(() => '');
  check('非法文件被拒绝', badErr.includes('不是 JVS 的备份') || badErr.includes('备份文件不合法'), badErr);
  check('被拒后没有导入按钮', (await page.locator('.settings__preview').count()) === 0);

  console.log('10. 导入合法备份');
  await page.locator('.settings__filebtn input[type="file"]').setInputFiles(backupPath);
  await page.waitForTimeout(1600);
  check('出现导入预览', (await page.locator('.settings__preview').count()) === 1);
  const previewHead = await page.locator('.settings__preview-head').innerText();
  check('预览显示校验通过', previewHead.includes('校验通过'), previewHead);
  check('预览显示总行数', /\d+ 行数据/.test(previewHead), previewHead);
  const dangerText = await page.locator('.settings__danger').innerText();
  check('警告会永久删除本机数据', dangerText.includes('永久删除'), dangerText);
  check('要求先输口令', (await page.locator('.settings__preview input[type="password"]').count()) === 1);

  const importBtn = page.getByRole('button', { name: /清空本机数据并导入/ });
  check('口令为空时导入按钮禁用', await importBtn.isDisabled());

  await page.locator('.settings__preview input[type="password"]').fill('nope');
  await page.waitForTimeout(200);
  await importBtn.click();
  await page.waitForTimeout(1600);
  const pwdErr = await page.locator('.settings__pane .form__error').innerText().catch(() => '');
  check('错误口令无法导入', pwdErr.includes('口令不正确'), pwdErr);

  await page.locator('.settings__preview input[type="password"]').fill(PASSWORD);
  await page.waitForTimeout(200);
  await importBtn.click();
  await page.waitForTimeout(4500);

  await ready(page);
  await page.waitForTimeout(1800);
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  if (await page.locator('.app__lock.is-locked').count() > 0) {
    await page.locator('.app__lock').click();
    await page.waitForSelector('.lockdialog', { timeout: 15000 });
    await page.locator('.lockdialog input[type="password"]').fill(PASSWORD);
    await page.locator('.lockdialog button[type="submit"]').click();
    await page.waitForTimeout(1600);
  }
  const noteText = await page.locator('.note').first().innerText().catch(() => '');
  console.log('  导入后的笔记 =', noteText.replace(/\n/g, ' | ').slice(0, 70));
  check('导入后数据还在', noteText.includes('备份测试笔记'), noteText.replace(/\n/g, ' ').slice(0, 50));

  console.log('11. 关闭应用锁 → 锁按钮消失');
  await openSettings(page);
  await page.waitForTimeout(500);
  await page.getByRole('tab', { name: /安全/ }).click();
  await page.waitForTimeout(800);
  await page.locator('.settings__form input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: '关闭应用锁' }).click();
  await page.waitForTimeout(1900);
  const offText = await page.locator('.settings__ok').first().innerText().catch(() => '');
  check('可以关闭应用锁', offText.includes('已关闭'), offText);
  await closeSettings(page);
  await page.waitForTimeout(900);
  check('关闭后锁按钮消失', (await page.locator('.app__lock').count()) === 0);

  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('关闭后模块不再被锁', (await page.locator('.lockoverlay').count()) === 0);
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
