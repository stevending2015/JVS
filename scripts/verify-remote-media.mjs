/**
 * 验证阿里云上的媒体服务。
 *
 * 抽查多个词的图片 / 音频 / 词条，确认：
 *   - 各种文件都能取到（不是只对 abandon 有效）
 *   - MIME 和 CORS 正确
 *   - Range 请求可用
 *   - 不暴露仓库其它内容
 */
const BASE = process.env.WA_BASE;
if (!BASE) throw new Error('请设置 WA_BASE');

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

async function head(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return {
      ok: response.ok,
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      cors: response.headers.get('access-control-allow-origin') ?? '',
      ranges: response.headers.get('accept-ranges') ?? '',
      length: Number(response.headers.get('content-length') ?? 0),
    };
  } catch (error) {
    return { ok: false, status: 0, type: String(error), cors: '', ranges: '', length: 0 };
  }
}

console.log(`目标: ${BASE}\n`);

console.log('1. 抽查多个词的插画');
const words = ['abandon', 'library', 'volcano', 'orchestra', 'magnificent', 'benzene', 'turbot'];
for (const word of words) {
  const result = await head(`${BASE}/atlas/img/${word}.webp`);
  check(`${word}.webp`, result.ok && result.type === 'image/webp' && result.length > 5000,
    `${result.status} ${result.type} ${result.length}B`);
}

console.log('2. 抽查音频（英音 / 美音 / 例句）');
for (const kind of ['uk', 'us', 'ex']) {
  const result = await head(`${BASE}/atlas/audio/${kind}/library.mp3`);
  check(`${kind} 音频`, result.ok && result.type === 'audio/mpeg' && result.length > 1000,
    `${result.status} ${result.type} ${result.length}B`);
}

console.log('3. 词条与缩略图');
const entries = await head(`${BASE}/atlas/entries/0.json`);
check('词条分片', entries.ok && entries.type.startsWith('application/json'), `${entries.status} ${entries.type}`);
const thumb = await head(`${BASE}/atlas/thumb/abandon.webp`);
check('缩略图', thumb.ok && thumb.type === 'image/webp', `${thumb.status} ${thumb.type}`);

console.log('4. CORS 与 Range');
const img = await head(`${BASE}/atlas/img/abandon.webp`);
check('CORS 头为 *', img.cors === '*', img.cors);
check('声明 Accept-Ranges', img.ranges === 'bytes', img.ranges);

const range = await fetch(`${BASE}/atlas/audio/uk/abandon.mp3`, { headers: { Range: 'bytes=1000-1999' } });
check('Range 返回 206', range.status === 206, String(range.status));
check('Content-Range 正确', (range.headers.get('content-range') ?? '').startsWith('bytes 1000-1999/'),
  range.headers.get('content-range'));
check('返回 1000 字节', (await range.arrayBuffer()).byteLength === 1000);

console.log('5. 安全：不暴露仓库其它内容');
check('仓库 README 不可访问', (await head(`${BASE}/README.md`)).status === 404);
check('源码不可访问', (await head(`${BASE}/src/main.tsx`)).status === 404);
check('package.json 不可访问', (await head(`${BASE}/package.json`)).status === 404);
check('目录列表不可访问', (await head(`${BASE}/atlas/`)).status === 404);
check('目录穿越被拦', (await head(`${BASE}/atlas/../../etc/passwd`)).status === 404);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
