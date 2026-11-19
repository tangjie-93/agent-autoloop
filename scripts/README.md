# scripts

仓库自己的工具脚本：启动流程操作台、跑安装冒烟、分派 CI 范围、做性能和历史量实测、跑真机验证。它们不属于内核，内核和插件都不会导入这里；除两个启动入口 `start-console.ts`、`start-wsl.sh` 外，都只给开发和发布检查用。`.ts` 脚本需要 `Node 24+`，`.sh` 脚本用 POSIX shell，没有新增运行时依赖。

## 启动与安装

| 文件 | 作用 | 怎么运行 |
| --- | --- | --- |
| `start-console.ts` | 本机一键启动操作台。先检查参数、`config.json` 和前端依赖，再复用或启动中台，复用或启动 `Vite`，确认浏览器用的本机会话和鉴权代理可用，最后打开页面。服务会脱离启动器继续运行；任一步失败都不会停止已有服务。 | `npm start` 或 `node scripts/start-console.ts`，参数用 `--help` 查看；前置条件见[原生部署](../docs/local/windows-native-deployment.md)。 |
| `start-wsl.sh` | WSL 里的手动入口。`info` 打印数据目录和中台地址，`backend` 启动中台，`frontend` 启动 `Vite`；只负责对齐环境，不管进程生命周期。 | `bash scripts/start-wsl.sh info\|backend\|frontend [前端端口]`，见 [WSL2 部署](../docs/local/wsl2-deployment.md)。 |
| `install-smoke.sh` | Unix 安装冒烟：在临时 `HOME` 里用 `install.sh` 安装**已提交代码**，启动、`try`、回答、看到完成、卸载，并检查没有残留。Agent 和桌面通知命令是假的，也不注册系统服务。 | `sh scripts/install-smoke.sh` |
| `install-smoke-windows.ts` | Windows 原生安装冒烟：用 `install.ps1` 在带空格的临时目录走完安装、提问、回答、续跑、更新和卸载，并核对卸载后数据保留、程序移除、中台退出。 | `node scripts/install-smoke-windows.ts` |
| `test-windows.ts` | 在 Windows 上跑共用行为测试，跳过只为 Unix shell 写的用例；原生进程、服务和安装分支由 Windows 专用测试覆盖。 | `npm run test:windows` |

## CI 与实测

| 文件 | 作用 | 怎么运行 |
| --- | --- | --- |
| `ci-scope.sh` | 按改动文件算出这次 CI 要跑多少：`docs` 全部跳过、`normal` 快速测试、`kernel` 再加短模拟、`full` 完整检查。只读 `GITHUB_EVENT_NAME` 和本次提交与 `HEAD^1` 的差异。 | 由 `.github/workflows/check.yml` 调用；本地可 `sh scripts/ci-scope.sh`。 |
| `benchmark.ts` | 性能实测：逐条 HTTP 写入的持久化吞吐、事件到领活的延迟、1000 个长轮询同时等待、排队很深时的心跳开销，以及模拟速度。只记录数字，不设达标线。 | `npm run benchmark`；排队场景用 `BENCH_QUEUE=5000 node scripts/benchmark.ts --busy`；也在 `npm run test:nightly` 里跑。 |
| `metrics.ts` | `benchmark.ts` 共用的测量工具：统计并发轮询、取分位数、在时间和次数上限内重复执行。没有独立入口。 | 不单独运行。 |
| `history.ts` | 历史量实测：造 1 千、1 万、10 万轮业务，测冷启动、各类请求延迟、慢速日志订阅时的内存、回执确认后强杀再启动是否丢结果，以及从事实日志重建投影。 | `node scripts/history.ts 1000 10000 100000`，数据量可替换。 |

## 真机验证

这几个脚本会启动真实 CLI 或操作真实 GitHub，只在明确要求时运行。其他测试都使用临时 `AGENT_AUTOLOOP_HOME` 和随机端口，不发真消息，也不弹真实桌面通知。

| 文件 | 作用 | 怎么运行 |
| --- | --- | --- |
| `real-agents.ts` | 用真实的 Codex 或 Claude CLI 跑一轮提问、回答和续跑，确认回执可读、原会话能接上，退出时不留子进程；整个过程最多启动三次。 | `node scripts/real-agents.ts codex` 或 `node scripts/real-agents.ts claude` |
| `real-protocols.ts` | 真机协议验证：`acp` 检查 ACP 桥能否接回原会话；`mcp` 用 Codex 作为 MCP 客户端调用中台工具。 | `node scripts/real-protocols.ts acp <ACP 程序绝对路径>`；`node scripts/real-protocols.ts mcp` |
| `delivery-e2e.ts` | 完整交付流程的真机验证：按标签接单、审查、等完整检查、合并、Ship、核对线上健康版本。会创建并删除指定的私有测试仓库。 | `node scripts/delivery-e2e.ts owner/name --run`；只有明确要求时才执行。 |

## 约定

- 日常检查先看 `package.json` 的 `scripts`：`npm run test:quick`、`npm run typecheck`、`npm run format:check`。模拟、穷举和变异什么时候跑见 [AGENTS.md](../AGENTS.md) 的「怎么改」。
- 冒烟和实测脚本使用临时数据目录与随机端口，结束前自己清理；只有标成「真机」的脚本会碰外部账号、仓库或在线服务。
- 改了验证口径，或让测试读取新的文档，要同步检查 [AGENTS.md](../AGENTS.md) 的「验证范围」和 `ci-scope.sh`。
