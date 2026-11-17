// Prevent browser-origin abuse, owner credential exposure, and sessions granting source or unrelated API access.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { IncomingHttpHeaders, Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createLocalConsole } from "../frontend/local-console.ts";

async function listen(server: Server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
}

async function fixture(t: TestContext, local = true, backendHost = "127.0.0.1") {
  const directory = mkdtempSync(join(tmpdir(), "autoloop-session-"));
  const received: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url!, headers: req.headers, body });
    if (req.url?.startsWith("/v1/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: ready\n\n");
    } else if (req.url === "/v1/state?redirect") {
      res.writeHead(302, { Location: "http://example.invalid/" }).end();
    } else res.end('{"ok":true}');
  });
  const backend = (await listen(upstream, backendHost)).replace("[::1]", "localhost");
  const config = join(directory, "config.json");
  writeFileSync(config, JSON.stringify({ url: backend, owner: "test-private-owner" }));
  const gateway = createLocalConsole(local ? { AGENT_AUTOLOOP_LOCAL_CONFIG: config } : {});
  const server = createServer((req, res) => gateway.middleware(req, res, () => res.writeHead(418).end("manual proxy")));
  const origin = await listen(server);
  t.after(async () => {
    gateway.close();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (path: string, method = "GET", headers: IncomingHttpHeaders = {}, body = "") => {
    const req = request(origin, { path, method, headers });
    const result = once(req, "response");
    req.end(body);
    const [res] = await result;
    let text = "";
    for await (const chunk of res) text += chunk;
    return { status: res.statusCode, headers: res.headers as IncomingHttpHeaders, text };
  };
  const bootstrap = async () => {
    const result = await call("/local-console/session", "POST", { Origin: origin, "X-Autoloop-Local": "1" });
    assert.equal(result.status, 200);
    assert.equal(result.text.includes("test-private-owner"), false);
    return JSON.parse(result.text).token as string;
  };
  return { gateway, config, backend, received, origin, call, bootstrap };
}

test("local capability and random sessions never expose the owner, and manual mode never reads config", async (t) => {
  const f = await fixture(t);
  const capability = await f.call("/local-console/session");
  assert.deepEqual(JSON.parse(capability.text), { local: true, backend: f.backend });
  assert.equal(capability.headers["cache-control"], "no-store");
  assert.equal(capability.headers["access-control-allow-origin"], undefined);
  const a = await f.bootstrap();
  const b = await f.bootstrap();
  assert.notEqual(a, b);
  assert.match(a, /^[\w-]{43}$/);
  const manual = await fixture(t, false);
  assert.deepEqual(JSON.parse((await manual.call("/local-console/session")).text), { local: false });
  assert.equal((await manual.call("/v1/state", "GET", { Authorization: "Bearer manual" })).status, 418);
  assert.equal(
    (await manual.call("/local-console/session", "POST", { Origin: manual.origin, "X-Autoloop-Local": "1" })).status,
    403,
  );
});

test("a localhost hub bound only to IPv6 remains reachable through a local session", async (t) => {
  const f = await fixture(t, true, "::1");
  const token = await f.bootstrap();
  const result = await f.call("/v1/state", "GET", { "X-Autoloop-Session": token });
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.at(-1)?.headers.authorization, "Bearer test-private-owner");
});

test("bootstrap and privileged ingress reject hostile Host, Origin, fetch metadata, and duplicate headers", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { Origin: f.origin },
    { Origin: "http://evil.invalid", "X-Autoloop-Local": "1" },
    { Origin: "null", "X-Autoloop-Local": "1" },
    { "X-Autoloop-Local": "1" },
    { Origin: f.origin, "X-Autoloop-Local": "1", Host: "evil.invalid" },
    { Origin: f.origin, "X-Autoloop-Local": "1", Host: "127.0.0.1:1" },
    { Origin: f.origin, "X-Autoloop-Local": "1", "Sec-Fetch-Site": "cross-site" },
    { Origin: f.origin, "X-Autoloop-Local": ["1", "1"] },
  ])
    assert.equal((await f.call("/local-console/session", "POST", headers)).status, 403);
  const token = await f.bootstrap();
  const socket = new Socket();
  Object.defineProperties(socket, { remoteAddress: { value: "192.0.2.1" }, localPort: { value: 8000 } });
  const remote = new IncomingMessage(socket);
  remote.method = "GET";
  remote.url = "/v1/state";
  remote.headers = { host: "127.0.0.1:8000", "x-autoloop-session": token };
  const response = new ServerResponse(remote);
  f.gateway.middleware(remote, response, () => assert.fail("non-loopback socket passed through"));
  assert.equal(response.statusCode, 403);
  socket.destroy();
  assert.equal((await f.call("/v1/state", "GET", { "X-Autoloop-Session": token, Host: "evil.invalid" })).status, 403);
  assert.equal(
    (await f.call("/v1/state", "GET", { "X-Autoloop-Session": token, "Sec-Fetch-Site": "cross-site" })).status,
    403,
  );
  assert.equal((await f.call("/v1/cards/1/answer", "POST", { "X-Autoloop-Session": token })).status, 403);
  assert.equal((await f.call("/v1/state", "GET", { "X-Autoloop-Session": [token, token] })).status, 403);
  assert.equal(f.received.length, 0);
});

