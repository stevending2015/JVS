# 词光 atlas 媒体部署

公开仓库不包含个人服务器信息。图片和音频需要自行托管，词条来源与许可见 public/word-data/manifest.json。

## 本地

JVS 已包含词条文本，图片和发音音频需要从上游 [词光 word-atlas 仓库](https://github.com/designfuchen/word-atlas) 获取。只运行生日卡、家族树、笔记、倒计时等模块时，无需下载这些素材。

在 JVS 目录中执行，将上游仓库克隆到同级目录：

```bash
git clone --depth 1 https://github.com/designfuchen/word-atlas.git ../word-atlas
pnpm install
pnpm dev
```

目录应为：

```text
workspace/
  JVS/
  word-atlas/
    public/atlas/
      img/
      audio/
      entries/
```

JVS 的开发和预览服务会从同级 `word-atlas/public/atlas` 提供 `/word-media`。在「词光 atlas → 统计 → 媒体源」留空或填 `local` 即可，不需要额外指定远端服务器。素材较大，下载后可检查 `img/abandon.webp` 和 `audio/uk/abandon.mp3` 是否存在。

如资源放在其他位置，可先设置 `JVS_WORD_MEDIA`，例如 PowerShell：

```powershell
$env:JVS_WORD_MEDIA = 'E:/resources/word-atlas/public/atlas'
pnpm dev
```

JVS 已带有词条文本，不需要重复生成；需要更新词库时，才运行 `pnpm build:word`（默认读取同级 word-atlas），或 `node scripts/build-word-data.mjs <word-atlas目录>`。

上游图片和录音按 CC BY 4.0 提供；再分发时请保留上游来源与许可署名，具体以其 [内容许可](https://github.com/designfuchen/word-atlas/blob/main/CONTENT_LICENSE.md) 为准。

## 远端

在「词光 atlas → 统计 → 媒体源」填自己的 HTTPS 媒体地址。留空或 local 默认使用本地 /word-media，不会连接预设私人服务器。

部署生产网站时，`pnpm build` 不会将同级词光素材打包进 `dist`，Vite 本地媒体中间件也不会随静态网站部署。需要把上面下载的 `public/atlas` 素材另行放到静态服务器或 CDN，支持跨域访问，并在应用中填写对应媒体源。普通使用者若已有部署者提供的媒体地址，直接填写即可，无需自行克隆仓库。

服务程序：scripts/wa-media-server.cjs。WA_ROOT 设置媒体根目录（包含 atlas 子目录），PORT 设置监听端口，默认 8090。
SSH 部署程序：scripts/deploy-media-server.mjs。必须显式设置 WA_SSH_HOST（user@host），可设置 WA_PORT。安装位置为 /srv/jvs，目标 SSH 用户需有写权限，需预先创建该目录。通过环境变量配置，不支持 --host/--port 参数。

部署会替换同名媒体进程及对应 crontab 启动项；使用前检查目标环境。服务只提供 atlas 媒体目录，支持 CORS 和 Range；生产环境需自行配置 HTTPS。

## 验证

pnpm verify:media-server 使用 WA_ROOT 或同级 word-atlas/public；缺少素材时跳过。
pnpm verify:remote-media 和 pnpm verify:remote-browser 必须设置 WA_BASE 为自己的媒体服务 URL；浏览器验证需先运行 pnpm preview，并在应用中配置相同媒体源。
