// Failure modes: the launcher depends on the caller's cwd or a shell, loses a spaced checkout path, or detaches without
// preserving logs/PIDs; repeated launches start duplicates, and an occupied port or a wrong proxy is silently reused.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const windows = process.platform === "win32";
const launcher = path.resolve("scripts/start-console.ts");

test("launcher help and invalid options never start services", () => {
  const help = spawnSync(process.execPath, [launcher, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--frontend-port/);
  for (const args of [["--frontend-port", "0"], ["--frontend-port", "NaN"], ["--unknown"]]) {
    const failed = spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8" });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /参数|端口/);
  }
});

async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const number = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return number;
}

function invoke(script: string, env: NodeJS.ProcessEnv, frontendPort: number) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, "--frontend-port", String(frontendPort), "--no-browser", "--no-clipboard"],
      { env, cwd: tmpdir(), windowsHide: true },
    );
    let output = "";
    child.stdout.on("data", (part) => {
      output += part;
    });
    child.stderr.on("data", (part) => {
      output += part;
    });
    child.on("error", reject);
    child.stdin.end();
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function stop(pid: number) {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    return;
  }
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Test process ${pid} did not stop`);
}

test(
  "the Windows launcher starts native processes in a spaced checkout, reuses them and rejects wrong services",
  {
    skip: !windows,
    timeout: 120_000,
  },
  async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "autoloop native ' & "));
    const repo = path.join(scratch, "checkout with spaces");
    const data = path.join(scratch, "data");
    const scripts = path.join(repo, "scripts");
    const vite = path.join(repo, "frontend/node_modules/vite/bin");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(vite, { recursive: true });
    mkdirSync(path.join(repo, "bin"));
    mkdirSync(data);
    copyFileSync(launcher, path.join(scripts, "start-console.ts"));
    mkdirSync(path.join(repo, "host"));
    copyFileSync(path.resolve("host/command.ts"), path.join(repo, "host/command.ts"));
    writeFileSync(path.join(repo, "package.json"), '{"type":"module"}');
    // Real native processes with local HTTP only: no models, user config, login tasks, clipboard or browser.
    writeFileSync(
      path.join(repo, "bin/agent-autoloop.ts"),
      `
import {createServer} from 'node:http';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
const home = process.env.AGENT_AUTOLOOP_HOME;
const config = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
writeFileSync(path.join(home, 'backend.json'), JSON.stringify({pid:process.pid,cwd:process.cwd(),platform:process.platform}));
createServer((req,res)=>{
  if(req.headers.authorization !== 'Bearer '+config.owner) {res.writeHead(401);res.end();return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({runs:[],cards:[],totals:{}}));
}).listen(new URL(config.url).port,'127.0.0.1');
`,
    );
    writeFileSync(
      path.join(vite, "vite.js"),
      `
