import { Worker } from "node:worker_threads";
import { once } from "node:events";
import type { StoredMessageRow, LlmMetricsRow } from "./storage.js";

export type DbClient = {
  addMessage(sessionId: string, role: string, content: string | unknown[]): Promise<number>;
  getMessages(sessionId: string): Promise<StoredMessageRow[]>;
  recordLlmCallMetrics(rows: LlmMetricsRow[]): Promise<void>;
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

  worker.on("error", (err) => {
    fatalError = err instanceof Error ? err : new Error(String(err));
    for (const p of pending.values()) {
      p.reject(fatalError);
    }
    pending.clear();
    worker.unref();
  });

  function call<T>(method: string, args: unknown[]): Promise<T> {
    if (fatalError) {
      return Promise.reject(fatalError);
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      if (pending.size === 0) worker.ref();
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, method, args });
    });
  }

  return {
    addMessage: (sessionId, role, content) => call<number>("addMessage", [sessionId, role, content]),
    getMessages: (sessionId) => call<StoredMessageRow[]>("getMessages", [sessionId]),
    recordLlmCallMetrics: (rows) => call<void>("recordLlmCallMetrics", [rows]),
    close: async () => {
      await call<void>("close", []);
      // call() 在收到回复、pending 归零那一刻已经 unref 过 worker 了——但线程还没
      // 真退出（worker 端 parentPort.close() 是异步生效的）。重新 ref 住，等到真正
      // 的 "exit" 事件，否则主线程可能在 worker 退出前就被判定为"无事可做"而先走。
      worker.ref();
      await once(worker, "exit");
    },
  };
}
