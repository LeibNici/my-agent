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
});
