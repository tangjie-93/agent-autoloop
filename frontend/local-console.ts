import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request, validateHeaderValue } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";

const sessionPath = "/local-console/session";
const sessionLifetime = 15 * 60 * 1000;
const sessionLimit = 32;

function loopback(address: string): boolean {
  return address === "::1" || /^(?:::ffff:)?127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(address);
}

// No config discovery: only an explicit server-side opt-in can read an owner key.
export function createLocalConsole(env: NodeJS.ProcessEnv = process.env) {
  let target = env.AGENT_AUTOLOOP_URL || "http://127.0.0.1:7317";
  let owner = "";
  const configPath = env.AGENT_AUTOLOOP_LOCAL_CONFIG;
  if (configPath) {
    if (!isAbsolute(configPath)) throw new Error("本机会话配置必须使用绝对路径");
    try {
      const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (
        !config ||
        typeof config !== "object" ||
        !("url" in config) ||
        !("owner" in config) ||
        typeof config.url !== "string" ||
        typeof config.owner !== "string" ||
        !config.owner.trim() ||
        /[\r\n]/.test(config.owner)
      ) {
        throw new Error();
      }
      validateHeaderValue("authorization", `Bearer ${config.owner}`);
      const url = new URL(config.url);
      if (
        url.protocol !== "http:" ||
        !(url.hostname === "localhost" || loopback(url.hostname.replace(/^\[|\]$/g, ""))) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error();
      if (env.AGENT_AUTOLOOP_URL && new URL(env.AGENT_AUTOLOOP_URL).href !== url.href) {
        throw new Error();
      }
      target = config.url;
      owner = config.owner;
    } catch {
      throw new Error("本机会话配置无效：需要 HTTP 回环地址和本人密钥，代理地址也必须一致");
    }
  }

  const sessions = new Map<
    string,
    { expires: number; timer: ReturnType<typeof setTimeout>; streams: Set<ServerResponse> }
  >();
  function revoke(token: string): void {
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token);
    clearTimeout(session.timer);
    for (const stream of session.streams) stream.destroy();
  }
  function reply(res: ServerResponse, status: number, value: object): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  }
  function trusted(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (
      !loopback(req.socket.remoteAddress || "") ||
      typeof host !== "string" ||
      !["localhost", "127.0.0.1", "[::1]"].some((name) => host === `${name}:${req.socket.localPort}`)
    )
      return false;
    for (const name of [
      "host",
      "origin",
      "sec-fetch-site",
      "x-autoloop-local",
      "x-autoloop-session",
      "authorization",
    ]) {
      if ((req.headersDistinct[name]?.length ?? 0) > 1) return false;
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) return false;
    return req.method === "GET" || origin === `http://${host}`;
  }

  // Runs before Vite's proxy. Session requests are handled here; manual Bearer requests fall through unchanged.
  function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const path = (req.url || "").split("?", 1)[0];
    const tokenHeader = req.headers["x-autoloop-session"];
    const local = path === sessionPath;
    if (!local && tokenHeader === undefined) {
      next();
      return;
    }
    if (!trusted(req) || (tokenHeader !== undefined && req.headers.authorization !== undefined)) {
      reply(res, 403, { error: "只允许本机同源请求，且不能混用两种凭据" });
      return;
    }
    if (local && req.method === "GET") {
      reply(res, 200, owner ? { local: true, backend: target } : { local: false });
      return;
    }
    if (!owner) {
      reply(res, 403, { error: "未启用本机会话，请手动连接" });
      return;
    }
    if (local && req.method === "POST") {
      if (
        req.headers["x-autoloop-local"] !== "1" ||
        tokenHeader !== undefined ||
        req.headers.authorization !== undefined
      ) {
        reply(res, 403, { error: "本机会话需要同源确认" });
        return;
      }
      for (const [token, session] of sessions) if (session.expires <= Date.now()) revoke(token);
      if (sessions.size >= sessionLimit) {
        reply(res, 429, { error: "本机会话已满，请先断开不用的连接" });
        return;
      }
      const token = randomBytes(32).toString("base64url");
      const timer = setTimeout(() => revoke(token), sessionLifetime);
      timer.unref();
      sessions.set(token, { expires: Date.now() + sessionLifetime, timer, streams: new Set() });
      reply(res, 200, { token });
      return;
    }
    const token = typeof tokenHeader === "string" ? tokenHeader : "";
    const session = sessions.get(token);
    if (!session || session.expires <= Date.now()) {
      revoke(token);
      reply(res, 401, { error: "本机会话已失效，请重新连接" });
      return;
    }
    if (local && req.method === "DELETE") {
      revoke(token);
      reply(res, 200, { ok: true });
      return;
    }
    const allowed =
      req.method === "GET"
        ? /^\/v1\/(?:state|stream|runs\/[1-9]\d*\/why)$/.test(path)
        : req.method === "POST" && /^\/v1\/(?:cards\/[1-9]\d*\/(?:answer|resolve)|runs\/[1-9]\d*\/cancel)$/.test(path);
    if (!allowed) {
      reply(res, 403, { error: "本机会话不能访问这个接口，请使用对应的密钥" });
      return;
    }

    const headers: IncomingHttpHeaders = { ...req.headers, authorization: `Bearer ${owner}` };
    delete headers["x-autoloop-session"];
    delete headers["x-autoloop-local"];
    delete headers.host;
    const destination = new URL(target);
    // Keep localhost on loopback without forcing IPv4: the hub may listen only on ::1.
    const localhost =
      destination.hostname === "localhost"
        ? {
            autoSelectFamily: true,
            lookup: (
              _hostname: string,
              _options: unknown,
              callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
            ) =>
              callback(null, [
                { address: "::1", family: 6 },
                { address: "127.0.0.1", family: 4 },
              ]),
          }
        : {};
    const upstream = request(destination, { method: req.method, path: req.url, headers, ...localhost }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        reply(res, 502, { error: "中台返回了跳转，本机会话不会跟随" });
        return;
      }
      const responseHeaders: IncomingHttpHeaders = { ...response.headers, "cache-control": "no-store" };
      for (const name of Object.keys(responseHeaders)) {
        if (name.startsWith("access-control-")) delete responseHeaders[name];
      }
      res.writeHead(response.statusCode || 502, responseHeaders);
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    if (path === "/v1/stream") session.streams.add(res);
    res.once("close", () => {
      session.streams.delete(res);
      upstream.destroy();
    });
    upstream.on("error", () => {
      if (!res.headersSent && !res.destroyed) reply(res, 502, { error: "暂时连不上中台" });
      else res.destroy();
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  }
  return {
    target,
    middleware,
    close: () => {
      for (const token of sessions.keys()) revoke(token);
    },
  };
}