test("only exact owner REST allowlist gets translated; source Bearer and manual requests pass untouched", async (t) => {
  const f = await fixture(t);
  const token = await f.bootstrap();
  for (const [method, path] of [
    ["GET", "/v1/state?limit=5"],
    ["GET", "/v1/runs/12/why"],
    ["POST", "/v1/cards/1/answer"],
    ["POST", "/v1/cards/2/resolve"],
    ["POST", "/v1/runs/3/cancel"],
  ]) {
    const result = await f.call(
      path,
      method,
      { Origin: f.origin, "X-Autoloop-Session": token, "Content-Type": "application/json" },
      method === "POST" ? "{}" : "",
    );
    assert.equal(result.status, 200);
    const received = f.received.at(-1)!;
    assert.equal(received.path, path);
    assert.equal(received.headers.authorization, "Bearer test-private-owner");
    assert.equal(received.headers["x-autoloop-session"], undefined);
    if (method === "POST") assert.equal(received.body, "{}");
  }
  const count = f.received.length;
  for (const path of [
    "/v1/events",
    "/v1/keys/owner/x",
    "/v1/rules/x/pause",
    "/v1/state/",
    "/v1/runs/0/why",
    "/v1/runs/01/why",
    "/v1/runs/%31/why",
    "/v1/cards/1/delivered",
    "/v1/../v1/state",
  ]) {
    assert.equal((await f.call(path, "GET", { "X-Autoloop-Session": token })).status, 403, path);
  }
  assert.equal(
    (await f.call("/v1/state", "GET", { "X-Autoloop-Session": token, Authorization: "Bearer source" })).status,
    403,
  );
  assert.equal((await f.call("/v1/events", "POST", { "X-Autoloop-Session": token, Origin: f.origin })).status, 403);
  assert.equal((await f.call("/v1/state", "GET", { "X-Autoloop-Session": "bad" })).status, 401);
  assert.equal(f.received.length, count);
  assert.equal((await f.call("/v1/events", "POST", { Authorization: "Bearer source" })).status, 418);
  assert.equal((await f.call("/v1/state", "GET", { Authorization: "Bearer manual" })).status, 418);
  assert.equal((await f.call("/v1/state?redirect", "GET", { "X-Autoloop-Session": token })).status, 502);
});

test("revocation and finite expiry terminate SSE and reject reuse; session storage is bounded", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = await fixture(t);
  const open = async (token: string) => {
    const req = request(`${f.origin}/v1/stream?after=4`, {
      headers: { "X-Autoloop-Session": token, "Last-Event-ID": "3" },
    });
    const response = once(req, "response");
    req.end();
    const [res] = await response;
    assert.equal(res.statusCode, 200);
    res.resume();
    return { closed: new Promise<void>((resolve) => res.once("close", resolve)) };
  };
  const token = await f.bootstrap();
  const { closed } = await open(token);
  assert.equal(f.received.at(-1)!.headers["last-event-id"], "3");
  assert.equal(
    (await f.call("/local-console/session", "DELETE", { Origin: f.origin, "X-Autoloop-Session": token })).status,
    200,
  );
  await closed;
  assert.equal((await f.call("/v1/state", "GET", { "X-Autoloop-Session": token })).status, 401);
  const expiring = await f.bootstrap();
  const { closed: expired } = await open(expiring);
  t.mock.timers.tick(30 * 60 * 1000);
  await expired;
  assert.equal((await f.call("/v1/state", "GET", { "X-Autoloop-Session": expiring })).status, 401);
  let bounded = false;
  for (let i = 0; i < 65; i++) {
    const result = await f.call("/local-console/session", "POST", { Origin: f.origin, "X-Autoloop-Local": "1" });
    if (result.status === 429) {
      bounded = true;
      break;
    }
    assert.equal(result.status, 200);
  }
  assert.ok(bounded);
});

test("local config must be explicit, absolute, HTTP loopback, and consistent with the selected proxy URL", async (t) => {
  const f = await fixture(t);
  assert.throws(() => createLocalConsole({ AGENT_AUTOLOOP_LOCAL_CONFIG: "config.json" }));
  for (const url of [
    "https://127.0.0.1:7317",
    "http://example.invalid",
    "http://127.0.0.1:7317/path",
    "http://user:pass@127.0.0.1:7317",
    "http://127.0.0.1:7317/#x",
  ]) {
    writeFileSync(f.config, JSON.stringify({ url, owner: "test-private-owner" }));
    assert.throws(() => createLocalConsole({ AGENT_AUTOLOOP_LOCAL_CONFIG: f.config }));
  }
  writeFileSync(f.config, JSON.stringify({ url: f.backend, owner: "invalid\u0000owner" }));
  assert.throws(() => createLocalConsole({ AGENT_AUTOLOOP_LOCAL_CONFIG: f.config }));
  writeFileSync(f.config, JSON.stringify({ url: f.backend, owner: "test-private-owner" }));
  assert.throws(() =>
    createLocalConsole({ AGENT_AUTOLOOP_LOCAL_CONFIG: f.config, AGENT_AUTOLOOP_URL: "http://127.0.0.1:1" }),
  );
  assert.equal(
    createLocalConsole({ AGENT_AUTOLOOP_LOCAL_CONFIG: f.config, AGENT_AUTOLOOP_URL: f.backend }).target,
    f.backend,
  );
  assert.equal(createLocalConsole({ AGENT_AUTOLOOP_URL: "http://example.invalid" }).target, "http://example.invalid");
});
