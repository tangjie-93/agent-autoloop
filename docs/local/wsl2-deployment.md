# `WSL2` 备用部署方案

本地 `Windows` 电脑优先使用[原生部署](windows-native-deployment.md)。只有选用的 `Agent` 或依赖要求 `Linux`，或原生工具在当前环境无法运行时，才使用本文。常规 `macOS` / `Linux` 安装仍见 [`INSTALL.md`](../../INSTALL.md)。

这是唯一的本地 `WSL` 部署指南。`WSL` 与原生 `Windows` 使用独立数据目录、依赖和 `Agent` 登录，不同时操作同一份 `hub.db` 或运行记录。启动器不会迁移旧实例，也不复制密钥或登录凭据；原来的 `Windows Codex` 配置可以保留。

## 准备 `WSL`

在管理员 `PowerShell` 中安装或检查：

```powershell
wsl --install -d Ubuntu
wsl --list --verbose
```

明确指定自己的发行版和已有的普通 `Linux` 用户，例如：

```powershell
wsl -d Ubuntu -u <Linux用户名>
```

进入后安装 `Linux Node.js 24+`、`Git`、`curl` 及 `Linux` 版命令行 `Agent`，并在这个用户下单独登录。确认路径不是从 `Windows PATH` 混入的：

```bash
command -v node
command -v codex
node --version
codex --version
```

版本命令只能证明程序可运行，不代表登录完成。仓库可位于 `WSL` 文件系统，或使用 `Windows` 映射路径，例如 `D:\github\agent-autoloop` 对应 `/mnt/d/github/agent-autoloop`。同一份源码可以访问，但不要共用两边安装的 `node_modules`；需要频繁切换时使用独立检出目录。

## 手动安装和启动（以此为准）

以下都在同一个 `Linux` 用户的 `WSL bash` 中执行。示例明确覆盖继承的环境变量，统一使用 `~/.agent-autoloop-local`：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
export AGENT_AUTOLOOP_REPO="$PWD"
sh "$PWD/install.sh" --agent codex --no-service
```

本地安装器安装**已提交的 `HEAD`**，不包含工作树的未提交修改。自定义数据目录不保证命令已进入 `PATH`，后续统一使用已安装程序的绝对路径：

```bash
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
AUTOLOOP_CLI="$AGENT_AUTOLOOP_HOME/app/bin/agent-autoloop.ts"
node "$AUTOLOOP_CLI" doctor
node "$AUTOLOOP_CLI" check
node "$AUTOLOOP_CLI" up
```

保持这个终端运行。另开同一发行版、同一用户的 `WSL` 终端启动前端：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
export AGENT_AUTOLOOP_URL="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_HOME+"/config.json","utf8")).url)')"
npm --prefix frontend ci
npm --prefix frontend run dev -- --strictPort --port 5193
```

`Windows` 浏览器打开 `http://127.0.0.1:5193`。本文手动 `WSL` 启动不启用原生启动器的本机会话网关，仍需在页面输入这个 `Linux` 数据目录 `config.json` 中的本人密钥；仅留在页面内存，不要拿原生实例的密钥混用。断开连接会关闭 `SSE` 并清空页面，不停止后台任务；发送事件仍需独立来源密钥。先停止占用同端口的旧实例，或为新实例配置不同端口。

## 可选：复用仓库的 `bash` 入口

`WSL` 不提供从 `Windows` 自动包装启动的入口；在已选定发行版和用户的 `WSL bash` 内操作。完成初始化和前端依赖安装后，也可手动复用 `scripts/start-wsl.sh`：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
bash scripts/start-wsl.sh info
bash scripts/start-wsl.sh backend
```

后端保持前台运行，另开同一用户的 `WSL` 终端启动前端：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
bash scripts/start-wsl.sh frontend 5193
```

显式设置 `Linux` 数据目录，避免继承 `Windows AGENT_AUTOLOOP_HOME` 或 `WSLENV` 中的不适用路径；不把 `D:\...` 传给 `Linux` 进程。脚本未设置数据目录时默认使用 `~/.agent-autoloop-local`；本机如有 `env.sh`，还需核对其中设置。原生 `npm start` 不进入 `WSL`，不要用它代替上述步骤。

## 项目、并发和配置边界

- `WSL` 规则的 `cwd` 使用 `Linux` 路径，如 `/mnt/d/github/project`；原生接单程序的规则使用 `Windows` 路径，不能混用。
- `WSL Codex` 是 `Linux` 后台进程，不是原生 `Windows Codex`。自己手动开的会话不会自动纳入中台监控；操作台不直播交互终端输出。
- 容量仍在 `config.json` 的 `worker.capacity`，规则组并发在 `rules.json` 的 `parallel`，不要合成一个配置文件。输出在 `worker/runs/`，不是多个弹出的交互窗口。
- 独立输出和会话不等于工作树隔离；多个事项共用同一 `cwd` 仍可能修改同一文件。并行写代码时配置独立项目目录或 `Git worktree`，接单程序不会自动隔离，容量限制也不防文件冲突。
- 登录配置和 `CODEX_HOME` 分开维护。不要为了沿用原生配置复制秘密文件；`Windows` 的既有配置无需删除。
- 不要把两个环境的接单程序伪装成同一个接单电脑；需要正式多机部署时按[配置手册](../../skills/agent-autoloop/SKILL.md)分别登记。

## 停止与切换

在对应的 `WSL` 用户下设置同一数据目录，先取消运行中的轮次：

```bash
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
AUTOLOOP_CLI="$AGENT_AUTOLOOP_HOME/app/bin/agent-autoloop.ts"
node "$AUTOLOOP_CLI" stop <轮次编号>
node "$AUTOLOOP_CLI" status
```

等取消确认、没有 `claimed` 轮次后，在手动启动的前后端终端按 `Ctrl+C` 并等待进程退出。退出中台不等于取消 `Agent`，不要用 `wsl --shutdown` 代替正常收尾。后台启动的实例应先查明自己的进程再停止，不结束其他用户或服务。

切回原生模式时，先确认旧 `WSL` 接单程序及其 `Agent` 已退出，再在 `Windows` 终端恢复或设置自己的 `AGENT_AUTOLOOP_HOME`，按需重新安装原生前端依赖，在仓库根目录运行 `npm start`（或 `node scripts/start-console.ts`）。两边分别备份，不自动迁移状态。

`WSL` 桌面通知不会发到 `Windows` 桌面；可用操作台或 `node "$AUTOLOOP_CLI" status` 查看，其他远程通道需单独配置且不得擅自发真消息。

## 验证范围

`doctor`、`check` 和前端连接只能核对当前环境；真实 `node "$AUTOLOOP_CLI" try` 会消耗模型额度，必须另行得到明确授权。备用环境的通过记录不能证明原生 `Windows` 进程树、登录任务、`ACL` 或沙箱正常。本文是操作步骤，不是本次已通过的验收记录。
