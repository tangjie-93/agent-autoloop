# `Agent Autoloop` 二次开发导览

> 面向第一次接手的程序员；本文介绍调用链、状态和扩展点，不替代[原生 Windows 部署](windows-native-deployment.md)或 [WSL2 备用部署](wsl2-deployment.md)。历史验证数字不作为当前版本的通过证明。 [文档索引](../README.md)。

按“理解一轮 → 本地跑通 → 跟调用链 → 找扩展点”的顺序读。源码链接相对本文所在的 `docs/local/`，函数名用于定位，避免行号随修改失效。

## 1. 先理解：它替你管理的是事项，不只是启动命令

它把外部事件交给本机或其他电脑上的命令行 `Agent`，负责排队、并发、失败重派、记录结果和向人提问。`Agent` 每次只执行一轮；需要人决定时交回问题并退出，回答到达后再启动一轮。中台和接单程序仍常驻，等待期间没有执行该问题的 `Agent` 进程。

从程序角度看，核心是“确定性决策 + 事实日志 + 主动连接中台的插件”。内核仅提供无需脚本的卡片回答表单；本分支另有独立的 `Vue 3` [流程操作台](../../frontend/README.md)，通过现有协议连接中台。本文主要介绍后端调用链，部署入口见[原生 Windows 部署](windows-native-deployment.md)。证据：[host/up.ts](../../host/up.ts) 的 `up()`、[kernel/decide.ts](../../kernel/decide.ts) 的 `finish()` / `answer()`、[kernel/card-page.ts](../../kernel/card-page.ts)。

### 1.1 一个完整场景：线上告警，需要本人决定是否重启

仓库已有[告警场景规则](../../examples/recipes/ops-alerts/rules.json)和[任务手册](../../examples/recipes/ops-alerts/SKILL.md)，可以把整个闭环具体化：

1. 业务系统用来源 `shop` 的密钥提交 `alert.error`，`subject` 为 `checkout`，详情附调用栈。事件编号稳定，重发不重复入账。
2. “查线上报错”规则匹配它，选择固定的接单电脑、`Agent`、代码目录和只读权限。规则配置 `parallel: 3`，因此不同对象可并行，同一对象仍串行。
3. 接单程序领取任务，将外部文字写入资料文件；`Agent` 读资料及本地代码，判断需要重启，输出 `ask`，`about` 写清回答后做什么，随后结束。
4. 已配置的通知通道领取问题卡片并发给本人；也可以直接用命令行查看、回答。示例规则本身不配置通道，需要合入本机配置。
5. 本人选择“重启”，回答生成 `card.answered` 事件，回到原事项。新进程拿到 `context.answers`，尽量续接提问时的会话。
6. `Agent` 核对回答后交回 `restart` 事件；来源强制取规则的 `emits.source = shop-fix`。另一条规则把它交给固定重启脚本，`tell: always` 把结果通知本人。

这个场景的 [restart.sh](../../examples/recipes/ops-alerts/restart.sh) **目前只打印占位文字**，不能理解为已经实现生产重启。是否取得同意由任务手册要求 `Agent` 核对；`emits` 只限制可发来源和类型，不是对“本人已授权”的强制审批。实际重启和健康核实需由可信脚本实现。原场景说明也要求不给 `shop-fix` 创建外部来源密钥。

### 1.2 三个容易混淆的状态

| 概念     | 源码中的含义                                                                          | 二次开发时的影响                                                                           |
| -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 事项     | `enqueue()` 使用规则名和 `lane` 归类；配置 `parallel` 才令 `lane = subject`，否则为空 | 默认是整条规则一个事项，不是每个 `subject` 自动独立                                        |
| 一轮     | 领取一批事件、执行、提交一次结果；失败可以重试同一轮                                  | `done` 表示本轮结束，不保证整个事项完结；人工阻塞用 `done + ask`，不应用 `failed` 不断重跑 |
| 提问卡片 | 等回答时 `open`；答后 `decided`；承载回答的后续轮成功应用回执后 `done`                | 不是把原轮次置为一个不存在的 `waiting` 状态；普通通知和主动结案有不同路径                  |

证据：[kernel/decide.ts](../../kernel/decide.ts) 的 `enqueue()`、`applyReceipt()`、`answer()`；[tests/cards.test.ts](../../tests/cards.test.ts) 的回答、重试和回填结果测试。

## 2. 先从源码跑通，再接真实模型

### 2.1 技术栈与启动入口

运行环境是 `Node >=24`、`TypeScript`、`ESM`，直接执行 `.ts`；`node:sqlite` 提供持久化，`node:test` 运行测试。后端没有运行时依赖，也没有需要先执行的构建命令；独立前端的依赖和构建由 `frontend/package.json` 管理。开发依赖只有类型声明、`TypeScript` 和 `Prettier`。证据：[package.json](../../package.json) 的 `engines` / `scripts` / `devDependencies`、[tsconfig.json](../../tsconfig.json) 的 `noEmit` / `erasableSyntaxOnly`。

