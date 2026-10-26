/**
 * 词光 atlas 媒体静态服务。
 *
 * 自行部署，使用 WA_ROOT 配置开放词库媒体目录。
 *
 * 为什么不用 nginx / python -m http.server：
 *  - 这台机器上没有 nginx，sudo 又要密码，装不了；
 *  - python 的 http.server 不认 .webp 的 MIME，也不带 CORS 头，前端 fetch 会失败。
 *
 * 这个文件只用 Node 内置模块，没有依赖，放在 /srv/jvs/wa-media-server.cjs。
 *
 * 用法：
 *   node wa-media-server.cjs            # 前台
 *   nohup node wa-media-server.cjs &    # 后台
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/** 媒体根目录；可用环境变量覆盖，便于本地测试。 */
const ROOT = process.env.WA_ROOT ?? '/srv/jvs/word-atlas/public';
/** 监听端口；默认 8090；部署时自行配置防火墙。 */
const PORT = Number(process.env.PORT ?? 8090);
/** 只监听这些子目录，避免把整个仓库暴露出去。 */
const ALLOWED_PREFIXES = ['atlas/img/', 'atlas/thumb/', 'atlas/audio/', 'atlas/entries/', 'atlas/index.json'];

/** 扩展名到 MIME。 */
const MIME = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 把 URL 路径解析成磁盘路径，同时做目录穿越防护。
 *
 * @param urlPath - 请求路径，例如 /atlas/img/abandon.webp
 * @returns 绝对路径；越权或不存在的形式返回 null。
 */
function resolveFile(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0] ?? ''); } catch { return null; }
  const clean = decoded.replace(/^\/+/, '');
  if (clean === '' || clean.includes('..')) return null;
  if (!ALLOWED_PREFIXES.some((prefix) => clean.startsWith(prefix) || clean === prefix.replace(/\/$/, ''))) {
    return null;
  }
  const full = path.resolve(ROOT, clean);
  // 再确认一次解析结果仍在根目录内。
  if (!full.startsWith(path.resolve(ROOT))) return null;
  return full;
}

const server = http.createServer((req, res) => {
  // CORS：前端从任意源 fetch 都要能拿到字节。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  // 音频拖动进度需要。
  res.setHeader('Accept-Ranges', 'bytes');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  const file = resolveFile(req.url ?? '');
  if (file === null) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    // 媒体内容不会变，让浏览器与中间缓存都可以长期保存。
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');

    // Range 请求：<audio> 拖动进度会用到。
    const range = req.headers.range;
    if (typeof range === 'string') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match === null ? -1 : Number(match[1]);
      const end = match === null || match[2] === '' ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1);
      if (start < 0 || start > end || start >= stat.size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`词光媒体服务已启动: http://0.0.0.0:${PORT}/  (root=${ROOT})`);
});
