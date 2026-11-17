// Prevent Vite proxy/CORS ordering from bypassing local-session checks or exposing the selected config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, preview } from "vite";
import viteConfig from "../vite.config.ts";

test("production config does not read an inherited private-config opt-in", () => {
  const previous = process.env.AGENT_AUTOLOOP_LOCAL_CONFIG;
  process.env.AGENT_AUTOLOOP_LOCAL_CONFIG = join(tmpdir(), "does-not-exist", "config.json");
  try {
    assert.doesNotThrow(() => viteConfig({ command: "build", mode: "production" }));
  } finally {
    if (previous === undefined) delete process.env.AGENT_AUTOLOOP_LOCAL_CONFIG;
    else process.env.AGENT_AUTOLOOP_LOCAL_CONFIG = previous;
  }
});

for (const mode of ["dev", "preview"]) {
  test(`${mode} installs gateway before proxy, disables CORS and keeps config private`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "autoloop-vite-"));
    const config = join(directory, "config.json");
    const upstream = createHttpServer((req, res) => {
      assert.equal(req.headers["x-autoloop-session"], undefined);
      res.end(JSON.stringify({ authorized: req.headers.authorization === "Bearer vite-test-owner" }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const backend = `http://127.0.0.1:${address.port}`;
    writeFileSync(config, JSON.stringify({ url: backend, owner: "vite-test-owner" }));
    const oldConfig = process.env.AGENT_AUTOLOOP_LOCAL_CONFIG;
    const oldUrl = process.env.AGENT_AUTOLOOP_URL;
    process.env.AGENT_AUTOLOOP_LOCAL_CONFIG = config;
    process.env.AGENT_AUTOLOOP_URL = backend;
    let close = async () => {};
    t.after(async () => {
      await close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (oldConfig === undefined) delete process.env.AGENT_AUTOLOOP_LOCAL_CONFIG;
      else process.env.AGENT_AUTOLOOP_LOCAL_CONFIG = oldConfig;
      if (oldUrl === undefined) delete process.env.AGENT_AUTOLOOP_URL;
      else process.env.AGENT_AUTOLOOP_URL = oldUrl;
      rmSync(directory, { recursive: true, force: true });
    });
    const root = fileURLToPath(new URL("../", import.meta.url));
    const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
    let origin: string;
    if (mode === "dev") {
      const server = await createServer({ root, configFile, server: { port: 0, fs: { allow: [root, directory] } } });
      close = () => server.close();
      await server.listen();
      origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    } else {
      const server = await preview({ root, configFile, preview: { port: 0 } });
      close = () =>
        new Promise<void>((resolve) => {
          server.httpServer.close(() => resolve());
        });
      origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    }
    const capability = await fetch(`${origin}/local-console/session`);
    assert.deepEqual(await capability.json(), { local: true, backend });
    const bootstrap = await fetch(`${origin}/local-console/session`, {
      method: "POST",
      headers: { Origin: origin, "X-Autoloop-Local": "1" },
    });
    assert.equal(bootstrap.status, 200);
    const { token } = await bootstrap.json();
    const state = await fetch(`${origin}/v1/state`, { headers: { "X-Autoloop-Session": token } });
    assert.deepEqual(await state.json(), { authorized: true });
    const manual = await fetch(`${origin}/v1/state`, { headers: { Authorization: "Bearer vite-test-owner" } });
    assert.deepEqual(await manual.json(), { authorized: true });
    const source = await fetch(`${origin}/v1/events`, {
      method: "POST",
      headers: { Authorization: "Bearer source-only" },
      body: "{}",
    });
    assert.deepEqual(await source.json(), { authorized: false });
    const hostile = await fetch(`${origin}/local-console/session`, {
      method: "POST",
      headers: { Origin: "http://evil.invalid", "X-Autoloop-Local": "1" },
    });
    assert.equal(hostile.status, 403);
    assert.equal(hostile.headers.get("access-control-allow-origin"), null);
    const preflight = await fetch(`${origin}/local-console/session`, {
      method: "OPTIONS",
      headers: { Origin: "http://evil.invalid", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    if (mode === "dev") {
      for (const suffix of ["", "?raw", "?import", "?url"]) {
        const exposed = await fetch(`${origin}/@fs/${config.replaceAll("\\", "/")}${suffix}`);
        assert.equal((await exposed.text()).includes("vite-test-owner"), false);
      }
    }
  });
}