```text
bin/agent-autoloop.ts
  → cli/main.ts：解析命令，init / up / emit / answer / status …
  → host/up.ts：按 config.json 启动中台、接单程序、通道
      中台：host/http.ts serve → host/server.ts makeHandler → kernel/http.ts createHandler
      接单：worker/worker.ts createWorker → run → tick
      通道：keepChannelRunning → loadChannel → 插件默认导出函数
```

一台电脑运行 `up` 时，这几部分在同一个 `Node` 进程里，互相仍走 `HTTP`；具体 `Agent` 是独立子进程。只配置 `worker` 的电脑只接活，不启动本地中台。证据：[bin/agent-autoloop.ts](../../bin/agent-autoloop.ts)、[cli/main.ts](../../cli/main.ts) 的命令分派、[host/up.ts](../../host/up.ts) 的 `up()`。

### 2.2 最短的自动闭环验证

在仓库根目录运行：

```bash
node --version
npm ci
node --disable-warning=ExperimentalWarning --test tests/loop.test.ts
```

这条测试真实启动 `init → up`，发送事件、等待问题、从命令行回答，再检查续办结果。模型用脚本替代，桌面通知用假命令替代；使用临时数据目录和随机端口，结束清理。它验证中台闭环，不证明外部模型真的支持会话续接。证据：[tests/loop.test.ts](../../tests/loop.test.ts) 的 `one machine, one command` 测试。

### 2.3 手动启动一个可调试的开发实例

以下是在 `macOS` / `Linux bash` 中的源码调试示例；原生 `Windows` 安装和启动见[部署指南](windows-native-deployment.md)。整个演示不调用模型、不发送真实通知。专用临时目录避免碰到正在使用的中台；清掉另外两个路径变量，避免继承其他实例的规则和地址。

````bash
export AGENT_AUTOLOOP_HOME="$(mktemp -d /tmp/autoloop-dev.XXXXXX)"
unset AGENT_AUTOLOOP_RULES AGENT_AUTOLOOP_PUBLIC_URL
mkdir -p "$AGENT_AUTOLOOP_HOME/fake-bin"
for cmd in osascript notify-send; do
  printf '#!/bin/sh\nexit 0\n' > "$AGENT_AUTOLOOP_HOME/fake-bin/$cmd"
  chmod +x "$AGENT_AUTOLOOP_HOME/fake-bin/$cmd"
done
export PATH="$AGENT_AUTOLOOP_HOME/fake-bin:$PATH"

cat > "$AGENT_AUTOLOOP_HOME/demo.mjs" <<'JS'
import { readFileSync } from 'node:fs';
const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, 'utf8'));
if (context.answers.length) {
  console.log('已收到回答，开发闭环完成');
} else {
  console.log('等你选一个颜色');
  console.log('```agent-autoloop\n' + JSON.stringify({
    ask: [{ title: '选一个颜色', text: '仅验证开发闭环，选哪个都可以。', options: ['蓝色', '绿色'], key: 'color',
      about: '收到回答后只确认完成，不重复提问' }]
  }) + '\n```');
}
JS

dev_port=$(node --input-type=module -e '
import { createServer } from "node:net";
const s = createServer();
s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });
')
node bin/agent-autoloop.ts init --no-service --port "$dev_port" \
  --command "node $AGENT_AUTOLOOP_HOME/demo.mjs"
# This demo does not exercise desktop notifications.
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
for (const name of ["config.json", "rules.json"]) {
  const path = process.env.AGENT_AUTOLOOP_HOME + "/" + name;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.channels) delete value.channels.desktop;
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
'
node bin/agent-autoloop.ts check
printf '开发数据目录：%s\n' "$AGENT_AUTOLOOP_HOME"
node bin/agent-autoloop.ts up
````

在仓库根目录另开终端乙，把下面目录换成终端甲打印的值：

```bash
export AGENT_AUTOLOOP_HOME=/tmp/autoloop-dev.替换成实际目录
unset AGENT_AUTOLOOP_RULES AGENT_AUTOLOOP_PUBLIC_URL
node bin/agent-autoloop.ts rules explain
node bin/agent-autoloop.ts emit try.start --subject demo --dry-run
node bin/agent-autoloop.ts emit try.start --subject demo --id onboarding-1
node bin/agent-autoloop.ts status
# 等 status 出现卡片，把 CARD_ID 换成实际卡片编号；2 表示第二项。
node bin/agent-autoloop.ts answer CARD_ID 2
node bin/agent-autoloop.ts status --json
# 把 RUN_ID 换成 status 中的轮次编号，分别看提问轮与回答轮。
node bin/agent-autoloop.ts why RUN_ID
node bin/agent-autoloop.ts why RUN_ID --json
```

