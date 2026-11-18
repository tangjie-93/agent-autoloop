// 本机操作台的原生启动器：node scripts/start-console.ts（或 npm start），需要 Node 24 及以上。
// 运行前先准备好 config.json 和前端依赖；本脚本不安装、不初始化、不迁移数据。
// 顺序有讲究：校验配置 -> 复用或启动中台 -> 复用或启动 Vite -> 验证带鉴权的本机代理 -> 按需打开浏览器。
// 本机会话把主人密钥留在服务端，不再需要复制到剪贴板。
// 服务会脱离启动器继续运行：停中台前先在命令行或操作台里取消 Agent 的轮次；
// 关掉本脚本或浏览器不会停掉已分离的接单程序及其 Agent。
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { powershell, psQuote } from "../host/command.ts";

const HELP = `用法：npm start -- [选项]
或：node scripts/start-console.ts [选项]

  --frontend-port <端口>  操作台端口，默认 5193（1024–65535）
  --no-browser            不打开浏览器
  --no-clipboard          兼容旧参数；现在始终不复制密钥
  --help                  查看帮助

数据目录由 AGENT_AUTOLOOP_HOME 指定，默认 ~/.agent-autoloop。
需要先初始化本机中台，并执行 npm --prefix frontend ci。`;

// 路径以本文件为基准，而不是调用者的当前目录：npm、IDE 和终端可能在不同文件夹里启动。
// 数据目录单独存放，新检出的源码可以直接复用已有安装，不必复制密钥。
const repo = path.resolve(import.meta.dirname, "..");
const home = path.resolve(process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop"));
const logs = path.join(home, "logs", "console");

/** 端口在监听不等于对端就是中台；复用中台或其代理之前，必须先用鉴权请求确认身份。 */
async function hubReady(url: string, owner: string) {
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/v1/state`, {
      headers: { Authorization: `Bearer ${owner}` },
      signal: AbortSignal.timeout(3_000),
      // 绝不把主人密钥转发给重定向后的服务器。
      redirect: "error",
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return false;
    }
    const state = await response.json();
    return state?.runs != null && state?.cards != null && state?.totals != null;
  } catch {
    return false;
  }
}

/** 本机别的应用可能已经占着这个端口；它的页面绝不能被当成我们的操作台。 */
async function consoleReady(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: "error" });
    const html = await response.text();
    return response.status === 200 && html.includes("<title>流程运行台 · Autoloop</title>");
  } catch {
    return false;
  }
}

/** 身份校验失败又遇到端口被占，这是要报的错，不是去杀掉占用者的许可。 */
async function occupied(port: number, host = "127.0.0.1") {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * 直接启动原生 Node：经过 shell 或 npm 包装层会重新解释路径里的引号、空格和元字符。
 * 所有标准输入输出都走文件，不接回启动器的管道。detached + unref 让服务在启动器退出后继续运行。
 * 只有这次新起的服务才写 PID 记录；复用已有服务时不能覆盖它的归属提示或日志。
 */
async function start(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const output = openSync(path.join(logs, `${name}.log`), "a", 0o600);
  try {
    const errors = openSync(path.join(logs, `${name}.error.log`), "a", 0o600);
    try {
      const child = spawn(process.execPath, args, {
        cwd,
        env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", output, errors],
      });
      // 'spawn' 事件才能确认拿到了有效 PID；不能假设 spawn() 调用成功就一定会起来。
      await once(child, "spawn");
      child.unref();
      writeFileSync(path.join(logs, `${name}.pid`), String(child.pid), { mode: 0o600 });
      return child;
    } finally {
      closeSync(errors);
    }
  } finally {
    closeSync(output);
  }
}

/** 只等这一个新进程；它提前退出就马上失败并留下诊断日志，而不是再起一份重复的服务。 */
async function ready(child: ChildProcess, check: () => Promise<boolean>, name: string) {
  const end = Date.now() + 45_000;
  do {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} 已退出，请查看日志：${logs}`);
    if (await check()) return;
    await delay(500);
  } while (Date.now() < end);
  throw new Error(`${name} 在限定时间内没有就绪，请查看日志：${logs}`);
}

/**
 * 校验请求和本地文件，复用或启动中台与 Vite，并在打开页面前证明浏览器用的本机会话确实可用。
 * 只补缺的服务：复用到的中台和前端不会被停止，失败时也不去动它们。
 */
