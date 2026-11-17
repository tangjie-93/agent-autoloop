import type { ConsoleAuth, Fetcher } from "../types/console.ts";

/** Keep local capabilities distinct from hub/source bearer keys; neither credential goes in a URL. */
export function authHeaders(auth: ConsoleAuth): Record<string, string> {
  return typeof auth === "string" ? { Authorization: `Bearer ${auth}` } : { "X-Autoloop-Session": auth.session };
}

/** A plain static deployment can retain manual auth; a broken local endpoint must not silently downgrade. */
export async function localMode(fetcher: Fetcher, signal: AbortSignal) {
  const response = await fetcher("/local-console/session", {
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  if (response.status === 404 || (response.ok && response.headers.get("content-type")?.includes("text/html")))
    return false;
  if (!response.ok) throw new Error("无法检查本机连接，请确认前端服务已更新并重试。");
  const data = await response.json();
  if (typeof data.local !== "boolean") throw new Error("本机连接响应无效，请重启前端后重试。");
  return data.local;
}

/** Create only a short-lived browser capability. The real owner key stays in the local server. */
export async function openSession(fetcher: Fetcher, signal: AbortSignal) {
  const response = await fetcher("/local-console/session", {
    method: "POST",
    headers: { "X-Autoloop-Local": "1", "Content-Type": "application/json" },
    body: "{}",
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("本机连接失败，请确认中台和前端使用同一配置后重试。");
  const data = await response.json();
  if (typeof data.token !== "string" || !data.token) throw new Error("本机会话无效，请重试。");
  return data.token;
}

/** Revoke only this tab's token, independently of the aborted data/stream requests. Never retry a write. */
export async function closeSession(fetcher: Fetcher, token: string) {
  const response = await fetcher("/local-console/session", {
    method: "DELETE",
    headers: { "X-Autoloop-Local": "1", "X-Autoloop-Session": token },
    signal: AbortSignal.timeout(5000),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("本机会话撤销未确认；页面已断开，会话将自动到期。");
}