预期看到两轮执行，最终摘要为“已收到回答，开发闭环完成”，卡片不再等待回答。`status` 是快照，必要时再查一次。重复发送相同 `--id` 不会再派任务。这里的 `command` 没有会话能力，恢复依靠资料文件；真实会话续接需单独接专用插件验证。

这组命令来自 [cli/main.ts](../../cli/main.ts) 的 `init()` / `starterRules()` / `emit()` / `answer()`，演示脚本使用 [worker/worker.ts](../../worker/worker.ts) 的 `agentEnvironment()` 和 [worker/contract.ts](../../worker/contract.ts) 的回执约定。`--no-service` 很重要：它不注册系统后台服务。新实例的默认规则只匹配 `try.*`。

需要真实模型时，在另一个临时目录用 `init --agent codex --no-service`（或 `claude`），先安装并登录该工具，再运行 `up` 和 `try`；这会真正调用模型。不要把上面的模拟脚本通过当成真实模型验证通过。

### 2.4 调试位置与退出方式

| 想知道什么                 | 首选入口 / 断点                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事件会不会匹配             | `rules explain`、`emit --dry-run`；[cli/explain.ts](../../cli/explain.ts) 的 `previewEvent()`                                                                                                         |
| 为什么排队或派给这个程序   | `why RUN_ID --json`；[kernel/decide.ts](../../kernel/decide.ts) 的 `ingest()` / `enqueue()` / `claimNext()`                                                                                           |
| 实际提示词、资料和执行输出 | `$AGENT_AUTOLOOP_HOME/worker/runs/<run>-<attempt>/` 下的 `entry.json`、`context.json`、`stdout-*.log`、`stderr-*.log`；[worker/worker.ts](../../worker/worker.ts) 的 `save()` / `start()` / `files()` |
| 最后一条消息为何没生效     | `conclude()` → `readMessage()` → `resultFrom()`；再看 `settle()` 的拒绝或网络日志                                                                                                                  |
| 规则变更为何没生效         | [host/runtime.ts](../../host/runtime.ts) 的 `reloadRules()` / `tick()`；旧规则会保留，错误另发卡片                                                                                                    |
| 想看事实流                 | 本人密钥访问 `GET /v1/stream?after=0`；[host/server.ts](../../host/server.ts) 的 `logStream()`，与 `why` 一样不直接读取业务私有表                                                                     |

用调试器启动时，将终端甲最后一条命令替换为 `node --inspect-brk bin/agent-autoloop.ts up`，再用支持 `Node` 的调试器附加。只在临时实例调试：断点暂停会同时阻塞同进程的中台、接单和通道。源码由 `Node` 直接执行，编辑 `.ts` 后需要重启；规则文件由 `host/server.ts` 监视，合法变更自动载入，`config.json`、`secrets.env` 和插件修改则重启生效。

**退出 `up` 不等于停止正在干活的 `Agent`。** 外壳退出刻意保留分离的子进程，接单程序重启后接管。要取消执行，先 `node bin/agent-autoloop.ts stop RUN_ID`，等状态确认停止，再在终端甲按 `Ctrl+C`。确认没有在跑的轮次后才能删除本次临时目录。`entry.json` 在结果确认提交后删除，输出保留约 `14` 天；它含轮次凭据，不要作为调试附件公开。证据：[host/up.ts](../../host/up.ts) 的 `finish()`、[worker/worker.ts](../../worker/worker.ts) 的 `launch()` / `stop()` / `settle()` / `tidy()`。

## 3. 核心调用链：按这个顺序下断点

```text
来源 POST /v1/events
  → HTTP 身份与输入校验 → execute → commitLatest → decide.ingest
  → 规则匹配 → enqueue：事项里的 queued 轮次
接单程序 GET /v1/work
  → heartbeat + claimNext → jobOf
  → start → context.json + promptFor → launch → adapter.command
  → adapter.read → conclude → readMessage/resultFrom → 保存结果
  → POST /v1/runs/:id/result → finish → applyReceipt → createCard
通道 GET /v1/cards/next → 发消息 → POST .../delivered
用户 POST /v1/cards/:id/answer
  → answer → card.answered → enqueue 原事项
  → 下一次领取 → 新 Agent 进程，尽量续接原会话 → 回执 → 卡片 done
```

### 3.1 事件进入、规则匹配、事务提交

[host/http.ts](../../host/http.ts) 的 `serve()` 只负责把 `Node` 请求转换为标准 `Request`；[host/server.ts](../../host/server.ts) 的 `makeHandler()` 注入时钟、视图、提交、等待和插件适配能力；接口行为在 [kernel/http.ts](../../kernel/http.ts) 的 `route()` / `createHandler()`。

