// Native console launcher: node scripts/start-console.ts (or npm start), with Node 24+.
// Prepare config.json and frontend dependencies first; this script never installs, initializes or migrates data.
// Order matters: validate configuration -> reuse/start the hub -> reuse/start Vite -> verify its authenticated proxy
// -> optionally open the browser. Local sessions keep the owner key server-side; clipboard copying is no longer needed.
// Services deliberately outlive this launcher. Cancel Agent runs through the CLI/console before stopping the hub;
// closing this script or the browser does not stop detached workers or their Agents.
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

// Resolve source paths from this file, not the caller's cwd (npm, an IDE and a terminal may use different folders).
// Data lives separately so a new source checkout can reuse an existing installation without copying keys.
const repo = path.resolve(import.meta.dirname, "..");
const home = path.resolve(process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop"));
const logs = path.join(home, "logs", "console");

/** A listening port is not proof of identity; authenticated state is required before reusing a hub or its proxy. */
async function hubReady(url: string, owner: string) {
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/v1/state`, {
      headers: { Authorization: `Bearer ${owner}` },
      signal: AbortSignal.timeout(3_000),
      // Never forward the owner key to a redirected server.
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

/** A different local app may already own this port; its HTML must never count as our console. */
async function consoleReady(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: "error" });
    const html = await response.text();
    return response.status === 200 && html.includes("<title>流程运行台 · Autoloop</title>");
  } catch {
    return false;
  }
}

/** A failed identity check plus an occupied port is an error, not permission to kill its owner. */
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
 * Start native Node directly: shell/npm wrappers would reinterpret quotes, spaces or metacharacters in paths.
 * All stdio uses files, not pipes to this launcher. detached + unref lets services survive the launcher exiting.
 * Only newly spawned services get PID records; reusing a service must not overwrite ownership hints or its logs.
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
      // 'spawn' confirms a valid PID; once() rejects on 'error', unlike assuming spawn() always succeeds.
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

/** Wait only for this new process; fail early on exit and leave diagnostic logs instead of starting duplicates. */
async function ready(child: ChildProcess, check: () => Promise<boolean>, name: string) {
  const end = Date.now() + 45_000;
  do {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} 已退出，请查看日志：${logs}`);
    if (await check()) return;
    await delay(500);
  } while (Date.now() < end);
  throw new Error(`${name} 在限定时间内没有就绪，请查看日志：${logs}`);
}

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
  // Each child gets an explicit environment; do not mutate the launcher's environment while spawning services.
  const env = { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_URL: config.url };

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
  if (await consoleReady(frontend)) console.log("复用已运行的前端。");
  else {
    if (await occupied(port)) throw new Error(`前端端口 ${port} 已被占用或页面验证失败；没有停止任何已有进程。`);
    console.log("正在启动原生前端…");
    const child = await start(
      "frontend",
      [vite, "--host", "127.0.0.1", "--strictPort", "--port", String(port)],
      frontendDir,
      // Opt in only this frontend child; the path is not a credential and must never be a VITE_* client variable.
      { ...env, AGENT_AUTOLOOP_LOCAL_CONFIG: configFile },
    );
    await ready(child, () => consoleReady(frontend), "前端");
  }
  // Verify the same short-lived session contract the browser uses, not a hidden manual-key fallback.
  // An old/manual Vite process may serve the right HTML but cannot support the new single-button connection.
  const endpoint = `${frontend}/local-console/session`;
  const request = (init: RequestInit = {}) =>
    fetch(endpoint, { ...init, signal: AbortSignal.timeout(3000), redirect: "error" });
  let token: string | undefined;
  try {
    const metadata = await request();
    if (!metadata.ok) throw new Error("没有本机连接接口");
    const mode = await metadata.json();
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
    if (token)
      await request({
        method: "DELETE",
        headers: { Origin: frontend, "X-Autoloop-Local": "1", "X-Autoloop-Session": token },
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
  }
  // Partial startup failures never stop the hub: its worker may already have accepted work.
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
