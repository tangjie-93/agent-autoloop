import { shallowRef, computed, getCurrentScope, onScopeDispose } from "vue";
import { useFactStream } from "./useFactStream.ts";
import { createHub } from "../service/hub.ts";
import { mergeRuns, runFromFacts } from "../model.ts";
import type { ConsoleOptions, HubState, Run, Fact, ConsoleAuth, ConnectionMode } from "../types/console.ts";
import { localMode, openSession, closeSession } from "../service/session.ts";
/** Own one connection generation and cancel obsolete reads without replaying writes. */
export function useConsole(options: ConsoleOptions = {}) {
  const state = shallowRef<HubState | null>(null),
    runs = shallowRef<Run[]>([]),
    selected = shallowRef<number | null>(null),
    facts = shallowRef<Fact[]>([]),
    error = shallowRef(""),
    detailError = shallowRef(""),
    message = shallowRef(""),
    busy = shallowRef(false),
    detailBusy = shallowRef(false),
    pending = shallowRef(false),
    connected = shallowRef(false),
    connecting = shallowRef(false),
    mode = shallowRef<ConnectionMode>("checking"),
    updated = shallowRef(""),
    hasMore = shallowRef(false);
  const fetcher = options.fetcher ?? fetch;
  let session: string | null = null;
  let discovery = 0;
  const discoveryController = new AbortController();
  async function discover() {
    const version = ++discovery;
    mode.value = "checking";
    error.value = "";
    try {
      const local = await localMode(fetcher, AbortSignal.any([discoveryController.signal, AbortSignal.timeout(5000)]));
      if (version === discovery && !discoveryController.signal.aborted) mode.value = local ? "local" : "manual";
    } catch (cause) {
      if (version !== discovery || discoveryController.signal.aborted) return;
      mode.value = "error";
      error.value = cause instanceof Error ? cause.message : "检查本机连接失败，请重试。";
    }
  }
  async function revoke(token: string) {
    try {
      await closeSession(fetcher, token);
    } catch (cause) {
      if (!connected.value && !connecting.value)
        message.value = cause instanceof Error ? cause.message : "会话撤销未确认。";
    }
  }
  let generation = 0,
    detailGeneration = 0,
    hub: ReturnType<typeof createHub> | null = null,
    controller = new AbortController(),
    detailController = new AbortController(),
    timer: ReturnType<typeof setTimeout> | undefined,
    cursor: number | null = null,
    loading = false;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const realtime = options.realtime !== false;
  function scheduleRefresh() {
    dirty = true;
    if (changeTimer) return;
    const version = generation;
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      if (version === generation) void refresh();
    }, 100);
  }
  const stream = useFactStream({ onChange: scheduleRefresh, onOpen: scheduleRefresh, fetcher: options.fetcher });
  const run = computed(() => runs.value.find((r) => r.id === selected.value) ?? null);
  function disconnect() {
    const previousSession = session;
    session = null;
    if (previousSession) void revoke(previousSession);
    connecting.value = false;
    generation++;
    detailGeneration++;
    stream.disconnect();
    clearTimeout(changeTimer);
    changeTimer = undefined;
    dirty = false;
    clearTimeout(timer);
    controller.abort();
    detailController.abort();
    hub = null;
    connected.value = false;
    state.value = null;
    runs.value = [];
    facts.value = [];
    selected.value = null;
    error.value = "";
    detailError.value = "";
    message.value = "";
    updated.value = "";
    busy.value = false;
    detailBusy.value = false;
    loading = false;
    pending.value = false;
    hasMore.value = false;
    cursor = null;
  }
  async function loadDetail() {
    if (!hub || selected.value === null) return;
    const id = selected.value,
      version = ++detailGeneration,
      connection = generation;
    detailController.abort();
    detailController = new AbortController();
    detailBusy.value = true;
    detailError.value = "";
    try {
      const result = await hub.why(id, detailController.signal);
      if (connection === generation && version === detailGeneration) facts.value = result;
    } catch (e) {
      if (connection === generation && version === detailGeneration && !detailController.signal.aborted)
        detailError.value = e instanceof Error ? e.message : "读取记录失败，请重试。";
    } finally {
      if (connection === generation && version === detailGeneration) detailBusy.value = false;
    }
  }
  async function select(id: number) {
    selected.value = id;
    facts.value = [];
    await loadDetail();
  }
  async function refresh() {
    if (!hub || loading) return;
    loading = true;
    dirty = false;
    busy.value = true;
    const version = generation;
    const oldRun = JSON.stringify(run.value);
    const oldCards = JSON.stringify([state.value?.cards, state.value?.recentCards]);
    clearTimeout(timer);
    try {
      const client = hub,
        signal = controller.signal;
      const result = await client.state(signal);
      if (version !== generation) return;
      const returned = new Set(result.runs.map((r) => r.id));
      const missing = runs.value.filter(
        (r) => ["queued", "claimed", "unknown"].includes(r.state) && !returned.has(r.id),
      );
      const completed: Run[] = [];
      let staleError = "";
      for (const previous of missing) {
        try {
          const history = await client.why(previous.id, signal);
          if (version !== generation) return;
          completed.push(runFromFacts(previous, history));
        } catch (e) {
          if (version !== generation) return;
          staleError = e instanceof Error ? e.message : "读取旧轮次状态失败。";
        }
      }
      if (version !== generation) return;
      const firstRead = state.value === null;
      state.value = result;
      runs.value = mergeRuns(runs.value, [...completed, ...result.runs]);
      if (firstRead) {
        cursor = result.nextBefore;
        hasMore.value = result.hasMore;
      }
      updated.value = new Date().toISOString();
      error.value = staleError;
      if (
        selected.value !== null &&
        (oldRun !== JSON.stringify(run.value) || oldCards !== JSON.stringify([result.cards, result.recentCards]))
      )
        void loadDetail();
    } catch (e) {
      if (version === generation && !controller.signal.aborted)
        error.value = e instanceof Error ? e.message : "读取记录失败，请重试。";
    } finally {
      if (version === generation) {
        loading = false;
        busy.value = false;
        if (!realtime) timer = setTimeout(() => void refresh(), options.interval ?? 3000);
        else if (dirty) scheduleRefresh();
      }
    }
  }
  /** A handshake belongs to the same generation as its first state read; a late token must be revoked, not reused. */
  async function connect(key?: string) {
    disconnect();
    controller = new AbortController();
    const version = generation;
    connecting.value = true;
    try {
      let auth: ConsoleAuth;
      if (mode.value === "local") {
        const token = await openSession(fetcher, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
        if (version !== generation) {
          await revoke(token);
          return;
        }
        session = token;
        auth = { session: token };
      } else {
        if (!key?.trim()) throw new Error("请填写本人密钥，或用 npm start 启用本机连接。");
        auth = key.trim();
      }
      hub = createHub(auth, options.fetcher);
      await refresh();
      if (version !== generation) return;
      if (!state.value) throw new Error(error.value || "中台暂不可用，请重试。");
      connected.value = true;
      if (realtime) stream.connect(auth);
    } catch (cause) {
      if (version !== generation) return;
      const text = cause instanceof Error ? cause.message : "连接失败，请重试。";
      const failedSession = session;
      session = null;
      disconnect();
      if (failedSession) await revoke(failedSession);
      if (generation === version + 1) error.value = text;
    } finally {
      if (version === generation) connecting.value = false;
    }
  }
  async function more() {
    if (!hub || !cursor || loading) return;
    loading = true;
    busy.value = true;
    clearTimeout(timer);
    const version = generation;
    try {
      const result = await hub.state(controller.signal, cursor);
      if (version === generation) {
        runs.value = mergeRuns(result.runs, runs.value);
        cursor = result.nextBefore;
        hasMore.value = result.hasMore;
        error.value = "";
      }
    } catch (e) {
      if (version === generation) error.value = e instanceof Error ? e.message : "读取记录失败，请重试。";
    } finally {
      if (version === generation) {
        loading = false;
        busy.value = false;
        if (!realtime) timer = setTimeout(() => void refresh(), options.interval ?? 3000);
        else if (dirty) scheduleRefresh();
      }
    }
  }
  async function action(work: (client: ReturnType<typeof createHub>) => Promise<unknown>, success: string) {
    if (!hub || pending.value) return;
    const version = generation,
      client = hub;
    pending.value = true;
    message.value = "";
    try {
      await work(client);
      if (version !== generation) return;
      message.value = success;
      await refresh();
      await loadDetail();
    } catch (e) {
      if (version === generation)
        message.value =
          (e instanceof Error ? e.message : "操作结果未确认，请先刷新核对。") + " 请先刷新核对，写请求不会自动重发。";
    } finally {
      if (version === generation) pending.value = false;
    }
  }
  if (getCurrentScope())
    onScopeDispose(() => {
      discoveryController.abort();
      disconnect();
    });
  return {
    streamStatus: stream.status,
    streamError: stream.error,
    activity: stream.activity,
    state,
    runs,
    selected,
    facts,
    error,
    detailError,
    message,
    busy,
    detailBusy,
    pending,
    connected,
    connecting,
    mode,
    discover,
    updated,
    hasMore,
    run,
    connect,
    disconnect,
    refresh,
    select,
    more,
    loadDetail,
    action,
  };
}