`POST /v1/events` 先用 `requireKey(..., "source")` 确定来源，再把正文交给 `ingest()`。`parseEvent()` 拒绝能改变执行范围的字段，`summary` / `detail` 是资料。`ingest()` 按 `(source, id)` 去重，逐条匹配 `when.source` 与 `typeMatches()`；类型支持精确值、`*`、末尾 `.*`。匹配多条规则可以产生多份工作，没有规则接也保留事件。证据：[protocol/validate.ts](../../protocol/validate.ts) 的 `parseEvent()`、[kernel/rules.ts](../../kernel/rules.ts) 的 `typeMatches()`、[tests/events.test.ts](../../tests/events.test.ts)。

`enqueue()` 把新事件并入同事项已经排队的轮次；已经领取的轮次不吸收新事件。失败等待重试时，期间来的同事项事件也应合入重试。领取时再采用最新可信规则，已经领取的任务保留自己的配置快照。证据：[kernel/decide.ts](../../kernel/decide.ts) 的 `enqueue()` / `assignQueued()` / `retryLater()` / `claimNext()`。

每次变更都经过 [host/runtime.ts](../../host/runtime.ts) 的 `execute()` → [kernel/store.ts](../../kernel/store.ts) 的 `commitLatest()` / `commit()` → `decide()` → [kernel/evolve.ts](../../kernel/evolve.ts) 的 `evolve()`。判断在持写锁后的最新视图上进行；日志追加和投影更新在同一个事务里，提交后才应答和唤醒长轮询。事实格式是 `{ version, seq, at, type, changes }`，`type` 如 `ingest`、`finish`、`answer`；不要把业务事件 `card.answered` 误当成另一套日志类型。

### 3.2 领取任务与实际执行

[worker/worker.ts](../../worker/worker.ts) 的 `tick()` 先检查已有进程、提交完成结果，再调用 [protocol/client.ts](../../protocol/client.ts) 的 `hub.work()`。`GET /v1/work` 同时携带 `claim`、`running`、可领取容量，既领活也报心跳、查取消；空闲时长轮询。

[kernel/http.ts](../../kernel/http.ts) 的 `work()` → [kernel/decide.ts](../../kernel/decide.ts) 的 `claimNext()` 检查接单电脑、重试时间、组并发与事项互斥，再由 [kernel/query.ts](../../kernel/query.ts) 的 `jobOf()` 生成 [Job](../../protocol/job.ts)。响应丢失用同一个 `claim` 可拿回同一任务；重新领取会重新签发本次执行的令牌，不应复用旧令牌。

`start()` 先保存领取记录，再写私有 `context.json`、调用 `adapterFor()` 和 `promptFor()`，最后 `launch()` 启动独立进程组。可信规则给出目录、权限、提示词和插件；外部正文、回答内容放在资料文件中。提示词里仍有经过校验的事件类型、对象、链接等元数据，不能笼统说“提示词完全不含事件”。证据：[worker/contract.ts](../../worker/contract.ts) 的 `promptFor()`、[worker/agents.ts](../../worker/agents.ts) 的 `Adapter`、[tests/worker.test.ts](../../tests/worker.test.ts) 的资料隔离测试。

### 3.3 读取回执、结束一轮、生成卡片

`adapter.read(stdout, code, stderr)` 解析具体程序输出；`conclude()` 用 `readMessage()` 识别第一行结论和末尾的 `agent-autoloop` 代码块，再用 `resultFrom()` 校验结构。`endWith()` 先把结果写入本地记录，`settle()` 才调用 `hub.result()`，网络或服务端错误会保留结果供再次提交，明确拒绝则记录原因并移除待交记录。证据：[worker/worker.ts](../../worker/worker.ts)、[worker/contract.ts](../../worker/contract.ts)。

`POST /v1/runs/:id/result` → `finish()` 验证轮次令牌和重复提交，完全相同的结果可重放，不同内容冲突；成功结果由 `applyReceipt()` 一次应用 `ask`、`notice`、`resolve`、`later`、`events`。提问经 `cardFromReceipt()` → `createCard()` 保存事项、会话、`about` 和传播深度；同事项尚未关闭的同 `key` 问题不重复创建。证据：[kernel/decide.ts](../../kernel/decide.ts) 的这些函数、[tests/runs.test.ts](../../tests/runs.test.ts)、[tests/cards.test.ts](../../tests/cards.test.ts)。

回执格式错时，只在已知会话里要求重写最后一条消息，最多 `2` 次，不重做业务；无会话或修复失败则保留原业务结局、作废回执并通知。普通执行失败则走中台重试：从 `5` 分钟起翻倍，最长 `1` 小时，第 `3` 次通知，第 `10` 次停止。两种失败不能混为一谈。证据：`conclude()` / `discardReceipt()`、`retryLater()`，以及 [tests/worker.test.ts](../../tests/worker.test.ts) 的回执修复测试。

### 3.4 通道投递、用户回答、恢复执行

