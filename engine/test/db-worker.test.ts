import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { makeSeededDb } from "./db-fixture.js";
import { createDbClient, type DbClient } from "../src/db/client.js";

let dir: string, client: DbClient;
beforeEach(() => {
  const f = makeSeededDb();
  dir = f.dir;
  client = createDbClient(f.dbPath);
});
afterEach(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createDbClient", () => {
  it("经 worker 的写读回环", async () => {
    const id = await client.addMessage("s1", "user", [{ type: "text", text: "你好" }]);
    expect(id).toBeGreaterThan(0);
    expect((await client.getMessages("s1"))[0].content).toEqual([{ type: "text", text: "你好" }]);
  });

  it("并发调用全部正确关联（pending-map 不串号）", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => client.addMessage("s1", "user", `m${i}`))
    );
    expect(new Set(results).size).toBe(20); // 20 个不同 rowid
    const msgs = await client.getMessages("s1");
    expect(msgs.length).toBe(20);
  });

  it("SQLite 错误变 reject 且 worker 存活", async () => {
    await expect(client.addMessage("ghost", "user", "x")).rejects.toThrow(/FOREIGN KEY/i);
    // worker 没死，后续调用照常
    await expect(client.addMessage("s1", "user", "still alive")).resolves.toBeGreaterThan(0);
  });

  it("close() 幂等：double close 两个 promise 都 settle（第二次 resolve 为 no-op）", async () => {
    const p1 = client.close();
    const p2 = client.close();
    await expect(Promise.all([p1, p2])).resolves.toBeDefined();
    // 完全 await 过后再 close 也一样是 no-op
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("close() 之后的调用立刻 reject（/closed/），不挂死", async () => {
    await client.close();
    await expect(client.addMessage("s1", "user", "too late")).rejects.toThrow(/closed/i);
    await expect(client.getMessages("s1")).rejects.toThrow(/closed/i);
  });

  it("close() 与同 tick 发出的在途调用：全部 settle，不挂死", async () => {
    const inflight = client.addMessage("s1", "user", "racing close");
    const closing = client.close();
    const settled = await Promise.race([
      Promise.allSettled([inflight, closing]),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    expect(settled).not.toBe("timeout");
    const [msgResult, closeResult] = settled as PromiseSettledResult<unknown>[];
    // worker 单线程按序处理：先发的 addMessage 正常成功也行，被 exit-drain 拒掉也行 —— 但绝不能 pending
    expect(["fulfilled", "rejected"]).toContain(msgResult.status);
    expect(closeResult.status).toBe("fulfilled");
  });

  it("metrics 批量走 worker", async () => {
    await client.recordLlmCallMetrics([
      {
        session_id: "s1",
        user_id: null,
        model: "m",
        iteration: 1,
        input_tokens: 1,
        output_tokens: 2,
        ttft_ms: 3,
        total_ms: 4,
      },
    ]);
  });

  it("createUser / getUserByUsername 经 worker 的写读回环", async () => {
    const id = await client.createUser("alice", "hashed-pw", "user");
    expect(id).toBeGreaterThan(0);
    const row = await client.getUserByUsername("alice");
    expect(row).toMatchObject({ id, username: "alice", role: "user" });
  });

  it("createUser 省略 role 时经 worker 仍落到默认 'user'（undefined 经 postMessage 结构化克隆后触发默认参数）", async () => {
    await client.createUser("bob", "hashed-pw");
    const row = await client.getUserByUsername("bob");
    expect(row!.role).toBe("user");
  });

  it("getUserByUsername 查无此人经 worker 回环仍是 null（不是 undefined）", async () => {
    expect(await client.getUserByUsername("ghost-user")).toBeNull();
  });

  it("updateSessionTitle 经 worker 的写读回环", async () => {
    const uid = await client.createUser("alice", "hashed-pw", "user");
    const sid = await client.createSession("New Chat", uid);
    await client.updateSessionTitle(sid, "衍生出的标题");
    expect((await client.getSession(sid))!.title).toBe("衍生出的标题");
  });

  it("getUserById / listUsers / updateUserPassword / setUserActive / deleteUser 经 worker 的写读回环（Task 1）", async () => {
    const id = await client.createUser("alice", "hashed-pw", "user");
    expect((await client.getUserById(id))!.password_hash).toBe("hashed-pw");

    const listed = await client.listUsers();
    expect(listed).toContainEqual(expect.objectContaining({ id, username: "alice" }));
    expect(listed.every((u) => !("password_hash" in u))).toBe(true);

    await client.updateUserPassword(id, "new-hash");
    expect((await client.getUserById(id))!.password_hash).toBe("new-hash");

    await client.setUserActive(id, false);
    expect((await client.getUserById(id))!.is_active).toBe(0);

    await client.deleteUser(id);
    expect(await client.getUserById(id)).toBeNull();
  });

  it("repo CRUD 经 worker 的写读回环：createRepo → getRepo → updateRepo → getUserRepos → deleteRepo（Task 1）", async () => {
    const uid = await client.createUser("alice", "hashed-pw", "user");
    const repoId = await client.createRepo({ name: "demo", url: "https://example.com/demo.git" });
    expect((await client.getRepo(repoId))!.name).toBe("demo");

    await client.updateRepo(repoId, { name: "demo-renamed" });
    expect((await client.getRepo(repoId))!.name).toBe("demo-renamed");

    await client.grantPermission(uid, repoId, "write");
    expect(await client.getUserRepos(uid)).toMatchObject([{ id: repoId, access_level: "write" }]);

    await client.revokePermission(uid, repoId);
    expect(await client.getUserRepos(uid)).toEqual([]);

    await client.deleteRepo(repoId);
    expect(await client.getRepo(repoId)).toBeNull();
  });

  it("listPermissions 经 worker 的 JOIN 回环；grantPermission 对不存在的 repo 经 worker 仍 reject 为 FOREIGN KEY（Task 1）", async () => {
    const uid = await client.createUser("alice", "hashed-pw", "user");
    const repoId = await client.createRepo({ name: "demo", url: "https://example.com/demo.git" });
    await client.grantPermission(uid, repoId, "read");
    const perms = await client.listPermissions();
    expect(perms).toMatchObject([{ username: "alice", repo_name: "demo", access_level: "read" }]);

    await expect(client.grantPermission(uid, 999, "read")).rejects.toThrow(/FOREIGN KEY/i);
  });
});
