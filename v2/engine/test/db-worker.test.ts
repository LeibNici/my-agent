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