import {createServer} from 'node:http';
import {writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
const home=process.env.AGENT_AUTOLOOP_HOME;
const config=JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_LOCAL_CONFIG,'utf8'));
const sessions=new Set();
writeFileSync(path.join(home,'frontend.json'),JSON.stringify({pid:process.pid,cwd:process.cwd(),target:process.env.AGENT_AUTOLOOP_URL,localConfig:process.env.AGENT_AUTOLOOP_LOCAL_CONFIG}));
createServer(async(req,res)=>{
 if(req.url==='/local-console/session') {
   res.setHeader('Content-Type','application/json');
   if(req.method==='POST'){sessions.add('fixture-session');res.end(JSON.stringify({token:'fixture-session'}));return;}
   if(req.method==='DELETE'){sessions.delete(req.headers['x-autoloop-session']);res.end('{}');return;}
   res.end(JSON.stringify({local:true,backend:process.env.AGENT_AUTOLOOP_URL}));return;
 }
 if(req.url.startsWith('/v1/')){const upstream=await fetch(process.env.AGENT_AUTOLOOP_URL+req.url,{headers:{authorization:sessions.has(req.headers['x-autoloop-session'])?'Bearer '+config.owner:req.headers.authorization}});res.writeHead(upstream.status,{'Content-Type':'application/json'});res.end(await upstream.text());return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>流程运行台 · Autoloop</title>');
}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');
`,
    );
    const backendPort = await port();
    let frontendPort = await port();
    while (frontendPort === backendPort) frontendPort = await port();
    const env = { ...process.env, AGENT_AUTOLOOP_HOME: data, LOCALAPPDATA: scratch };
    const script = path.join(scripts, "start-console.ts");
    const configFile = path.join(data, "config.json");
    const config = {
      url: `http://127.0.0.1:${backendPort}`,
      owner: "fake-test-owner",
      hub: { listen: `127.0.0.1:${backendPort}` },
    };
    const pids = new Set<number>();
    try {
      const missing = await invoke(script, env, frontendPort);
      assert.equal(missing.code, 1, missing.output);
      assert.match(missing.output, /config\.json/);
      writeFileSync(configFile, JSON.stringify(config));
      const first = await invoke(script, env, frontendPort);
      assert.equal(first.code, 0, first.output);
      const backend = JSON.parse(readFileSync(path.join(data, "backend.json"), "utf8"));
      const frontend = JSON.parse(readFileSync(path.join(data, "frontend.json"), "utf8"));
      pids.add(backend.pid);
      pids.add(frontend.pid);
      assert.equal(backend.platform, "win32");
      assert.equal(backend.cwd, repo);
      assert.equal(frontend.cwd, path.join(repo, "frontend"));
      assert.equal(frontend.target, config.url);
      assert.equal(frontend.localConfig, configFile);
      const records = ["backend", "frontend"].map((name) => path.join(data, "logs/console", `${name}.pid`));
      assert.equal(Number(readFileSync(records[0], "utf8")), backend.pid);
      assert.equal(Number(readFileSync(records[1], "utf8")), frontend.pid);
      for (const name of ["backend", "frontend"]) {
        assert.ok(existsSync(path.join(data, "logs/console", `${name}.log`)));
        assert.ok(existsSync(path.join(data, "logs/console", `${name}.error.log`)));
      }
      const modified = records.map((file) => statSync(file).mtimeMs);
      const second = await invoke(script, env, frontendPort);
      assert.deepEqual(
        records.map((file) => statSync(file).mtimeMs),
        modified,
      );
      assert.equal(second.code, 0, second.output);
      assert.equal(JSON.parse(readFileSync(path.join(data, "backend.json"), "utf8")).pid, backend.pid);
      assert.equal(JSON.parse(readFileSync(path.join(data, "frontend.json"), "utf8")).pid, frontend.pid);
      writeFileSync(configFile, JSON.stringify({ ...config, owner: "wrong-owner" }));
      assert.equal((await invoke(script, env, frontendPort)).code, 1);
      const otherHub = httpServer((req, res) => {
        if (req.headers.authorization !== "Bearer other-owner") {
          res.writeHead(401);
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ runs: [], cards: [], totals: {} }));
      });
      await new Promise<void>((resolve) => otherHub.listen(0, "127.0.0.1", resolve));
      try {
        writeFileSync(
          configFile,
          JSON.stringify({
            ...config,
            owner: "other-owner",
            url: `http://127.0.0.1:${(otherHub.address() as { port: number }).port}`,
          }),
        );
        assert.equal(
          (await invoke(script, env, frontendPort)).code,
          1,
          "a frontend proxying to another hub was accepted",
        );
      } finally {
        await new Promise<void>((resolve) => otherHub.close(() => resolve()));
      }
      writeFileSync(configFile, JSON.stringify(config));
      await stop(frontend.pid);
      pids.delete(frontend.pid);
      const occupied = httpServer((_req, res) => res.end("Other"));
      await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
      try {
        assert.equal((await invoke(script, env, (occupied.address() as { port: number }).port)).code, 1);
      } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
      }
      await stop(backend.pid);
      pids.delete(backend.pid);
      writeFileSync(path.join(repo, "bin/agent-autoloop.ts"), "process.exit(1);");
      const exited = await invoke(script, env, frontendPort);
      assert.equal(exited.code, 1, exited.output);
      assert.match(exited.output, /已退出/);
    } finally {
      for (const name of ["backend", "frontend"]) {
        const file = path.join(data, `${name}.json`);
        if (existsSync(file)) pids.add(JSON.parse(readFileSync(file, "utf8")).pid);
      }
      for (const pid of pids) await stop(pid);
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
