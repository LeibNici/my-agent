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
      case "getUserByUsername": {
        const [username] = args as [string];
        reply({ id, ok: true, result: storage.getUserByUsername(username) });
        break;
      }
      case "createUser": {
        const [username, passwordHash, role] = args as [string, string, string | undefined];
        reply({ id, ok: true, result: storage.createUser(username, passwordHash, role) });
        break;
      }
      case "getUserById": {
        const [userId] = args as [number];
        reply({ id, ok: true, result: storage.getUserById(userId) });
        break;
      }
      case "listUsers": {
        reply({ id, ok: true, result: storage.listUsers() });
        break;
      }
      case "updateUserPassword": {
        const [userId, passwordHash] = args as [number, string];
        storage.updateUserPassword(userId, passwordHash);
        reply({ id, ok: true, result: undefined });
        break;
      }
      case "setUserActive": {
        const [userId, active] = args as [number, boolean];
        storage.setUserActive(userId, active);
        reply({ id, ok: true, result: undefined });
        break;
      }
      case "deleteUser": {
        const [userId] = args as [number];
        storage.deleteUser(userId);
        reply({ id, ok: true, result: undefined });
        break;
      }
      case "createSession": {
        const [title, ownerId] = args as [string, number | null];
        reply({ id, ok: true, result: storage.createSession(title, ownerId) });
        break;
      }
      case "listSessions": {
        const [ownerId] = args as [number | null];
        reply({ id, ok: true, result: storage.listSessions(ownerId) });
        break;
      }
      case "getSession": {
        const [sessionId] = args as [string];
        reply({ id, ok: true, result: storage.getSession(sessionId) });
        break;
      }
      case "updateSessionTitle": {
        const [sessionId, title] = args as [string, string];
        storage.updateSessionTitle(sessionId, title);
        reply({ id, ok: true, result: undefined });
        break;
      }
      case "deleteSession": {
        const [sessionId] = args as [string];
        storage.deleteSession(sessionId);
        reply({ id, ok: true, result: undefined });
        break;
      }
      case "listRepos": {
        reply({ id, ok: true, result: storage.listRepos() });
        break;
      }
      case "listReposForUser": {
        const [userId] = args as [number];
        reply({ id, ok: true, result: storage.listReposForUser(userId) });
        break;
      }
      case "getUserRepos": {
        const [userId] = args as [number];
        reply({ id, ok: true, result: storage.getUserRepos(userId) });
        break;
      }
      case "getRepo": {
        const [repoId] = args as [number];
        reply({ id, ok: true, result: storage.getRepo(repoId) });
        break;
      }
      case "getRepoAdmin": {
        const [repoId] = args as [number];
        reply({ id, ok: true, result: storage.getRepoAdmin(repoId) });
        break;
      }
      case "listReposFull": {
        reply({ id, ok: true, result: storage.listReposFull() });
        break;
      }
      case "listReposForUserFull": {
        const [userId] = args as [number];
        reply({ id, ok: true, result: storage.listReposForUserFull(userId) });
        break;
      }
      case "createRepo": {
        const [fields] = args as [Parameters<typeof storage.createRepo>[0]];
        reply({ id, ok: true, result: storage.createRepo(fields) });
        break;
      }
      case "updateRepo": {
        const [repoId, fields] = args as [number, Parameters<typeof storage.updateRepo>[1]];
        storage.updateRepo(repoId, fields);
        reply({ id, ok: true, result: undefined });
        break;
      }
      case "deleteRepo": {
        const [repoId] = args as [number];
        storage.deleteRepo(repoId);
        reply({ id, ok: true, result: undefined });
        break;
      }
      case "grantPermission": {
        const [userId, repoId, accessLevel] = args as [number, number, string];
        reply({ id, ok: true, result: storage.grantPermission(userId, repoId, accessLevel) });
        break;
      }
      case "revokePermission": {
        const [userId, repoId] = args as [number, number];
        storage.revokePermission(userId, repoId);
        reply({ id, ok: true, result: undefined });
        break;
      }
      case "listPermissions": {
        reply({ id, ok: true, result: storage.listPermissions() });
        break;
      }
      case "recordSemanticSearchLog": {
        const [row] = args as [Parameters<typeof storage.recordSemanticSearchLog>[0]];
        storage.recordSemanticSearchLog(row);
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