通道插件通过 `hub.nextCard()` → `GET /v1/cards/next` → 内核 `nextCard()` 领取卡片。`ref` 为空时发新消息，否则更新原消息；随后必须报告 `delivered(id, version, ref)` 或 `failed(...)`。不是内核主动调用聊天平台。证据：[host/channels.ts](../../host/channels.ts)、[examples/plugins/hello-channel/channel.ts](../../examples/plugins/hello-channel/channel.ts)。

命令行和通道回答进入 `POST /v1/cards/:id/answer` → `cardAction()` → `answer()`。本人密钥与通道密钥走不同身份路径；通道回答检查 `by` 是否在已配置的 `answerers` 内，并核对原消息 `ref`。**没有配置 `answerers` 时不会限制回答人**。命令行选项从 `1` 开始，传入协议的 `choice` 从 `0` 开始。链接表单另走 `POST /c/:token` → `cardAtLink()`，依靠卡片能力令牌，最终同样调用内核 `answer()`；打开页面的 `GET` 只渲染，不算回答。证据：[cli/main.ts](../../cli/main.ts) 的 `answer()`、[kernel/http.ts](../../kernel/http.ts) 的 `cardAction()` / `cardAtLink()`、[kernel/decide.ts](../../kernel/decide.ts) 的 `answer()`。

首次有效回答把提问卡片改为 `decided`，生成 `card.answered`，**直接 `enqueue` 原规则、原 `lane`**，不再拿这个事件匹配所有规则。`jobOf()` 把回答、选项及 `about` 放入下一轮的 `context.answers`；领取后启动新的进程，尽量续接提问会话。处理该回答的轮次成功应用回执后，原卡片变为 `done` 并写入结果。重复回答不会再唤醒一次，主动结案与回答互斥。证据：[tests/cards.test.ts](../../tests/cards.test.ts) 的原事项恢复、重复回答和结案测试。

“恢复”不保证必然使用旧会话：换了 `Agent`、会话正在被别的轮次占用或无法续接时会开新会话，但回答资料仍保留。插件报告 `started: true` 后再失败，不能换新会话重做，应保留会话交失败，由中台重派。普通新事件默认新会话，规则 `resume: true` 才沿用同事项之前的会话；回答和复查有自己的续接来源。证据：[kernel/decide.ts](../../kernel/decide.ts) 的 `settleSession()`、[worker/worker.ts](../../worker/worker.ts) 的 `conclude()`、[tests/resume-thread.test.ts](../../tests/resume-thread.test.ts)。

## 4. 找扩展点：优先改插件和配置

### 4.1 目录职责与配置边界

| 位置                                                                                                                                                                                     | 负责什么 / 什么改动来这里                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [kernel/decide.ts](../../kernel/decide.ts)、[kernel/query.ts](../../kernel/query.ts)                                                                                                           | 调度、状态变化和任务视图；新增产品适配不来这里                     |
| [kernel/store.ts](../../kernel/store.ts)、[kernel/evolve.ts](../../kernel/evolve.ts)、[kernel/due.ts](../../kernel/due.ts)                                                                        | 日志、投影、到期机制；不能绕日志直接改业务表                       |
| [host/up.ts](../../host/up.ts)、[host/runtime.ts](../../host/runtime.ts)、[host/server.ts](../../host/server.ts)                                                                                  | 运行装配、数据库连接、时钟、规则热加载、长轮询、外壳资源           |
| [protocol/schema.json](../../protocol/schema.json)、[protocol/validate.ts](../../protocol/validate.ts)、[protocol/rules.ts](../../protocol/rules.ts)、[protocol/client.ts](../../protocol/client.ts) | 对外格式、输入与规则校验、客户端；接口变更需一起核对协议与兼容     |
| [worker/worker.ts](../../worker/worker.ts)、[worker/contract.ts](../../worker/contract.ts)、[worker/agents.ts](../../worker/agents.ts)                                                            | 进程生命周期、资料与提示词、回执、插件接口；产品输出格式仍归插件   |
| [cli/main.ts](../../cli/main.ts) 与 `cli/`                                                                                                                                                  | 用户命令、排查、回答、`MCP` 等客户端能力                           |
| `plugins/`、`examples/plugins/`、`examples/recipes/`                                                                                                                                     | 产品实现、最小可运行模板、业务规则与任务手册；交付流程也是普通插件 |
| `tests/`、`sim/`、`scripts/`                                                                                                                                                             | 行为规格、故障模拟、穷举、强杀、变异、性能和真机脚本               |

运行文件默认放在 `~/.agent-autoloop`，开发时用 `AGENT_AUTOLOOP_HOME` 覆盖，规则另可由 `AGENT_AUTOLOOP_RULES` 指定。见 [host/home.ts](../../host/home.ts)。

