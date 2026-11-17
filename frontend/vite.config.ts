import { defineConfig } from "vite";
import type { Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { createLocalConsole } from "./local-console.ts";

export default defineConfig(({ command }) => {
  // Builds must not read private local configuration, even when the opt-in is inherited.
  const gateway = command === "serve" ? createLocalConsole() : undefined;
  const target = gateway?.target || process.env.AGENT_AUTOLOOP_URL || "http://127.0.0.1:7317";
  const proxy = { "/v1": { target, changeOrigin: true } };
  const localConsole: Plugin = {
    name: "local-console-session",
    configureServer(server) {
      server.middlewares.use(gateway!.middleware);
      server.httpServer?.once("close", gateway!.close);
    },
    configurePreviewServer(server) {
      server.middlewares.use(gateway!.middleware);
      server.httpServer.once("close", gateway!.close);
    },
  };
  return {
    plugins: [vue(), ...(gateway ? [localConsole] : [])],
    server: {
      host: "127.0.0.1",
      port: 8000,
      proxy,
      cors: false,
      // Keep Vite's default denials and deny the explicitly selected private config too.
      fs: {
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem}",
          "**/.git/**",
          ...(process.env.AGENT_AUTOLOOP_LOCAL_CONFIG
            ? [process.env.AGENT_AUTOLOOP_LOCAL_CONFIG.replaceAll("\\", "/")]
            : []),
        ],
      },
    },
    preview: { host: "127.0.0.1", port: 8080, proxy, cors: false },
  };
});
