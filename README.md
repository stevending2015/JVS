# JVS — 一体化个人生活应用（骨架）

仪表盘为第一菜单，功能以「模块」形式注册：天气、万年历、生日卡、倒计时、目标、专注、笔记、家族树、词光 atlas。
数据存放在**浏览器内真实的 SQLite 数据库**（OPFS 持久化），离线可用，PWA 跨平台。

> **环境声**：顶部右上角 🎧 可开七段背景音（星空音乐 / 雨天图书馆 / 清晨海岸 / 林间早晨 / 夜晚壁炉 / 远航船舱 / 安静咖啡馆）+ 音量调节。素材移植自 word-atlas（MIT），随应用离线可用；选择与音量存在设置表里，下次打开接着放（浏览器要求先有一次点击/按键才出声）。

## 已实现（可点可用）

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 🎂 生日卡 | 可用（含「本人」标记：族谱以此人为中心；无生日的家人单独归入「未填生日」区可随时补录；**已是族谱成员的人不能在此删除**，会被拦下并引导去家族树选择移除范围；关系选「配偶/爸爸/妈妈/儿子/女儿」时保存后**自动与本人建立族谱关系链**） | 写入 `person` 表；自动推导公历锚点、星座、生肖；倒计时与「满 N 岁」；**弹窗输入**（添加与编辑共用，Esc/点遮罩/取消关闭）；**编辑按钮**（原地更新并重算派生值）；**搜索框**与**按月分组**（按下一次生日所在月份，跨年仍按时间顺序）；出生时区为下拉列表，默认北京/上海且**记住上次选择** |
| 📅 万年历 | 可用 | 农历、节气、干支、节日、宜忌；**亲友生日直接标记在对应日期**；**卡片同时显示阳历月日与星期**（排在农历之后、字号更小） |
| ⏳ 倒计时 | 可用 | **弹窗输入**，目标日期与剩余天数；**到期持续响铃**（目标日当天开始响；用 Web Audio 现场合成「哔—哔」双响电话铃声，不带音频资源；响到点「知道了」为止，多项同时到期只叠一个铃声循环；开关与音量存在设置表里；浏览器要求先有一次点击才能出声，未交互时显示「开启提醒」按钮兜底） |
| 🎯 目标 | 可用 | 目标倒计时：**数量型 / 结果型**目标、开始与截止倒计时、子目标（每本书一个）、打卡、**节奏计划（打卡 N 天休 M 天，前紧后松 / 均匀分布）**、进度偏差、速率预测、颜色标签、归档 / 作废、备份与恢复；**读书打卡写的内容会按 `#《书名》` + 内容 的格式自动同步到笔记模块**，并打上「读书」与书名标签（打卡目标本身也是标签，笔记里可直接看到并筛选）；旧格式打卡笔记会在进入目标页时幂等补全书名 |
| ⏱ 专注 | 可用 | 参考 masuka「专注」：**番茄钟 25/45/60/90/120 分钟 + 正计时**、专注事项、**计时由时间戳推导（刷新或关掉标签页都不丢）**、同一时间只允许一个会话、今日累计与专注记录；增强：**每日目标环、连续专注天数、35 天专注热力图、结束提示音（可关）**；**仪表盘卡片显示实时计时**（番茄钟显示剩余 mm:ss、正计时显示已过时间，运行时高亮并按秒走动） |
| 📝 笔记 | 可用 | **常驻快速输入**（Enter 保存 / Shift+Enter 换行、展开模式、自动标题）；**标签、置顶、全文搜索、按天分组分页**；**日历日期筛选**（按每天笔记数显示热力条，支持单日/区间）；**自研 Markdown 渲染**（标题/粗斜体/行内代码/代码块/**无限层级嵌套列表**/引用/表格/链接/分隔线/**任务列表复选框**，HTML 一律转义；标题按 h1–h6 分级、嵌套列表每层换符号与编号样式）；**单篇笔记导出 PDF**（**真·分页预览**：先把正文按纸张离屏量一遍高度、贪心装箱切成 N 张独立的纸，页与页之间留缝和阴影，看得到「第几页 / 共几页」和分页点落在哪里；**纸张可选 A4 / A5 / B5 / Letter**，换纸立刻重新分页；**‹ 上一页 / 下一页 › 翻页按钮**，也支持 ← → 方向键与直接滚动，滚到哪页计数就同步到哪页；打印时每页已经切好，靠 `@page{margin:0}` + 每页 `break-after:page` 一页一张吐出去，**预览的页数就是 PDF 的页数**；真文字可选中可搜索，浅色纸面，表格与代码块不跨页劈开）；**KaTeX 数学公式**（`$行内$` 与 `$$块级$$`）；**图片**（浏览器压缩到 ≤1920px WebP、每篇最多 9 张、以 BLOB 存进 SQLite、渲染为 blob URL）；**点击图片放大**（全屏灯箱：滚轮缩放、单击 1×/2.5×、放大后拖动平移、← → 在多图间切换、Esc/点背景关闭）；卡片内联编辑、删除二次确认；**导出 / 导入 Markdown**（front matter 保留标签/置顶/关联）；**笔记可关联亲友**，在族谱详情里显示「相关笔记」 |
| 🌳 家族树 | 可用 | GEDCOM 7 式「家庭单元」模型：**世系图**（婚次节点 ◇、主人重配偶轻、祖先在上后裔在下、正交连线、缩放、可切换根节点）、**多配偶**（每段婚姻独立分支，各自子女挂各自婚次，再娶自动标「继配」）、**离异**（红虚线 + 「离」，可切换复婚）、**女系开关**（默认传统不展开，可一键展开）、**世代列表**（按世次分组，**世次以根为基准：根就是第一代**，往下每一代 +1）、**根可手动指定并被记住**（重启后族谱仍以它为中心，除非手动改）、**关系详情**（按婚次添加子女）、**完整中式著录**（世次/字辈/字/号/排行/籍贯/葬处/卒/入嗣方式/婚配方式）、**以「本人」为中心自动向上（父母）向下（配偶、子女）展开**、**世次（第 N 世）按关系结构自动推算**（最早一代为 1 世，配偶同世、子女下一世，表单不再手填）；**添加亲属时可选「从已有成员中选择」**（生日模块里的人也在列表中，关联到同一个人而不是新建重复记录）、**移除成员分两种范围**（①仅移出族谱：解除父子/配偶关系，本人仍留在生日/亲友列表；②彻底删除：同时从亲友列表删除，硬删除不留副本，`VACUUM` 回收空间；两种都保留子嗣并保留另一位亲长，空家庭自动回收）、**GEDCOM 7.0 导出** |
| 📖 词光 atlas | 可用 | 移植自开源项目 <b>word-atlas</b>（CC BY 4.0）：**7,298 个雅思核心词**、每词一幅插画 + 英美发音 + 例句朗读、**FSRS 间隔复习**（四档评分 忘了/勉强/记得/很熟）、四种题型（看中文选词 / 看图选词 / 听音选词 / 拼写）、词表搜索、错词本、14 天热力图；**媒体不进数据库**，只缓存当前学习的这一组（20–30 词，约 2 MB），换组即换缓存；**与笔记 / 读书目标 / 倒计时联动**（笔记一键提取生词成词集、复习计划一键加入倒计时）；**媒体源可在 ⚙ 设置 → 媒体 里配置**（模块内「统计 → 媒体源」同处可改），部署见 [docs/word-media-deploy.md](docs/word-media-deploy.md)  |
| 🌤 天气 | 可用 | 移植自 `cyweather` 桌面应用：Open-Meteo（免密钥）实时 + 7 天预报；**八种天气状态各自成景**（晴朗 / 局部多云 / 阴天 / 雾 / 毛毛雨 / 雨 / 雪 / 雷暴）：按类别定制的天空渐变、**由真实云量驱动的云层**（云朵数量、大小、颜色随云量变化，阴雨为连续云盖）、太阳/月亮按云量与天气**被遮挡或虚化**、阴雨用深色纱幕、雾用强模糊、毛毛雨比雨更细更慢、雪 50 / 雨 70 粒子、夜间星空随云量减少、雷暴闪烁；**晴朗不再有雾霾感**（天空为真蓝色，文字遮罩强度随云量自适应）；真实月相与地平坐标定位；**真实月相与真实天象位置**（日月相位角算盈亏形状与亮面朝向，南半球自动镜像；太阳/月亮位置按地平坐标「高度角+方位角」实时计算，而非沿时间弧线摆放——**月亮在地平线下就不绘制**，并注明「月亮未升起」；城市标签带国家名，避免「约克」被解析成美国城市时看不出来）；**读数区带羽化毛边与反向光晕**，太阳/月亮低垂时压在文字后也保持可读（白天浅色羽化配深色字、夜间深色羽化配浅色字）；**默认城市只有一个 = 本机时区所在城市**；搜索到的城市临时显示，按城市按钮**左上角的 📌 图钉**可钉住（下次启动仍在，可再点图钉取消），钉住的城市与时区城市一起显示；**支持国外主要城市**（中文名可用：纽约/伦敦/东京/巴黎/悉尼/迪拜…，内置 100+ 中文→英文别名；按输入语言分流检索，并按人口择优，避免「New York」解析成内布拉斯加约克、「伦敦」解析成加拿大伦敦）；15 分钟自动刷新；**结果缓存进 SQLite，离线可看且标注缓存时间** |

## 架构

```
src/
  core/
    calendar/     历法引擎（四历法 + Gregorian hub + 降级），零 Node 依赖
    birthday/     万年历与生肖/星座/五行服务（从 DSH 插件移植）
    db/           SQLite：Worker + OPFS-SAH Pool、RPC 代理、schema
    module/       模块注册表：仪表盘据此渲染功能卡
    person/       person 数据模型与仓储（及下一次生日计算）
    store.tsx     全局数据上下文
  modules/        每个功能一个目录，自己声明仪表盘卡片与页面
  app/            外壳、仪表盘、样式
```

**核心决定：只有一张 `person` 表。** 生日卡是它的视图，家族树是 `person + relation`
的视图。这样 50 个人也只有一份数据，改一处全处一致。

**模块扩展方式**：新增一个 `modules/<name>/` 并 `registerModule(...)`，仪表盘自动多一张卡，
外壳与注册表都不用改。

**设置面板**（右上角 ⚙）分三个标签页，按性质分开：

| 标签页 | 内容 |
| --- | --- |
| 🔒 安全 | 应用锁：口令、哪些模块受保护、空闲自动上锁时长 |
| 💾 数据 | 备份导出 / 导入、存盘校验 |
| 🖼 媒体 | **词光 atlas 的媒体源地址**（插画和音频从哪取）+ **倒计时到期响铃的开关与音量** |

「媒体」这一页放的都是「声音/资源从哪来」这类设置 —— 媒体源以前只藏在词光 atlas
统计页的最底部，响铃开关只做在倒计时页最底部，两个都找不到。现在都在 ⚙ 里一级可达。

## 运行

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # 类型检查 + 生产构建
pnpm preview    # 预览构建产物 http://localhost:4173
pnpm verify     # 真实 Chrome 验证（需先启动 preview）
```

## 验证结果（真实 Chrome，非模拟）

`pnpm verify` 会启动两次浏览器（同一持久化 profile），共 11 项断言，全部通过：

```
PASS  UI thread reports SQLite ready
PASS  dashboard renders one card per module
PASS  record written through the UI
PASS  derived values computed (星座/生肖)
PASS  almanac grid rendered
PASS  birthday marked on the grid
PASS  day detail shows 农历 and 宜忌
A. 首次访问
PASS  UI thread reports SQLite ready
PASS  dashboard renders one card per module
PASS  timezone is a select
PASS  timezone defaults to Asia/Shanghai on a fresh database
PASS  year/month/day sit on one row
PASS  record written through the UI
PASS  derived values computed (星座/生肖)
PASS  edit renames the record in place
PASS  edit did not duplicate the record
PASS  list is grouped by month
PASS  month group header shows year and month
PASS  search narrows the list to one record
PASS  clearing search restores every record
PASS  chosen timezone becomes the new form default
PASS  birthday marked on the grid
PASS  day detail shows 农历 and 宜忌
PASS  almanac shows the edited name
B. 关闭浏览器后重新打开
PASS  edited record survived a full browser restart
PASS  records still listed after restart
PASS  timezone preference survived a full browser restart
PASS  very early return: month grouping still renders
PASS  no failing network requests
PASS  no console/page errors
```

共 55 项。另有笔记 34 项（`pnpm verify:notes`）、Markdown 渲染 37 项（`pnpm verify:markdown`）、笔记打印导出 19 项（`pnpm verify:print`）、目标 75 项（`pnpm verify:goal`）、专注 23 项（`pnpm verify:focus`）、界面打磨 30 项（`pnpm verify:ui`）、设置与存盘 57 项（`pnpm verify:settings`）、空闲自动上锁 15 项（`pnpm verify:autolock`）、天气与城市解析 39 项（`pnpm verify:weather`）、钉住城市 22 项（`pnpm verify:pinned`）、族谱 70 项（`pnpm verify:family`）、移除范围 24 项（`pnpm verify:purge`）、月相 45 项（`pnpm verify:moon`）、双标签页 9 项（`pnpm verify:tabs`）、数据库迁移 18 项（`pnpm verify:migration`）、词光 atlas 54 项（`pnpm verify:atlas`）、媒体服务端 17 项（`pnpm verify:media-server`）、远端媒体 22 项（`pnpm verify:remote-media`）、远端接入 7 项（`pnpm verify:remote-browser`）、**本次三项改动 17 项（`pnpm verify:polish`）**、**倒计时响铃逻辑 21 项（`pnpm verify:countdown-ring`）**、**分页预览 33 项（`pnpm verify:print-paging`）**，合计 743 项。

## 关键技术结论（实测）

1. **浏览器 SQLite 持久化可行**：`@sqlite.org/sqlite-wasm` 的 `opfs-sahpool` VFS 在
   Chrome 中可用，且**不需要 COOP/COEP 响应头**（`crossOriginIsolated: false` 下
   `createSyncAccessHandle` 仍成功）。这意味着可以直接部署到静态托管。
2. **SQLite 必须跑在 Worker 里**：OPFS 同步访问句柄只在 Worker 中暴露。
3. **API 用 `db.exec({ sql, bind, rowMode, returnValue })`**：新版 oo1 已移除
   `PreparedStatement.run()`，旧写法会报 `run is not a function`。
4. **时区边界已处理**：农历腊月落在下一个公历年，倒计时按「候选年 + 本地日期」比较，
   生日当天算「今天」而不是跳明年。

## 多标签页与数据库独占（重要）

OPFS 的同步访问句柄是**按 origin 独占**的：同一时刻只能有一个 Worker 持有数据库文件。
因此打开第二个标签页时，第二个标签页不会崩溃，而是显示：

> 数据库已在另一个标签页中打开。关闭那个标签页后，这里会自动接管。

「自动接管」由 **Web Locks** 实现：抢到 `jvs-sqlite-owner` 锁的标签页拥有一切，
其他标签页排一个排队请求，等持有者释放（关闭标签页）时**立即被授予**并自行加载数据，无需手动刷新。

试过但不可行的方案：`SharedWorker` 看似是天然的单所有者，但 **OPFS API 在 SharedWorker
全局作用域中根本不存在**（实测报 `Missing required OPFS APIs`），所以它也无法持有数据库。

跑法：

```bash
pnpm verify      # 单标签页 23 项（含重启持久化）
pnpm verify:tabs # 双标签页 9 项（冲突提示 + 自动接管 + 数据可见）
```

## 数据库迁移（schema v1 → v2）

应用启动时会自动把旧数据库升级到当前 schema，**数据不会丢失**。迁移顺序很关键：

1. 建表（`CREATE TABLE IF NOT EXISTS`）
2. **补列**（`ALTER TABLE ... ADD COLUMN`，按 `PRAGMA table_info` 逐个比对）
3. 建索引
4. 删除已被取代的旧表
5. **校验**必需列与必需表，缺任何一项就抛出明确错误

第 2、3 步的顺序曾经是反的，这会让**旧库永远起不来**：索引引用了 v2 才有的
`generation` 列，而 `CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，于是建索引时
`no such column: generation`，整批语句在补列之前就中断了。

因为 Playwright 套件每次都从空 profile 开始，这条升级路径长期没被覆盖，所以现在有专门的
回归测试 `pnpm verify:migration`：用真实的 SQLite（`node:sqlite`）构造一个 v1 形状的库，
验证升级后列/表/索引齐全、旧数据保留、schema_version 正确，并**反向断言"先建索引"确实会失败**。

## 已知限制

- 尚未做 Service Worker 离线缓存（应用外壳还不能完全离线加载）。
- 未做多端同步；`person` 已用 UUID 主键 + `deleted_at` 墓碑，为同步预留。
- 天气与家族树界面待实现。
- 首屏 JS 约 577KB（gzip 189KB），SQLite wasm 869KB（gzip 407KB），后续应按需加载。
## 近期修复

### 页面底色改为纯色

原来 `body` 用的是 `radial-gradient(1200px 600px at 20% -10%, #16243c 0%, var(--bg) 60%)`，
左上角一团更亮的蓝。深色主题下看着像蒙了一层光晕，容易被误读成「还有一层没加载完的
背景图」。现在整块换成 `var(--bg)` 这一支**纯色**，层次靠面板色（`--panel` / `--panel-2`）
和描边（`--line`）来区分，界面更干净，也不必每帧重绘一层渐变。

### 笔记导出 PDF：预览真正一页一页

原来屏幕上的「打印预览」只有**一条无限长的白纸**，一路滚到底；而实际打印出来却是
好几页 —— 用户根本没法知道分页点落在哪里，这就是「无法正确一页一页展示」。

现在改成**真·分页预览**：先按纸张宽度离屏量一遍每个顶层块的真实高度，再按纸张
内容高贪心装箱，切成 N 张独立的纸。纸张可选 A4/A5/B5/Letter，换纸立刻重切；
工具栏有「‹ 上一页 / 第 X / N 页 / 下一页 ›」，也支持 ← → 方向键与直接滚动，
滚到哪页计数就跟着变。

真正难的不是切页，而是**让预览的页数等于 PDF 的页数**。过程中踩了三个坑：

1. **`visibility: hidden` 藏不掉版面**。原来打印时用 `visibility: hidden` 藏应用，
   它只是看不见、布局还在，于是打印层被顶到第 2 页之后，凭空多出几张空白页
   （实测 2 页的笔记打出 5 页）。改成把打印层 **portal 到 `document.body`**，
   再用 `body > *:not(.print-overlay) { display: none }` 把应用彻底从版面里拿掉。

2. **`@page` 不能套在 `@media print` 里**。套进去整条会被忽略，浏览器退回默认纸和
   默认页边距，一张纸就会比可打印区高一点点、被劈成两页。`@page` 必须写在样式表
   顶层 —— 它本来就只在打印时生效。

3. **`img.decode()` 可能永远不 settle**。带图片的笔记会卡在「正在分页…」，
   因为 blob URL 图片的 `decode()` 既不 resolve 也不 reject。改用
   `load`/`error` 事件 + 4 秒超时兜底，并且在页面级加了一次 try/catch 回落，
   保证**分页失败也一定把预览打开**，不会把用户困住。

顺带修掉一个隐蔽问题：图片如果没设 src，量出来的高度是 0，一张竖图实际 400px
却按 0 算，后面的段落就会被硬塞进同一页、打印时溢出被裁。所以图片必须先
hydrate + 等加载完，再开始测量。

### 倒计时到期持续响铃

倒计时模块原来**完全没有声音** —— 只有「还有 N 天」几个字，到点了也不会响。

现在目标日期**当天**（`daysUntil === 0`）开始**持续响铃**，一直响到用户点「知道了」
为止。实现要点：

- **铃声用 Web Audio 现场合成**（740 Hz 基频 + 两个三角波失谐 ±6 Hz，过带通滤波），
  不往仓库里塞二进制资源。音频文件循环播放时首尾接缝会「咔」一下，合成则完全无缝。
- **全局单例**（`core/countdown/ring.ts`）：仪表盘卡片和倒计时页是两个独立挂载点，
  只有引擎持有唯一的 AudioContext，两边不会各建一份互相叠音。引擎同时是「用户已关掉
  声音」的权威副本 —— 不会出现「页面显示关着、卡片却在响」。
- **自动播放策略**：`resume()` 是异步的，必须 `await` 它再判断成败（紧跟着读
  `ctx.state` 不可靠 —— 这是实现时踩到的一个真 bug）。没有用户手势时状态置为
  `blocked`，界面显示「开启提醒」按钮；另有 `armRing()` 挂一次性手势监听，用户首次
  点击/按键时自动补铃。
- **多项同时到期只叠一个铃声循环**，到期清单合并后一起显示。
- **已经过去的日子不补响** —— 对着昨天的事狂响没有意义。触发点只有「从 `days > 0`
  变成 `days === 0`」那一刻。
- **确认过的这批不再自动响**（翻页面、刷新、重挂载都不会又响起来）；手动点
  「开始响铃」则强制再响一次。

**已知限制**：关掉标签页就没有铃声 —— Web Audio 活在页面上下文里。要做成「关掉
浏览器也能提醒」需要 Notification API + Service Worker，是另一件事。

### 词光 atlas 的媒体源入口

媒体源设置以前只藏在「词光 atlas → 统计」页的**最底部**，没人找得到。现在：

- **⚙ 设置 → 媒体** 标签页里有一份（主入口）；
- 模块内保留了列表头常驻按钮、今日页状态行、统计页原位，以及词库未导入时的首屏入口；
- 两处共用同一个 `app/MediaSourceSetting.tsx` 组件，不会各存一份状态。

关键约束：**设置面板挂载时绝不探测远端**（只读本地 SQLite）。否则每次打开 JVS 都
会去 ping 一次私人服务器，既慢又会在控制台里留下 CORS 报错。只有用户点「测试连接」
或「保存」时才发请求。

### 弹窗输入与 `Cannot read properties of null (reading 'reset')`

添加倒计时、添加笔记会在提交时报上面这个错。原因是提交处理函数在 `await` 之后才调用
`event.currentTarget.reset()`，而 React 在事件处理函数让出控制权后会把 `currentTarget`
置空（React 19 不再池化事件，但 `currentTarget` 仍然只在同步阶段有效）。

修复方式不是打补丁，而是改为**弹窗输入**：提交成功后关闭弹窗，组件直接卸载，不需要
reset 任何表单。生日、倒计时、笔记三个入口统一改成这个结构，表单也不再常驻占据页面。

### 天气模块（移植 cyweather）

数据层与天空场景都从 `cyweather`（Python/Tkinter 桌面版）移植，接口保持
Open-Meteo、WMO 码表、主题配色、太阳位置算法一致。为浏览器做的调整只有一处：
IP 定位（`ip-api.com`）在 HTTPS 页面下不可用（明文 HTTP + 无 CORS 头），改为
Open-Meteo geocoding 的**城市搜索 + 三个快捷键城市**。

## 更新：
进入项目目录:
  1,git branch
  2,git pull
## 隐私与公开版本

生日卡、家族树、笔记、倒计时的用户记录属于敏感数据，保存在浏览器 OPFS SQLite 中，不随源代码发布。不要提交数据库、备份、GEDCOM、个人笔记导出或截图。脚本中的人物为虚构测试样例。应用锁仅限制界面访问，不提供数据库或备份加密。公开版本媒体默认使用本地目录，远端需自行配置。评审结果见 [docs/REVIEW.md](docs/REVIEW.md)。