async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        "frontend-port": { type: "string", default: "5193" },
        "no-browser": { type: "boolean" },
        "no-clipboard": { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch {
    throw new Error(`启动参数不正确。\n${HELP}`);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("需要 Node.js 24 或更新版本。");
  const port = Number(values["frontend-port"]);
  if (!/^\d+$/.test(values["frontend-port"]) || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("前端端口必须是 1024–65535 的整数。");

  const configFile = path.join(home, "config.json");
  if (!existsSync(configFile))
    throw new Error(`没有找到中台配置：${configFile}。请先按 docs/local/windows-native-deployment.md 初始化。`);
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (typeof config.url !== "string" || typeof config.owner !== "string" || !config.owner || !config.hub)
    throw new Error(`中台配置不完整，需要本机 Hub 和本人密钥：${configFile}`);
  // 启动器会把 config.json 里的主人密钥交给这个地址，所以只接受本机回环 HTTP，不跟着别的地址或内嵌凭据走。
  const backend = new URL(config.url);
  if (
    backend.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname) ||
    backend.username ||
    backend.password
  )
    throw new Error("启动入口只支持本机 HTTP 回环中台，请检查 config.json 的 url。");
  if (Number(backend.port || 80) === port) throw new Error("前端和中台不能使用同一个端口。");
  const frontend = `http://127.0.0.1:${port}`;
  const frontendDir = path.join(repo, "frontend");
  const vite = path.join(frontendDir, "node_modules/vite/bin/vite.js");
  if (!existsSync(vite)) throw new Error("缺少前端依赖，请在当前环境执行 npm --prefix frontend ci。");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  // 每个子进程都拿到显式环境；启动器自己的环境在派生服务期间不做修改。
  const env = { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_URL: config.url };

  // 中台：能鉴权通过就复用，否则确认端口空闲后再启动，绝不抢占别人的端口。
  if (await hubReady(config.url, config.owner)) console.log("复用已运行的中台。");
  else {
    if (await occupied(Number(backend.port || 80), backend.hostname.replace(/^\[|\]$/g, "")))
      throw new Error("中台端口已被占用或鉴权失败；没有停止任何已有进程。");
    console.log("正在启动原生中台和 Worker…");
    const child = await start(
      "backend",
      ["--disable-warning=ExperimentalWarning", path.join(repo, "bin/agent-autoloop.ts"), "up"],
      repo,
      env,
    );
    await ready(child, () => hubReady(config.url, config.owner), "中台");
  }
  // 前端同理：能认出口径一致的页面就复用，否则确认端口空闲后再起 Vite。
  if (await consoleReady(frontend)) console.log("复用已运行的前端。");
  else {
    if (await occupied(port)) throw new Error(`前端端口 ${port} 已被占用或页面验证失败；没有停止任何已有进程。`);
    console.log("正在启动原生前端…");
    const child = await start(
      "frontend",
      [vite, "--host", "127.0.0.1", "--strictPort", "--port", String(port)],
      frontendDir,
      // 只给这个前端子进程开这个变量；路径不是凭据，也绝不能写成 VITE_* 客户端变量。
      { ...env, AGENT_AUTOLOOP_LOCAL_CONFIG: configFile },
    );
    await ready(child, () => consoleReady(frontend), "前端");
  }
  // 这里验证的是浏览器实际要用的短时本机会话，而不是一条隐藏的手动密钥通道。
  // 旧版或手动起的 Vite 可能返回正确页面，却撑不起新的单按钮连接。
  const endpoint = `${frontend}/local-console/session`;
  const request = (init: RequestInit = {}) =>
    fetch(endpoint, { ...init, signal: AbortSignal.timeout(3000), redirect: "error" });
  let token: string | undefined;
  try {
    const metadata = await request();
    if (!metadata.ok) throw new Error("没有本机连接接口");
    const mode = await metadata.json();
    // 前端连的必须是当前这份配置里的中台；端口一致不代表身份一致。
    if (mode.local !== true || new URL(mode.backend).href !== backend.href) throw new Error("前端配置与当前中台不一致");
    const response = await request({
      method: "POST",
      headers: { Origin: frontend, "X-Autoloop-Local": "1", "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error("本机会话创建失败");
    const session = await response.json();
    if (typeof session.token !== "string" || !session.token) throw new Error("本机会话无效");
    token = session.token;
    // 真的用会话令牌走一次代理请求，确认浏览器看到的正是这个中台的状态。
    const state = await fetch(`${frontend}/v1/state`, {
      headers: { "X-Autoloop-Session": session.token as string },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!state.ok) throw new Error("代理鉴权失败");
    const data = await state.json();
    if (data.runs == null || data.cards == null || data.totals == null) throw new Error("代理响应不是中台状态");
  } catch {
    throw new Error(`前端不支持本机连接或未连到当前中台，请核对配置并重启本实例前端。日志：${logs}`);
  } finally {
    // 验证用的短时会话用完就撤销，不留在服务端。
    if (token)
      await request({
        method: "DELETE",
        headers: { Origin: frontend, "X-Autoloop-Local": "1", "X-Autoloop-Session": token },
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
  }
  // 启动过程中途失败也绝不顺手停掉中台：它的接单程序可能已经领了活。
  if (process.platform === "win32" && !values["no-browser"]) powershell(`Start-Process ${psQuote(frontend)}`);
  console.log(`前后端已就绪：${frontend}\n日志和新启动进程的 PID：${logs}`);
}

try {
  await main();
} catch (error) {
  console.error(
    `启动失败：${error instanceof Error ? error.message : String(error)}\n已有服务未被停止；启动日志：${logs}`,
  );
  process.exitCode = 1;
}
