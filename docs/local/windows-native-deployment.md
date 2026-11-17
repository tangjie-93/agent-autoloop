# 原生 `Windows` 部署与日常运行

本文是本地 `Windows` 电脑的首选部署方案。中台、接单程序（`Worker`）、流程操作台和命令行 `Agent` 都由 `Windows` 进程运行，不需要 `WSL`。只有使用 `Linux` 专属工具或依赖时，才使用 [备用方案](wsl2-deployment.md)。`macOS` / `Linux` 的常规安装仍见 [`INSTALL.md`](../../INSTALL.md)。

## 1. 运行结构

```text
Windows 登录会话
├── 登录任务（可选，启动中台）
├── node bin/agent-autoloop.ts up
│   ├── 中台
│   ├── Windows Worker
│   └── 已配置的通道
├── node frontend/node_modules/vite/bin/vite.js（流程操作台）
└── Worker 启动的多个后台 codex exec / claude 子进程
```

这些是后台执行进程，不是多个交互式终端窗口。操作台展示轮次、状态、回执和事实时间线，不提供 `Codex` 终端的逐行直播。执行输出保存在各轮次日志中；自己手动打开的 `Codex` 不会自动被中台接管或监控。

`worker.capacity` 限制本机同时运行的轮数；规则中的 `parallel` 再限制同组事项并发。两个限制同时生效，实际并发也取决于待处理的不同事项数量。

## 2. 先看启动顺序

