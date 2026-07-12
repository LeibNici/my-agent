import { Worker } from "node:worker_threads";
import { once } from "node:events";
import type { StoredMessageRow, LlmMetricsRow, UserRow, SessionRow, RepoRow } from "./storage.js";

export type DbClient = {
  addMessage(sessionId: string, role: string, content: string | unknown[]): Promise<number>;
  getMessages(sessionId: string): Promise<StoredMessageRow[]>;
  recordLlmCallMetrics(rows: LlmMetricsRow[]): Promise<void>;
  getUserByUsername(username: string): Promise<UserRow | null>;
  createUser(username: string, passwordHash: string, role?: string): Promise<number>;
  createSession(title: string, ownerId: number | null): Promise<string>;
  listSessions(ownerId: number | null): Promise<SessionRow[]>;
  getSession(sessionId: string): Promise<SessionRow | null>;
  deleteSession(sessionId: string): Promise<void>;
  listRepos(): Promise<RepoRow[]>;
  listReposForUser(userId: number): Promise<RepoRow[]>;
  close(): Promise<void>;
};

type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

/**
 * 建一个跑在 worker_threads 里的 sqlite storage 客户端：同步的 better-sqlite3 调用
 * 全部下沉到 worker 线程，主线程只拿 Promise，事件循环不被 DB IO 卡住。
 *
 * `new Worker(...)` 生成的是一个全新的 Node worker 线程，不会继承 vitest/tsx 主线程
 * 的 TS 转译，worker.ts 必须自己想办法把 TS 转成可执行代码。真正的入口是
 * worker-bootstrap.mjs（纯 .mjs，免转译）—— 它在 worker 线程内用 tsx 的编程式 API
 * `tsImport()` 手动加载 worker.ts；`execArgv: ["--import", "tsx"]` 这条路我们也试过，
 * 但 tsx 的自动 hook 注册在 worker 线程里被其内部 `isMainThread` 判断跳过了，
 * 只有显式调用 tsImport() 才能绕开，见 worker-bootstrap.mjs 顶部注释。
 */
export function createDbClient(dbPath: string): DbClient {
  const worker = new Worker(new URL("./worker-bootstrap.mjs", import.meta.url), {
    workerData: { dbPath },
  });
  // 一个泄漏的 client（没有在途调用）不该拖着进程不退出，所以默认 unref。但 unref
  // 的 worker 不会被事件循环当作"还有活干"——如果 close() 期间一直不 ref 回来，
  // 主线程可能在 worker 回完最后一条消息之前就判定"没事可做"提前退出（实测在纯
  // tsx 脚本里会触发 Node 的 "unsettled top-level await" 警告，close() 永远不 resolve）。
  // 所以：只要 pending 里有在途调用就 ref，清空回 0 就 unref。
  worker.unref();

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let fatalError: Error | null = null;
  let closePromise: Promise<void> | null = null;
  let exited = false;

  function settle(id: number, fn: (p: Pending) => void): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (pending.size === 0) worker.unref();
    fn(p);
  }

  worker.on("message", (msg: Response) => {
    settle(msg.id, (p) => (msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error))));
  });

  function drainPending(err: Error): void {
    for (const p of pending.values()) {
      p.reject(err);
    }
    pending.clear();
    worker.unref();
  }

  worker.on("error", (err) => {
    fatalError = err instanceof Error ? err : new Error(String(err));
    drainPending(fatalError);
  });

  // 常驻 exit 处理器：干净退出不触发 "error"，而 worker 端 close 后 parentPort 已关，
  // 晚到的请求消息被静默丢弃 —— 没有这个 drain，那些调用就永远 pending。
  // （事件监听器本身不计入事件循环的 ref 计数，不会让 unref 失效。）
  worker.on("exit", () => {
    exited = true;
    drainPending(fatalError ?? new Error("db worker exited before responding"));
  });

  // send() 是真正投递到 worker 的底层通道；call() 在其上加 closed 拦截。
  // close() 自己的 RPC 必须走 send() 而不是 call()，因为发出它时 closePromise 已置位。
  function send<T>(method: string, args: unknown[]): Promise<T> {
    if (fatalError) {
      return Promise.reject(fatalError);
    }
    if (exited) {
      return Promise.reject(new Error("db worker exited before responding"));
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      if (pending.size === 0) worker.ref();
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, method, args });
    });
  }

  function call<T>(method: string, args: unknown[]): Promise<T> {
    if (closePromise) {
      return Promise.reject(new Error("db client is closed"));
    }
    return send<T>(method, args);
  }

  return {
    addMessage: (sessionId, role, content) => call<number>("addMessage", [sessionId, role, content]),
    getMessages: (sessionId) => call<StoredMessageRow[]>("getMessages", [sessionId]),
    recordLlmCallMetrics: (rows) => call<void>("recordLlmCallMetrics", [rows]),
    getUserByUsername: (username) => call<UserRow | null>("getUserByUsername", [username]),
    createUser: (username, passwordHash, role) =>
      call<number>("createUser", [username, passwordHash, role]),
    createSession: (title, ownerId) => call<string>("createSession", [title, ownerId]),
    listSessions: (ownerId) => call<SessionRow[]>("listSessions", [ownerId]),
    getSession: (sessionId) => call<SessionRow | null>("getSession", [sessionId]),
    deleteSession: (sessionId) => call<void>("deleteSession", [sessionId]),
    listRepos: () => call<RepoRow[]>("listRepos", []),
    listReposForUser: (userId) => call<RepoRow[]>("listReposForUser", [userId]),
    close: () => {
      // 幂等：第二次及以后的 close() 返回同一个 promise（resolve-as-noop），不再发 RPC。
      if (!closePromise) {
        closePromise = (async () => {
          try {
            await send<void>("close", []);
          } catch {
            // worker 已经 error/exit 也算"关闭完成"—— close() 的职责是确保关了，
            // 不是复述上一次失败；那些失败已经通过各自调用的 reject 传出去了。
          }
          if (!exited) {
            // send() 在收到回复、pending 归零那一刻已经 unref 过 worker 了——但线程
            // 还没真退出（worker 端 parentPort.close() 是异步生效的）。重新 ref 住，
            // 等真正的 "exit" 事件，否则主线程可能在 worker 退出前就"无事可做"先走。
            worker.ref();
            await once(worker, "exit");
            worker.unref();
          }
        })();
      }
      return closePromise;
    },
  };
}
