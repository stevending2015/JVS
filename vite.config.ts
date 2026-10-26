import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { join, resolve, extname, isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The SQLite worker needs a module worker, and OPFS persistence wants a stable
 * origin. COOP/COEP are opt-in via env so the app itself works without them;
 * enable with CROSS_ORIGIN_ISOLATION=1 if a VFS variant requires SharedArrayBuffer.
 */
const crossOriginIsolated = process.env.CROSS_ORIGIN_ISOLATION === '1';

/** 词光 atlas 的媒体目录；用环境变量可以指到别处。 */
const WORD_MEDIA_ROOT = resolve(process.env.JVS_WORD_MEDIA ?? '../word-atlas/public/atlas');

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
};

/**
 * 开发期直接从 word-atlas 目录提供词光媒体，避免复制 551 MB。
 *
 * 生产构建不会用到它 —— 生产环境的媒体应由静态托管或 CDN 提供（见
 * src/core/word/media.ts 的 HttpMediaSource）。这里只是一个不复制文件的
 * 本地挂载点，顺便支持 Range 请求，让 <audio> 能拖动进度。
 */
function wordMedia(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const route = (req.url ?? '').split('?')[0] ?? '';
    if (!route.startsWith('/word-media/')) {
      next();
      return;
    }
    const relative = decodeURIComponent(route.slice('/word-media/'.length));
    const file = resolve(join(WORD_MEDIA_ROOT, relative));
    // 目录穿越防护：解析后必须仍在媒体根目录内。
    if (!file.startsWith(WORD_MEDIA_ROOT) || isAbsolute(relative) || relative.includes('..')) {
      res.statusCode = 403;
      res.end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const size = statSync(file).size;
    res.setHeader('Content-Type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    // 媒体内容不会变，开发期也让浏览器缓存一会儿，别每次刷新都重下。
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const range = req.headers.range;
    if (typeof range === 'string') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match === null ? -1 : Number(match[1]);
      const end = match === null || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
      if (start < 0 || start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', size);
    createReadStream(file).pipe(res);
  };

  return {
    name: 'jvs-word-media',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), wordMedia()],
  server: {
    port: 5173,
    strictPort: true,
    headers: crossOriginIsolated
      ? {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        }
      : {},
    watch: {
      /**
       * `.verify/` holds test artifacts: screenshots, and sometimes a temporary
       * Chrome profile. The browser keeps its own profile files locked, so
       * watching them made the dev server log a stream of
       * "EBUSY: resource busy or locked". Nothing in there is imported by the app,
       * so it is excluded; `dist` is build output and equally uninteresting.
       */
      ignored: ['**/.verify/**', '**/dist/**'],
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: crossOriginIsolated
      ? {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        }
      : {},
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
