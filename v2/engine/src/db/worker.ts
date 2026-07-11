import { parentPort, workerData } from "node:worker_threads";
import { openStorage } from "./storage.js";

type Request = { id: number; method: string; args: unknown[] };
type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

if (!parentPort) {
  throw new Error("db worker must be run inside a worker_threads.Worker");
}

const { dbPath } = workerData as { dbPath: string };
const storage = openStorage(dbPath);

function reply(msg: Response): void {
  parentPort!.postMessage(msg);
}

parentPort.on("message", (req: Request) => {
  const { id, method, args } = req;
  try {
    switch (method) {
      case "addMessage": {
        const [sessionId, role, content] = args as [string, string, string | unknown[]];
        reply({ id, ok: true, result: storage.addMessage(sessionId, role, content) });
        break;
      }
      case "getMessages": {
        const [sessionId] = args as [string];
        reply({ id, ok: true, result: storage.getMessages(sessionId) });
        break;
      }
      case "recordLlmCallMetrics": {
        const [rows] = args as [Parameters<typeof storage.recordLlmCallMetrics>[0]];
        storage.recordLlmCallMetrics(rows);
        reply({ id, ok: true, result: undefined });
        break;
      }
      case "close": {
        storage.close();
        reply({ id, ok: true, result: undefined });
        // 让最后一条回复先发出去，再让线程自然退出（parentPort.close 会终止消息循环）。
        parentPort!.close();
        break;
      }
      default:
        reply({ id, ok: false, error: `unknown method: ${method}` });
    }
  } catch (err) {
    reply({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