| 文件                   | 负责什么                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `rules.json`           | 可信业务规则：来源、目标 `Agent`、接单电脑、工作目录、权限、并发、通知和回执事件许可                     |
| `config.json`          | 本机角色、中台地址、接单容量、通道启动选项和访问密钥；见 [host/config.ts](../../host/config.ts) 的 `Config` |
| `secrets.env`          | 来源验签等插件秘密；由 `loadSecrets()` 读取                                                              |
| `hub.db`、`master.key` | 权威事实日志与可重建投影、能力令牌签名材料；见 [host/runtime.ts](../../host/runtime.ts) 的初始化            |

### 4.2 三种插件分别怎么加

统一入口是 `plugins/<名字>/{source,agent,channel}.ts`，默认导出。加载器 [host/plugins.ts](../../host/plugins.ts) 的 `loadPlugin()` **先找安装目录，再找内置目录**；第三方插件用 `add <git 地址>` 克隆，仓库根直接放入口文件。插件名只用小写字母开头、小写字母数字和连字符。不要另加注册表或发现路径，也不要忘记检查安装目录的同名插件是否遮住正在改的内置插件。

| 目标       | 最小改动                                                                                                                                         | 真实接口与关键约束                                                                                                                                                                                                 | 验证入口                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新事件来源 | 能发标准事件就登记 `sources`、创建来源密钥，直接 `POST /v1/events`；第三方 `Webhook` 才加 `source.ts`，配置 `sources.<id>.adapter` 和规则 `when` | 默认导出同步 `({ headers, body, secret }) => Event[]`；先验原始正文签名，再翻译，不能联网；`async` 返回值不会被当作事件数组。密钥在 `secrets.env` 的 `AGENT_AUTOLOOP_SECRET_<来源大写>`，连字符改下划线            | [hello-source](../../examples/plugins/hello-source/source.ts)、[host/server.ts](../../host/server.ts) 的 `adaptWebhook()`、[tests/example-plugins.test.ts](../../tests/example-plugins.test.ts)                              |
| 新 `Agent` | 只需最终文本先用 `use: command` 和参数数组；要会话、专用权限或用量才加 `agent.ts`。规则 `agents.<id>.use` 选插件，`to` 选这个配置项              | `command(turn): string[]`；`read(stdout, code, stderr): Reading`；可选 `link()`、`check()`。运行中 `code=null`；`started` 表示真正接收本轮提示词，`finished` 表示真正完成；返回 `session` 就必须实现 `turn.resume` | [hello-agent](../../examples/plugins/hello-agent/agent.ts)、[worker/agents.ts](../../worker/agents.ts) 的 `Adapter`、[tests/adapters.test.ts](../../tests/adapters.test.ts)、[tests/worker.test.ts](../../tests/worker.test.ts) |
| 新通知通道 | 加 `channel.ts`；在规则登记通道，创建通道密钥，在 `config.json.channels.<id>` 填 `use`、`key` 和平台选项，重启启用                               | 默认导出异步常驻函数 `({ hub, options, log, signal })`；轮询、发送/更新、报告、转交回答。支持回调就设置 `answerers` 并带 `by/ref`，文字通道设置 `links: true` 并发送 `card.link`                                   | [hello-channel](../../examples/plugins/hello-channel/channel.ts)、[host/channels.ts](../../host/channels.ts) 的 `ChannelContext`、[tests/channels.test.ts](../../tests/channels.test.ts)                                     |

插件需要注意的共同边界：

