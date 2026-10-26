/**
 * 把词光媒体服务部署到阿里云服务器。
 *
 * 做四件事：
 *   1. 上传 wa-media-server.cjs
 *   2. 停掉旧进程、启动新进程
 *   3. 用 crontab @reboot 让它开机自启（不需要 sudo）
 *   4. 从本机验证媒体能取到
 *
 * 用法：
 *   node scripts/deploy-media-server.mjs
 *   WA_SSH_HOST=user@media.example.com WA_PORT=8090 node scripts/deploy-media-server.mjs
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_FILE = join(HERE, 'wa-media-server.cjs');

/** 默认目标。 */
const HOST = process.env.WA_SSH_HOST;
if (!HOST || !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(HOST)) throw new Error('请设置有效的 WA_SSH_HOST（user@host）');
const PORT = Number(process.env.WA_PORT ?? 8090);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('WA_PORT 必须为 1–65535');
/** 服务器上的安装位置（目标用户需有写权限）。 */
const REMOTE_BIN = '/srv/jvs/wa-media-server.cjs';
const REMOTE_LOG = '/srv/jvs/wa-media.log';

/**
 * 在服务器上执行一段 bash。
 *
 * 注意：必须把 CRLF 转成 LF，否则 bash 会因行尾 `\r` 报奇怪的错。
 *
 * @param script - bash 脚本。
 * @returns 命令输出。
 */
function remote(script) {
  const cleaned = script.replace(/\r/g, '');
  return execFileSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, 'bash -s'],
    { input: cleaned, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

/**
 * 从本机验证一个媒体 URL 是否可用。
 *
 * @param url - 完整 URL。
 * @returns 状态描述。
 */
async function probe(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const type = response.headers.get('content-type') ?? '';
    const cors = response.headers.get('access-control-allow-origin') ?? '(无)';
    return { ok: response.ok && type.startsWith('image/'), status: response.status, type, cors };
  } catch (error) {
    return { ok: false, status: 0, type: String(error), cors: '(无)' };
  }
}

async function main() {
  console.log('1. 检查服务器空间');
  const disk = remote("df -B1 / | tail -1 | awk '{print $4}'").trim();
  const availMb = Math.round(Number(disk) / 1024 / 1024);
  console.log(`   可用空间: ${availMb} MB`);
  if (Number(disk) < 1024 * 1024) {
    console.error('   ✗ 空间不足 1 MB，无法写入服务脚本。先腾出空间再跑这个脚本。');
    process.exitCode = 1;
    return;
  }

  console.log('2. 上传服务脚本');
  const source = readFileSync(SERVER_FILE, 'utf8');
  remote(`cat > ${REMOTE_BIN} <<'WAEOF'\n${source}\nWAEOF\nchmod +x ${REMOTE_BIN}`);
  const size = remote(`stat -c %s ${REMOTE_BIN}`).trim();
  console.log(`   已上传: ${REMOTE_BIN} (${size} 字节)`);
  if (Number(size) < 1000) {
    console.error('   ✗ 上传不完整（文件太小），检查磁盘空间。');
    process.exitCode = 1;
    return;
  }

  console.log('3. 启动服务');
  const startLog = remote(`
    pkill -f wa-media-server 2>/dev/null
    sleep 1
    nohup env PORT=${PORT} node ${REMOTE_BIN} > ${REMOTE_LOG} 2>&1 &
    sleep 2
    ss -tln | grep -c ':${PORT} ' || true
  `).trim();
  const listening = Number(startLog.split('\n').pop() ?? 0) > 0;
  console.log(`   端口 ${PORT} 监听: ${listening ? '是' : '否'}`);
  if (!listening) {
    console.error('   ✗ 没起来，查看日志：');
    console.error(remote(`tail -20 ${REMOTE_LOG} 2>/dev/null || echo '(无日志)'`));
    process.exitCode = 1;
    return;
  }

  console.log('4. 设置开机自启（crontab @reboot）');
  const cronLine = `@reboot sleep 20 && env PORT=${PORT} node ${REMOTE_BIN} > ${REMOTE_LOG} 2>&1`;
  remote(`
    crontab -l 2>/dev/null | grep -v 'wa-media-server' > /tmp/wa-cron.txt || true
    echo '${cronLine}' >> /tmp/wa-cron.txt
    crontab /tmp/wa-cron.txt
    rm -f /tmp/wa-cron.txt
  `);
  const crontab = remote('crontab -l 2>/dev/null | grep wa-media-server || echo "(未设置)"').trim();
  console.log(`   ${crontab}`);

  console.log('5. 从本机验证');
  const publicBase = `http://${HOST.split('@').pop()}:${PORT}`;
  const img = await probe(`${publicBase}/atlas/img/abandon.webp`);
  console.log(`   图片: ${img.status}  type=${img.type}  CORS=${img.cors}`);
  const audio = await probe(`${publicBase}/atlas/audio/uk/abandon.mp3`);
  console.log(`   音频: ${audio.status}  type=${audio.type}`);

  if (img.ok) {
    console.log('');
    console.log(`✓ 部署完成。JVS 里把媒体地址填成：${publicBase}`);
  } else {
    console.error('');
    console.error('✗ 服务起来了但从外部取不到 —— 可能是阿里云安全组没放行该端口，或主机有防火墙。');
    process.exitCode = 1;
  }
}

void main();