首次使用按下面的步骤依次执行；已经安装过的，直接看[日常启动](#服务和日常启动)。本文以 `Codex` 为例，所有命令都在普通用户的 `PowerShell` 中运行，不需要以管理员身份打开终端。

| 阶段           | 要做的事                   | 完成后得到什么                          |
| -------------- | -------------------------- | --------------------------------------- |
| 步骤一         | 检查本机工具并登录 `Agent` | 确认 `Windows` 能找到并运行所需程序     |
| 步骤二         | 确定仓库位置和数据目录     | 分清源码放哪里、配置和记录存哪里        |
| 步骤三         | 安装并初始化中台           | 生成本机配置、规则和密钥                |
| 步骤四         | 设置命令变量并检查规则     | 后续命令能准确找到同一个实例            |
| 步骤五         | 安装前端依赖               | 让流程操作台具备启动条件                |
| 步骤六         | 启动中台、接单程序和操作台 | 后台进程运行，浏览器页面可以打开        |
| 步骤七         | 连接页面并核对状态         | 确认页面连的是当前中台，接单程序在线    |
| 步骤八（可选） | 执行一次真实问答           | 验证真实 `Agent` 能接单、提问并继续执行 |

**先完成启动和连接，再考虑真实任务、并发和登录自启动。** 首次安装采用 `--no-service`，先不注册登录任务，避免同时排查启动器和登录任务两套入口。它不会停掉以前已经存在的服务。

## 3. 首次安装与启动：逐步操作

### 3.1 检查本机工具并登录 `Agent`

**这一步做什么：** 确认运行环境可用，并让 `Agent` 在当前用户下完成登录。中台只负责派单，不会替你登录 `Codex` 或 `Claude Code`。

```powershell
node --version
npm --version
git --version
where.exe node
where.exe codex
codex --version
codex login status
```

**逐条解释：**

1. `node --version`：检查运行中台所需的 `Node.js`，版本必须是 `24` 或更新。
2. `npm --version`：检查包管理器，后面用它安装前端依赖。
3. `git --version`：检查安装器复制和更新程序所需的 `Git`。
4. `where.exe node`、`where.exe codex`：查看实际找到的程序路径，确认使用的是 `Windows` 程序，而不是 `WSL` 里的命令。
5. `codex --version`：确认命令行程序能启动；**有版本号不等于已登录**。
6. `codex login status`：检查当前用户的登录状态。未登录时，运行 `codex login`，按提示完成登录后再检查一次；不要复制其他环境的登录凭据。

使用 `Claude Code` 时，将检查 `Codex` 的命令换成 `where.exe claude`、`claude --version`，并按该工具自己的方式完成登录；后续安装参数使用 `--agent claude`。

**如何确认成功：** 工具版本能够输出，程序路径属于本机 `Windows` 环境，所选 `Agent` 已完成登录。如果提示找不到命令，先安装对应工具或修正当前用户的 `PATH`，重新打开 `PowerShell` 后再继续。

不要把 `WSL` 的 `codex`、`Linux node` 或 `/mnt/...` 路径写进 `Windows` 规则。

### 3.2 确定仓库位置和数据目录

**这一步做什么：** 区分仓库源码、安装副本与运行数据，避免后续命令连接到错误的实例。以下仓库路径按实际位置替换；后续首次启动步骤尽量在同一个 `PowerShell` 窗口执行。

```powershell
$Repo = 'D:\github\agent-autoloop'
Set-Location $Repo
Test-Path .\install.ps1
Test-Path .\scripts\start-console.ts
```

**逐条解释：**

1. `$Repo`：记录本地仓库根目录，不是运行数据目录。
2. `Set-Location $Repo`：进入仓库，让后续相对路径指向正确位置。
3. 两条 `Test-Path`：确认安装器和启动入口都在此目录；正常都返回 `True`。返回 `False` 时先检查路径和仓库内容，不要继续安装。

默认数据目录是 `%USERPROFILE%\.agent-autoloop`，在 `PowerShell` 中可写为 `$env:USERPROFILE` 下的 `.agent-autoloop`。如果需要隔离实例，在安装前设置：

```powershell
# 仅在需要自定义数据目录时执行，并记住这个路径
$env:AGENT_AUTOLOOP_HOME = 'D:\agent-autoloop-data\dev'
```

不需要自定义时跳过这段。如果当前终端已经设置了 `AGENT_AUTOLOOP_HOME`，后续会沿用它；先确认它就是你要使用的目录。

| 位置                              | 用途                                   | 注意事项                                   |
| --------------------------------- | -------------------------------------- | ------------------------------------------ |
| `D:\github\agent-autoloop`        | 当前仓库源码、`scripts/start-console.ts` 和前端 | 前端依赖装在这里的 `frontend\node_modules` |
| `<数据目录>\app`                  | 安装器生成的程序副本                   | 后续 `$AutoloopCli` 指向这里               |
| `<数据目录>\config.json`          | 中台地址、接单配置和密钥               | 不公开，不提交到仓库                       |
| `<数据目录>\rules.json`           | 事件匹配、任务指令、工作目录和并发规则 | 修改后先执行 `check`                       |
| `<数据目录>\hub.db`、`master.key` | 运行记录和用于推导令牌的主密钥         | 备份要配套保留，不与其他实例共用           |
| `<数据目录>\logs`、`worker\runs`  | 服务日志和每轮执行日志                 | 可能包含业务资料，不公开上传               |

**如何确认成功：** 已明确仓库位置和唯一的数据目录。自定义目录的环境变量只在当前终端及其子进程中生效；新终端要重新设置，不会继承另一个终端的临时变量。

### 3.3 安装并初始化中台

**这一步做什么：** 从本地仓库安装程序副本，为新实例生成配置、规则和密钥。本步骤暂不启动登录服务，也不调用真实模型。

```powershell
$env:AGENT_AUTOLOOP_REPO = $Repo
& "$Repo\install.ps1" --agent codex --no-service
```

**逐条解释：**

1. `AGENT_AUTOLOOP_REPO`：让安装器使用指定本地仓库作为安装来源。
2. `&`：`PowerShell` 的调用运算符，用来执行后面的脚本路径。
3. `--agent codex`：为新实例选择 `Codex`；使用 `Claude Code` 时改成 `--agent claude`。
4. `--no-service`：暂不注册登录任务，稍后通过 `npm start` 启动。

首次本地安装复制的是仓库**已提交的 `HEAD`**，不包含工作树中未提交的修改。已有安装会沿用已记录的安装来源更新；已有 `config.json` 时不会重新初始化，也不会因为更换 `--agent` 就自动重写现有规则。

如果本机执行策略阻止运行脚本，可以在当前终端改用下面的调用方式。它只对这次子进程生效，不修改系统的永久执行策略：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$Repo\install.ps1" --agent codex --no-service
```

**如何确认成功：** 安装器没有报错，新实例显示安装完成，并在选定数据目录中生成 `config.json`、`rules.json` 和 `app`。此时没有启动中台是正常的，先不要运行依赖在线中台的命令。

### 3.4 设置后续命令变量并检查规则

**这一步做什么：** 让后续命令使用明确的程序路径和同一个数据目录，不依赖终端是否已经刷新 `PATH`。

```powershell
$AutoloopHome = if ($env:AGENT_AUTOLOOP_HOME) { $env:AGENT_AUTOLOOP_HOME } else { Join-Path $env:USERPROFILE '.agent-autoloop' }
$env:AGENT_AUTOLOOP_HOME = $AutoloopHome
$AutoloopCli = Join-Path $AutoloopHome 'app\bin\agent-autoloop.ts'
Test-Path $AutoloopCli
node $AutoloopCli check
```

**逐条解释：**

1. `$AutoloopHome`：取当前指定的数据目录；没有指定时使用默认目录。
2. `$env:AGENT_AUTOLOOP_HOME`：把该目录传给后续启动的进程。
3. `$AutoloopCli`：拼出已安装命令行入口的完整路径。
4. `Test-Path $AutoloopCli`：确认安装副本存在，正常返回 `True`。
5. `node $AutoloopCli check`：只检查本机 `rules.json` 的格式和规则约束，不要求中台已启动，也不调用模型。

**如何确认成功：** 路径检查返回 `True`，规则检查输出“规则没问题”。如果规则检查失败，先修正规则，不继续启动。

**变量不会跨终端自动保留。** 以后新开终端执行本文命令时，自定义实例先重新设置 `AGENT_AUTOLOOP_HOME`，再执行本步骤的变量设置。自定义目录安装不会把命令加入 `PATH`；默认目录安装会加入，但本文统一使用 `node $AutoloopCli`，也可以使用安装器打印的完整命令。

### 3.5 安装流程操作台依赖

**这一步做什么：** 为仓库里的独立前端安装依赖。中台安装器不会替你完成这一步，`npm start` 也不会自动安装。

```powershell
Set-Location $Repo
npm --prefix frontend ci
```

**逐条解释：**

1. `Set-Location $Repo`：确保操作的是当前仓库的前端。
2. `--prefix frontend`：把安装目标限定在 `frontend`，不是仓库根目录。
3. `ci`：按前端锁文件安装依赖；会重新安装该前端的 `node_modules`，不是启动服务。

**如何确认成功：** 命令正常结束，没有安装错误，且存在 `frontend\node_modules\vite\bin\vite.js`。通常首次安装或前端依赖变更后执行，不需要每次启动都执行。不要复用 `WSL` 的 `node_modules`。

### 3.6 启动中台、接单程序和流程操作台

**这一步做什么：** 用同一个入口启动后台服务和前端。前面的步骤只准备好了文件，这一步才让系统开始运行。

```powershell
Set-Location $Repo
npm start
```

**启动后具体发生什么：**

1. 读取当前 `AGENT_AUTOLOOP_HOME` 下的 `config.json`；未指定时使用默认数据目录。
2. 检查配置中的本机中台地址。已有中台能通过本人鉴权检查时直接复用；没有运行时启动中台、接单程序和已配置通道。
3. 启动或复用前端，默认地址是 `http://127.0.0.1:5193`；前端代理目标取 `config.json` 的 `url`。新实例中台端口默认是 `3350`，**前端端口和中台端口不是同一个**。
4. 通过仅服务端使用的 `AGENT_AUTOLOOP_LOCAL_CONFIG` 指定配置路径，验证本机会话网关可以连接中台，再打开浏览器。`owner` 留在 `Vite` 服务端，不发给浏览器、不写进网址，也不复制剪贴板。
5. 把本次新启动进程的日志和进程编号写入 `<数据目录>\logs\console`。端口被其他程序占用或鉴权失败时报告错误，不结束别人的进程。

**代码来源要分清：** 启动器新建中台进程时，运行当前仓库的 `bin\agent-autoloop.ts`，不是 `<数据目录>\app` 里的副本；前端也来自当前仓库。已有中台则直接复用，不会切换其代码。`node $AutoloopCli up` 和登录服务使用安装副本。源码与安装副本不一致时，不能把某个入口的运行结果当作另一份代码的验收结果。

`npm start` 对应 `TypeScript` 入口 `scripts/start-console.ts`，也可在仓库根目录直接运行 `node scripts/start-console.ts`。需要 `Node 24+`，启动器没有新增运行时依赖。它直接使用 `Windows node.exe` 启动中台及 `Vite`，不再使用独立的 `cmd` / `PowerShell` 启动包装脚本。安装器 `install.ps1`、登录服务和接单程序的相关功能仍会使用系统 `PowerShell`，不是整个系统不再调用它。

启动器不迁移 `WSL` 数据、不复制任何登录密钥，也不要求删除既有的 `Windows Codex` 配置。

**如何确认成功：** 终端显示“前后端已就绪”，浏览器打开上述地址。页面能打开只说明前端可访问，还需要下一步鉴权连接。

### 3.7 连接页面并核对在线状态

**这一步做什么：** 让操作台以本人身份读取中台状态，确认后台接单程序也已连接。

1. 打开启动器给出的本机页面，无需填写或复制本人密钥。
2. 点击唯一的“连接中台”按钮，查看轮次、卡片和事实时间线；连接后按钮切换为“断开连接”。
3. 回到已设置变量的 `PowerShell`，执行：

```powershell
node $AutoloopCli status
node $AutoloopCli doctor
```

**逐条解释：**

1. `status`：读取当前中台状态，查看谁在线、哪些轮次在跑、是否有待回答的问题。刚安装没有业务轮次是正常的。
2. `doctor`：检查规则、中台连接、接单程序、通道和本机 `Agent` 可用性。它不是一次真实业务执行，不能替代下一步的模型验收。

**手动启动时的预期提示：** 因为本指南使用了 `--no-service`，`doctor` 可能提示“系统服务没在跑”并以非零状态退出。如果中台能连接、接单程序在线，这一项只表示未配置登录服务，不代表手动启动失败；其他报错仍需逐项处理。只接桌面通知时，它还会提醒离开电脑后看不到通知，这也不等于中台故障。

本机页面只在内存持有短时随机会话；网关校验回环地址、`Host`、`Origin` 和路由白名单后，才向固定中台注入服务端保管的本人鉴权。点击“断开连接”会撤销会话、关闭 `SSE` 并清空页面，不会停止后台任务。刷新后重新点击连接即可，不需要 `owner`。

此方式只由本机启动器启用。手动 `npm --prefix frontend run dev`、静态或远程部署仍需在页面输入 `owner` 并使用固定代理；不要将本机网关作为匿名或公网入口。发送事件始终另填独立的来源密钥，不使用本人密钥或本机会话代替。现有中台 `/v1` 协议与权限不变。

**如何确认成功：** 页面可以读取中台状态，`status` 显示接单程序在线，`doctor` 没有尚未解决的连接或 `Agent` 可用性错误。到这里，启动步骤已完成，**尚未证明真实模型任务能够执行**。

### 3.8 （可选）验证一次真实问答

**这一步做什么：** 让真实 `Agent` 跑一次示例流程，验证派单、执行、提问和回答后的继续执行。

**这会消耗模型额度，也可能触发已配置通道的通知。只有明确同意真实模型验收后才执行，不要把它当作普通健康检查。**

```powershell
node $AutoloopCli try
```

按终端提示完成回答，再检查结果：

```powershell
node $AutoloopCli status
```

提问时当前轮次会结束，等待你回答不会阻塞 `Agent` 进程；回答后中台再启动后续轮次。不是让同一个进程一直挂着等你。

**如何确认成功：** 真实执行有回执，问题可以回答，回答后的后续轮次正常完成。若一直没有结果，先看 `status` 和对应轮次日志，不要反复执行 `try` 制造更多任务。

<a id="服务和日常启动"></a>

## 4. 服务和日常启动

### 4.1 已安装后，每次怎么启动

**默认数据目录：** 前端依赖已经安装时，在仓库根目录运行：

```powershell
Set-Location 'D:\github\agent-autoloop'
npm start
```

**自定义数据目录：** 必须在同一个终端先指定目录，再启动：

```powershell
$env:AGENT_AUTOLOOP_HOME = 'D:\agent-autoloop-data\dev'
Set-Location 'D:\github\agent-autoloop'
npm start
```

随后在本机页面点击“连接中台”，无需填写本人密钥。日常启动不需要重新安装中台、不需要重复初始化，也不需要每次运行 `npm --prefix frontend ci` 或 `try`。关闭浏览器不会停止后台进程，停止方式见[停止和故障排查](#停止和故障排查)。

### 4.2 可选：登录后后台运行

**用途：** 不打开操作台也让中台接单。使用首次安装步骤中的同一数据目录，并先按[停止和故障排查](#停止和故障排查)停稳手动启动的中台，再切换为登录服务，避免同一实例重复启动。

在已设置 `$AutoloopCli` 和 `AGENT_AUTOLOOP_HOME` 的终端执行：

```powershell
node $AutoloopCli service install
node $AutoloopCli doctor
```

`service install` 安装并启动当前用户的登录任务（`Task Scheduler`）；已有任务时也用于重启服务。它不是无人登录的系统服务：用户登录后运行，注销后停止，不需要管理员权限。内置管理员账号受 `UAC` 限制时，按安装器提示使用“启动”文件夹方案，不要为运行 `Agent` 提升权限。

**如何确认成功：** `doctor` 显示系统服务在跑、中台可连接、接单程序在线。登录任务只负责后台，不会自动启动流程操作台；需要页面时再运行 `npm start`，它会复用已有中台。

不再需要登录自启动时执行下面的命令；它会停止服务并移除登录项，不是启动步骤：

```powershell
node $AutoloopCli service remove
```

登录服务的日志在 `<数据目录>\logs\up.log`。首次安装也可以省略 `--no-service` 直接配置登录任务，但不需要在完成手动安装后重新安装一遍，使用上述 `service install` 即可。

### 4.3 可选：不打开操作台，只在终端运行

在已设置命令变量的终端执行：

```powershell
node $AutoloopCli up
```

它使用安装副本在前台运行中台、接单程序和已配置通道，需要保持该终端打开；不是再开一个交互式 `Codex`。不要在同一实例的后台中台或登录服务已运行时重复执行。另开终端查询状态时，要先重新设置同一实例的环境变量和 `$AutoloopCli`。

### 4.4 更换前端端口或不打开浏览器

在仓库根目录执行：

```powershell
npm start -- --frontend-port 5194 --no-browser
```

1. `--frontend-port 5194`：把页面端口改成 `5194`，不是修改中台端口。
2. `--no-browser`：不自动打开浏览器，之后手动访问启动器打印的地址。
3. `--no-clipboard`：仅为旧命令兼容保留，不产生作用；启动器已不再复制密钥。

直接运行入口时无需 `npm` 的参数分隔符：

```powershell
node scripts/start-console.ts --frontend-port 5194 --no-browser
node scripts/start-console.ts --help
```

`--help` 只显示启动参数；`npm start -- --help` 等效。

### 4.5 去哪里看启动日志

启动器日志目录是 `<数据目录>\logs\console`，默认即 `%USERPROFILE%\.agent-autoloop\logs\console`，自定义数据目录时随之改变。

| 文件                                 | 用途                                         |
| ------------------------------------ | -------------------------------------------- |
| `backend.log`、`backend.error.log`   | 启动器新建的中台进程输出与错误               |
| `frontend.log`、`frontend.error.log` | 启动器新建的前端进程输出与错误               |
| `backend.pid`、`frontend.pid`        | 本次新启动进程的编号，停止前必须核对进程身份 |

复用现有服务时不会覆盖对应的进程编号记录，也不会把该服务日志搬到这里。这些文件不是每轮 `Agent` 的执行日志；轮次日志见[多个 `Codex` 并发](#多个-codex-并发)。

<a id="多个-codex-并发"></a>

## 5. 多个 `Codex` 并发

**容量和规则是两个文件，不要合成一份配置。** 先在 `<数据目录>\config.json` 的现有 `worker` 对象中只调整 `capacity`，保留原来的 `name`、`key` 以及其他配置。下面是片段，不是完整替换文件：

```json
{
  "worker": {
    "name": "保留现有接单电脑名称",
    "key": "保留现有接单密钥",
    "capacity": 4
  }
}
```

再在 `<数据目录>\rules.json` 的 `rules` 数组中调整目标规则的 `parallel`。下面是单条规则示例；`my-source` 必须是已登记的来源，`codex` 必须是 `agents` 中已有且指向这台接单电脑的名称。保留自己的匹配条件、工作目录和可信任务指令，不要直接覆盖整份规则文件：

```json
{
  "name": "批量处理事项",
  "when": { "source": "my-source", "types": ["task.created"] },
  "to": "codex",
  "cwd": "D:/github/project",
  "prompt": "按本地任务手册处理资料中的事项。",
  "parallel": 4,
  "group": "batch"
}
```

1. `worker.capacity` 是这台接单电脑的总容量；`parallel` 是规则组的并发上限。
2. `parallel` 按事件的 `subject` 区分事项；同一事项仍串行，重复同一事件不会凭空产生并发。
3. 每轮的 `cwd` 使用 `Windows` 路径，例如 `D:/github/project` 或 `C:\\github\\project`；会话由中台按事项管理，不手工指定共享会话。
4. 不同事项的输出与会话分开，不代表项目文件已隔离。多个 `Codex` 共用同一 `cwd` 仍可能同时修改同一文件；需要并行写代码时，为各事项配置独立项目目录或 `Git worktree`。接单程序不会自动创建或隔离项目工作树，`capacity` 也不会防止文件冲突。
5. 每轮输出在 `<数据目录>\worker\runs\<run>-<attempt>\` 的 `stdout-*.log`、`stderr-*.log`，按需本地查看，不公开其中的资料或凭据。

改规则后运行 `node $AutoloopCli check`，通过后等待规则自动生效。改 `config.json` 后需重启接单程序：登录服务使用 `node $AutoloopCli service install`；手动启动的实例先按下一节停稳，再用原来的入口重新启动。仅重开浏览器或再次运行 `npm start` 不会重启已被复用的中台。

真实并发验收先用两个不同事项核对，再考虑提高容量；后台并发会增加模型额度、磁盘和 `CPU` 使用量，不会弹出多个交互窗口。

<a id="停止和故障排查"></a>

## 6. 停止和故障排查

先停止轮次，不要直接杀中台进程：

```powershell
node $AutoloopCli stop <轮次编号>
node $AutoloopCli status
```

停止请求被接收不等于进程已退出。等轮次最终为 `cancelled`，确认没有正在执行的轮次，再停止中台。退出 `up` 本身不等于停止 `Agent` 子进程。

手动运行的服务在原终端按 `Ctrl+C`；登录服务先用 `service remove` 停止并移除登录项，避免自动重启。启动器后台启动的前后端可按 `<数据目录>\logs\console` 中的 `PID` 记录定位：先用 `Get-CimInstance Win32_Process -Filter "ProcessId = <PID>"` 核对命令行和本实例路径，确认仍是自己的进程后才用 `Stop-Process -Id <PID>`。`PID` 可能过期或被复用，不能只凭记录盲杀；复用的现有服务不属于本次启动的进程，不按新进程处理。关闭浏览器不会停止前后端。

| 现象                         | 处理                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 找不到 `codex`               | `where.exe codex` 检查 `Windows PATH`，确认不是 `WSL` 路径                                                                                               |
| 版本命令通过但执行失败       | 在同一用户会话中检查登录、权限及轮次日志；版本号不能证明已登录                                                                                           |
| `npm start` 提示没有配置     | 先运行安装器，或在同一终端设置正确的 `AGENT_AUTOLOOP_HOME`                                                                                               |
| 找不到 `agent-autoloop` 命令 | 自定义目录安装不加 `PATH`；用 `node $AutoloopCli` 或安装器打印的完整命令                                                                                 |
| 前端依赖缺失                 | 在 `Windows` 执行 `npm --prefix frontend ci`，不要复用 `WSL node_modules`                                                                                |
| 端口被占用                   | 前端换 `--frontend-port`；中台需同步修改 `config.json` 的 `url`、`hub.listen`，本机卡片地址 `hub.publicUrl` 也要对应，再停稳并重启前后端，不结束别人的进程 |
| `doctor` 提示系统服务没在跑  | 手动启动时先核对中台可连接、接单程序在线；需要登录自启动才运行 `service install`                                                                         |
| 关闭页面后后台仍在运行       | 属于正常行为；按本节步骤先停轮次，再停对应后台进程                                                                                                       |
| 中台已运行但无法连接         | 用 `doctor` 和 `logs\console` 核对实例、密钥及代理目标，不盲目重复启动                                                                                   |
| 登录任务安装失败             | 使用普通用户；内置管理员账号按安装器提示改用“启动”文件夹                                                                                                 |
| `listen EACCES`              | 用 `netsh int ipv4 show excludedportrange protocol=tcp` 检查保留端口，再换中台端口                                                                       |

## 7. 更新、备份和卸载

先确认轮次收尾、停止本次前后端，再按需备份、更新并重新启动：

```powershell
node $AutoloopCli backup D:\agent-autoloop-backups\before-update
node $AutoloopCli update
node $AutoloopCli doctor
```

本地仓库安装的更新跟随原安装来源，不自动改成其他仓库或未提交文件。卸载默认保留规则、密钥、数据库和运行记录：

```powershell
node $AutoloopCli uninstall
```

`WSL` 与原生 `Windows` 是独立环境，**没有自动迁移**。切换前停止旧实例并分别备份；不要共用数据库或运行目录。`Node`、`Agent` 登录、`CODEX_HOME` 和前端依赖分别维护，不复制秘密文件，不必删除原来的 `Windows Codex` 配置。

## 8. 验证清单（不是本次通过记录）

开发者可按改动范围执行仓库检查，不需要安装真实登录服务或调用模型：

```powershell
npm ci
npm run typecheck
npm run format:check
npm run test:windows
node scripts/install-smoke-windows.ts

npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run format:check
```

真实本机验收另行记录环境、命令和结果，至少核对安装、登录服务、前端连接、真实问答、不同事项并发、取消及接单程序重启恢复。真实模型、通知或交付测试只在得到明确授权后运行；本文没有声称这些检查已通过。
