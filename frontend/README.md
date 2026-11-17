# 流程运行台

`frontend/` 是独立的 `Vue 3` 客户端，通过原有 `/v1` 接口读取状态、查看轮次时间线、回答卡片、结案、停止及发送来源事件。不改中台内核，不提供规则编辑或拖拽编排，也不直播 `Agent` 交互终端输出；手动打开的 `Codex` 不会自动纳入监控。

原生 `Windows` 可在仓库根目录用 `npm start`（或 `node scripts/start-console.ts`）启动或复用本机中台、接单程序和前端，见[原生部署](../docs/local/windows-native-deployment.md)。`WSL` 仅为需要 `Linux` 工具的备用环境，见[备用部署](../docs/local/wsl2-deployment.md)。`macOS` / `Linux` 手动启动方式保留如下；不要混用不同环境的 `node_modules`。

## 本地运行

需要 `Node 24` 或以上。先启动中台，再在仓库根目录执行；将示例地址换成自己 `config.json` 的 `url`。

`PowerShell`：

```powershell
npm --prefix frontend ci
$env:AGENT_AUTOLOOP_URL = "http://127.0.0.1:7317"
npm --prefix frontend run dev
```

`macOS` / `Linux bash`：

```bash
npm --prefix frontend ci
AGENT_AUTOLOOP_URL=http://127.0.0.1:7317 npm --prefix frontend run dev
```

`Windows` 启动入口同样需要先安装上述依赖；用 `npm start -- --help` 查看参数，例如 `npm start -- --frontend-port 5194 --no-browser`。启动器不再复制剪贴板，`--no-clipboard` 仅兼容保留，传入不产生作用。它用 `node.exe` 直接运行 `Vite`，默认页面端口是 `5193`，不是手动开发的默认端口。它使用 `AGENT_AUTOLOOP_HOME`（默认 `%USERPROFILE%\.agent-autoloop`），日志及自己启动的前后端进程记录在 `<数据目录>\logs\console`；手动停止步骤见[原生部署](../docs/local/windows-native-deployment.md#停止和故障排查)。

### 两种连接方式

- **本机启动器模式：** `npm start`（或 `node scripts/start-console.ts`）设置仅服务端使用的 `AGENT_AUTOLOOP_LOCAL_CONFIG` 配置路径。打开默认 `http://127.0.0.1:5193` 后，页面只有“连接中台 / 断开连接”按钮，不需要填写或复制 `owner`。`Vite` 服务端读取配置并保管 `owner`，不将它发给浏览器；浏览器仅在内存持有短时随机会话。网关严格校验回环地址、`Host`、`Origin` 和路由白名单，通过会话授权后才向固定中台注入本人鉴权。仅启动器启用此模式，不用于匿名或公网访问。
- **手动开发、静态或远程模式：** 上面的 `npm --prefix frontend run dev` 默认仍需输入中台本人密钥；手动开发页面通常为 `http://127.0.0.1:5173`。固定代理目标由服务端 `AGENT_AUTOLOOP_URL` 指定，默认 `http://127.0.0.1:7317`；静态或远程部署使用固定反向代理。手动输入的密钥只留在页面内存，刷新后重新输入，不写入网址、磁盘或构建产物。

本人身份可查询、回答、结案和停止。无论哪种模式，发送事件表单都必须独立填写来源密钥，本机会话不能代替来源身份。点击“断开连接”会撤销本机会话、关闭 `SSE` 并清空页面及内存凭据，但不会停止后台任务；手动密钥模式同样取消订阅并清空页面。关闭发送事件表单会丢弃该表单的来源密钥。

界面采用 `Vue Flow` 只读运行画布、轮次列表和执行轨迹面板。连接后通过带本人鉴权的 `fetch` 订阅 `/v1/stream`，收到事实时合并触发状态读取，时间线按轮次或卡片变化更新。首次从日志序号 `0` 流式追读（页面只保留最近 `12` 条动态），断线从已接收序号续传；当前接口没有最新游标端点，大历史实例首次订阅需要追读历史。实时连接失败会保留旧数据并明确标记过期，暂停连线和节点动画，随后自动重连。可以手动刷新状态。写操作不自动重发；网络错误后应先刷新核对。停止请求被接收不等于子进程已停止，以后端最终状态为准。

## 验证与构建

```powershell
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run format:check
npm --prefix frontend run preview
```

`preview` 仅用于本机验收。正式部署将 `dist/` 交给静态服务器，同时将 `/v1/` 代理到固定中台，参考 [nginx.conf](nginx.conf)，公网部署须配置 `HTTPS`，关闭反向代理的流缓冲并允许长连接（示例已包含 `proxy_buffering off` 和读取超时），不要启用通配跨域、任意目标代理，或向匿名 / 公网请求自动注入密钥。本机启动器的会话授权网关不适用于这种部署。

## 隔离的浏览器验收

```powershell
npm --prefix frontend run fixture
```

该命令创建临时数据目录与随机端口的真实中台，种下问题卡片、通知和运行中的轮次，不启动真实 Agent，不发真实通道消息。终端输出临时 `url`、`owner`、`source` 和 `worker`。在另一个终端把 `AGENT_AUTOLOOP_URL` 设置为输出的 `url` 后启动前端。用输出的 `owner` 连接；可测试回答、结案、停止（运行中停止需接单程序确认）、发送 `feedback.new` 类型事件。按 `Ctrl+C` 结束并清理临时目录。所有输出密钥仅用于这个测试中台。
