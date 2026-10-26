# JVS — 一体化个人生活应用



## 运行

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # 类型检查 + 生产构建
pnpm preview    # 预览构建产物 http://localhost:4173
pnpm verify     # 真实 Chrome 验证（需先启动 preview）
```


### 词光 atlas 的媒体源入口

媒体源设置以前只藏在「词光 atlas → 统计」页的**最底部**，没人找得到。现在：

- **⚙ 设置 → 媒体** 标签页里有一份（主入口）；
- 模块内保留了列表头常驻按钮、今日页状态行、统计页原位，以及词库未导入时的首屏入口；
- 两处共用同一个 `app/MediaSourceSetting.tsx` 组件，不会各存一份状态。

关键约束：**设置面板挂载时绝不探测远端**（只读本地 SQLite）。否则每次打开 JVS 都
会去 ping 一次私人服务器，既慢又会在控制台里留下 CORS 报错。只有用户点「测试连接」
或「保存」时才发请求。



## 更新：
进入项目目录:
  1,git branch
  2,git pull
## 隐私与公开版本
程序均为脱敏后数据，可放心使用，用户录入的 数据均保存在本地，不会上传
目前版本还是为测试版本，欢迎大家指正.