- 第三方目录独立安装，只引用 `node:` 和自己目录文件，类型在本插件声明；不要相对导入引擎内部路径。内置插件随引擎一起发布才可复用内部工具。见[插件开发说明](../plugins.md)。
- 轮询来源不放进同步 `source.ts`：用定时规则启动脚本，以回执 `events` 交回事件，并配 `emits`；稳定编号交给中台去重。不要在插件里再做一套队列、重试与并发。见 [plugins/delivery/poll.ts](../../plugins/delivery/poll.ts) 和[协议的来源约定](../protocol.md#来源把世界变成事件)。
- 通道与中台同进程，外部调用异步等待，响应 `signal` 停止；提前返回或抛错会由外壳在 `30` 秒后重启。见 [host/up.ts](../../host/up.ts) 的 `keepRunning()`。
- `usage` 表示本次用量，`sessionUsage` 表示累计会话用量，由接单程序做差；不要混用。`command` 不提供会话或系统权限沙箱。见 [worker/usage.ts](../../worker/usage.ts)、[plugins/command/agent.ts](../../plugins/command/agent.ts)。

`Webhook` 的实际接收地址是 `POST /v1/in/<source>`，其中 `source` 是规则里的来源标识，不是适配器名。标准事件来源和通道的密钥可分别用 `node bin/agent-autoloop.ts key new source 来源标识`、`node bin/agent-autoloop.ts key new channel 通道标识` 创建；在中台所在电脑、对应的 `AGENT_AUTOLOOP_HOME` 下执行，妥善保存输出，不写入仓库。证据：[kernel/http.ts](../../kernel/http.ts) 的 `webhook()`、[cli/main.ts](../../cli/main.ts) 的 `key()`。

## 5. 验证方法：先按行为选测试，再决定范围

不要为了适应实现改掉既有测试预期。新增逻辑先写它防的失败方式；修缺陷先写失败复现。测试环境在导入 `host/runtime.ts` **之前**设置，因为导入就会打开数据库、读取规则。参考 [tests/helpers.ts](../../tests/helpers.ts) 的 `setup()` 和 [tests/hub.ts](../../tests/hub.ts)。

| 改了什么               | 最先看的行为测试                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事件、匹配和排队       | [events.test.ts](../../tests/events.test.ts)、[schedule.test.ts](../../tests/schedule.test.ts)、[rules.test.ts](../../tests/rules.test.ts)                             |
| 回答、卡片、续接       | [cards.test.ts](../../tests/cards.test.ts)、[resume-thread.test.ts](../../tests/resume-thread.test.ts)、[loop.test.ts](../../tests/loop.test.ts)                       |
| 进程、回执、停止和重启 | [worker.test.ts](../../tests/worker.test.ts)、[contract.test.ts](../../tests/contract.test.ts)、[stops-and-threads.test.ts](../../tests/stops-and-threads.test.ts)     |
| 插件安装和协议接入     | [example-plugins.test.ts](../../tests/example-plugins.test.ts)、[conformance.test.ts](../../tests/conformance.test.ts)                                              |
| 持久化和模块边界       | [projection.test.ts](../../tests/projection.test.ts)、[concurrent-writes.test.ts](../../tests/concurrent-writes.test.ts)、[purity.test.ts](../../tests/purity.test.ts) |

```bash
# 三种插件安装后走真实临时中台，使用假业务程序。
node --disable-warning=ExperimentalWarning --test \
  --test-name-pattern='agent-autoloop add' tests/example-plugins.test.ts

# 单独验证 HTTP 协议。
node --disable-warning=ExperimentalWarning --test tests/conformance.test.ts

# 未改 kernel/、protocol/、sim/ 时的日常检查。
npm run test:quick
npm run typecheck
npm run format:check

# 涉及核心行为：完整行为测试 + 20 万步固定种子模拟 + 有界穷举。
npm test
# 涉及日志、到期表或并发时再执行。
npm run test:nightly
```

命令以 [package.json](../../package.json) 为准：`test:quick` 只跳过 `tests/simulation.test.ts`；`test:sim` 单独跑 `2` 万步；`test:nightly` 是 `test:deep` 加性能记录，**它本身不包含 `npm test` 的长模拟和穷举**。每日工作流在非拉取请求场景下额外执行 `npm test`，不能把本地同名命令当成完整工作流。`format:check` 只覆盖 `.ts/.json/.yml`，`Markdown` 要另做排版和链接检查。证据：[tests/simulation.test.ts](../../tests/simulation.test.ts)、[nightly.yml](../../.github/workflows/nightly.yml)。

持续集成由 [scripts/ci-scope.sh](../../scripts/ci-scope.sh) 分范围：普通代码拉取请求跑快速测试；内核、协议等再加短模拟；模拟测试与穷举实现改动跑完整检查；不被测试读取的纯文档拉取请求可跳过。`main` 推送仍跑快速测试和安装冒烟。若新增测试读取某份文档，要同步调整分流脚本。见 [check.yml](../../.github/workflows/check.yml)。

安装验证使用 `sh scripts/install-smoke.sh`，它装的是**已提交代码**，不能证明未提交改动可安装。真实程序验证入口是 `scripts/real-agents.ts`、`scripts/real-protocols.ts`；真实交付 `scripts/delivery-e2e.ts` 会创建、删除指定私有测试仓库，只有明确要求时才执行。日常测试不得用在线飞书应用另开监听，不发真消息、不弹真实桌面通知。证据：[AGENTS.md](../../AGENTS.md) 的“验证范围”和对应脚本。

## 6. 推荐阅读顺序与不可越过的边界

### 6.1 按开发目标读，先不用逐文件扫

1. [协议](../protocol.md) 的“六个词”“规则”“`Agent`”“通道”，对照 [tests/loop.test.ts](../../tests/loop.test.ts)：先建立一个可运行的完整场景。
2. [protocol/client.ts](../../protocol/client.ts)、[protocol/job.ts](../../protocol/job.ts)、[worker/contract.ts](../../worker/contract.ts)：看两边实际交换什么，提示词与资料如何分离。
3. [bin/agent-autoloop.ts](../../bin/agent-autoloop.ts) → [cli/main.ts](../../cli/main.ts) → [host/up.ts](../../host/up.ts)：看配置怎样装配运行单元；不必先读全部命令。
4. [kernel/http.ts](../../kernel/http.ts) → [host/runtime.ts](../../host/runtime.ts) 的 `execute()` → [kernel/decide.ts](../../kernel/decide.ts)：只追本文列出的 `ingest/enqueue/claimNext/finish/answer`，配合 [kernel/query.ts](../../kernel/query.ts) 看任务上下文。
5. [worker/worker.ts](../../worker/worker.ts)：按 `tick → start → launch → check → conclude → settle` 读，再跟一个 [Codex 插件](../../plugins/codex/agent.ts) 或 [command 插件](../../plugins/command/agent.ts)。
6. 开始扩展时读对应 [examples/plugins](../../examples/plugins/) 模板与测试；只有改调度或存储时，再深入 [store.ts](../../kernel/store.ts)、[evolve.ts](../../kernel/evolve.ts)、[due.ts](../../kernel/due.ts) 和 `sim/`。

### 6.2 二次开发检查表

| 边界                 | 为什么必须守住 / 证据                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 内核只收、分、派、记 | 不联网、不读时钟/随机数/环境/文件、不认识具体产品。时钟与资源从外壳注入；[tests/purity.test.ts](../../tests/purity.test.ts) 也约束其他通用层不认识具体产品                                                |
| 外部文字是资料       | 不把 `summary/detail` 或回答拼成指令，不让事件选择 `cwd/agent/access`；[protocol/validate.ts](../../protocol/validate.ts)、[worker/contract.ts](../../worker/contract.ts)                                    |
| 身份与能力不混用     | 来源、接单、通道、本人密钥和单轮令牌各有边界；通道回调核对回答人和原消息；[kernel/http.ts](../../kernel/http.ts)、[kernel/credentials.ts](../../kernel/credentials.ts)                                       |
| 一轮不等人           | 提问后结束，回答唤醒原事项；不增加让 `Agent` 阻塞等待人的机制；[kernel/decide.ts](../../kernel/decide.ts) 的 `answer()`、[worker/contract.ts](../../worker/contract.ts)                                      |
| 事实日志是唯一权威   | `commit` 独占日志追加，`evolve` 独占持久投影写入。格式指纹变化从日志重建，不增加数据迁移文件；[kernel/store.ts](../../kernel/store.ts)、[host/runtime.ts](../../host/runtime.ts)                             |
| 副作用按至少一次设计 | 去重和幂等回执不意味着外部业务只执行一次；任务应核实当前状态再改。回执错只修回执；回执事件继承深度，超过 `8` 层只记不派；[协议](../protocol.md#失败时会怎样)、[tests/hops.test.ts](../../tests/hops.test.ts) |
| 协议兼容是产品兼容   | 改接口、规则、插件约定时同步核对协议、示例、两份自述文件、安装/安全/技能文档和架构图。破坏老用法升第一位版本，版本只放标签；[AGENTS.md](../../AGENTS.md)、[协议版本约定](../protocol.md#版本与兼容)          |
| 不扩张产品边界       | 内核不增加运行时依赖或界面；独立前端通过协议连接；交付插件复用调度，不能检出或执行拉取请求里的代码、测试、配置和钩子。设置从可信 `main` 读取；[AGENTS.md](../../AGENTS.md) 的“插件与交付边界”                                   |

新增插件通常只需要配置、该插件和相应行为测试；只有确实改变公共行为时才进入协议或内核。修改 `kernel/worker/protocol/host` 的拉取请求合并前，还需独立审查者检查调用方、真实外部运行证据及同类问题，具体要求以 [AGENTS.md](../../AGENTS.md) 为准。

## 7. 历史导览验证记录

以下保留原导览在 `Node v24.12.0` 上的历史记录；不是本次文档修订或原生 `Windows` 部署的验收结果，本次没有重跑这些命令。上面的步骤后续如有调整，也需重新验收：

- 第 `2.3` 节的临时实例命令已实跑，事件、提问、回答、第二轮完成、`why` 查询和重复事件去重通过；退出后清理临时实例。
- `npm run typecheck`、`npm run format:check` 通过；本文另行检查 `Markdown` 格式及相对源码链接。
- `npm run test:quick`：`625` 项通过、`2` 项跳过、`1` 项失败。失败在 [tests/uninstall.test.ts](../../tests/uninstall.test.ts) 的 `installing the service again brings back a Skill link that uninstalling took away`：`rmSync(skillLink(it))` 报 `ERR_FS_EISDIR`，单独重跑该测试文件仍复现。本文未修改业务代码或测试来绕过它。

未执行长模拟、穷举、强杀、变异、安装冒烟或真实模型/外部通道验收；没有浏览器渲染检查。这里的实跑结论仅覆盖本地模拟程序闭环，不代表外部平台和生产业务已验收。
