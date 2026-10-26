/**
 * 媒体服务端验证。
 *
 * 测的是 scripts/wa-media-server.cjs —— 部署到阿里云上那个提供插画和音频的
 * 静态服务。用本机的 word-atlas 目录当媒体根起一个临时实例，验证：
 *   - 正确的 MIME（.webp 必须 image/webp，否则浏览器可能不渲染）
 *   - CORS 头（前端用 fetch 取 Blob，没有它会失败）
 *   - Range 请求（<audio> 拖动进度需要）
 *   - 只暴露 atlas 子目录，目录穿越被拦
 *
 * 如果本机没有 word-atlas 目录，测试会跳过（这不是失败）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8099;
const ROOT = process.env.WA_ROOT ?? '../word-atlas/public';
const BASE = `http://127.0.0.1:${PORT}`;

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

if (!existsSync(ROOT)) {
  console.log(`跳过：本机没有词库目录 ${ROOT}`);
  console.log('（设置 WA_ROOT 指向 word-atlas 的 public 目录即可运行）');
  process.exit(0);
}

const server = spawn(process.execPath, [join(HERE, 'wa-media-server.cjs')], {
  env: { ...process.env, PORT: String(PORT), WA_ROOT: ROOT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (data) => process.stderr.write(`  [server] ${data}`));

/** 等服务起来。 */
async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${BASE}/atlas/img/abandon.webp`, { method: 'HEAD' });
      if (response.ok) return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

try {
  const ready = await waitReady();
  if (!ready) {
    console.error('媒体服务没能启动');
    process.exitCode = 1;
  } else {
    console.log('1. 文件与 MIME');
    const img = await fetch(`${BASE}/atlas/img/abandon.webp`);
    check('图片 200', img.status === 200, String(img.status));
    check('webp 的 MIME 正确', img.headers.get('content-type') === 'image/webp',
      img.headers.get('content-type'));
    check('带 CORS 头', img.headers.get('access-control-allow-origin') === '*',
      img.headers.get('access-control-allow-origin'));
    check('声明支持 Range', img.headers.get('accept-ranges') === 'bytes');
    check('图片有实际字节', (await img.arrayBuffer()).byteLength > 1000);

    const audio = await fetch(`${BASE}/atlas/audio/uk/abandon.mp3`);
    check('音频 200', audio.status === 200);
    check('mp3 的 MIME 正确', audio.headers.get('content-type') === 'audio/mpeg',
      audio.headers.get('content-type'));

    const entries = await fetch(`${BASE}/atlas/entries/0.json`);
    check('词条分片 200', entries.status === 200);
    check('JSON 的 MIME 正确',
      (entries.headers.get('content-type') ?? '').startsWith('application/json'),
      entries.headers.get('content-type'));

    console.log('2. Range 请求');
    const range = await fetch(`${BASE}/atlas/audio/uk/abandon.mp3`, { headers: { Range: 'bytes=0-99' } });
    check('Range 返回 206', range.status === 206, String(range.status));
    check('Content-Range 正确', (range.headers.get('content-range') ?? '').startsWith('bytes 0-99/'),
      range.headers.get('content-range'));
    check('只返回请求的 100 字节', (await range.arrayBuffer()).byteLength === 100);

    console.log('3. 预检与安全');
    const preflight = await fetch(`${BASE}/atlas/img/abandon.webp`, { method: 'OPTIONS' });
    check('OPTIONS 预检返回 204', preflight.status === 204, String(preflight.status));
    check('仓库根文件不可访问', (await fetch(`${BASE}/README.md`)).status === 404);
    check('目录穿越被拦', (await fetch(`${BASE}/atlas/../../README.md`)).status === 404);
    check('源码目录不可访问', (await fetch(`${BASE}/../src/main.tsx`)).status === 404);
    check('缺失文件 404', (await fetch(`${BASE}/atlas/img/nonexistent-xyz.webp`)).status === 404);
    check('损坏的 URL 编码返回 404', (await fetch(`${BASE}/atlas/img/%ZZ`)).status === 404);
    check('损坏请求后服务仍可用', (await fetch(`${BASE}/atlas/img/abandon.webp`)).status === 200);
  }
} finally {
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
