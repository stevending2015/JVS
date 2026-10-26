# 词光 atlas 媒体部署

公开仓库不包含个人服务器信息。图片和音频需要自行托管，词条来源与许可见 public/word-data/manifest.json。

## 本地

将 word-atlas 放在项目同级目录，或设置 JVS_WORD_MEDIA 指向其 public/atlas。运行 pnpm dev 或 pnpm preview 后通过 /word-media 提供媒体。
运行 pnpm build:word 可从同级 word-atlas 重新生成开放词库。

## 远端

在「词光 atlas → 统计 → 媒体源」填自己的 HTTPS 媒体地址。留空或 local 默认使用本地 /word-media，不会连接预设私人服务器。

服务程序：scripts/wa-media-server.cjs。WA_ROOT 设置媒体根目录（包含 atlas 子目录），PORT 设置监听端口，默认 8090。
SSH 部署程序：scripts/deploy-media-server.mjs。必须显式设置 WA_SSH_HOST（user@host），可设置 WA_PORT。安装位置为 /srv/jvs，目标 SSH 用户需有写权限，需预先创建该目录。通过环境变量配置，不支持 --host/--port 参数。

部署会替换同名媒体进程及对应 crontab 启动项；使用前检查目标环境。服务只提供 atlas 媒体目录，支持 CORS 和 Range；生产环境需自行配置 HTTPS。

## 验证

pnpm verify:media-server 使用 WA_ROOT 或同级 word-atlas/public；缺少素材时跳过。
pnpm verify:remote-media 和 pnpm verify:remote-browser 必须设置 WA_BASE 为自己的媒体服务 URL；浏览器验证需先运行 pnpm preview，并在应用中配置相同媒体源。
