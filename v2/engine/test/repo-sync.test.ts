import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSeededDb } from "./db-fixture.js";
import { createDbClient, type DbClient } from "../src/db/client.js";
import * as symbolIndex from "../src/tools/symbol-index.js";
import { loadSettings, type Settings } from "../src/config.js";
import { readEmbeddingIndex } from "../src/tools/embed-store.js";
import {
  maskUrlCredentials,
  getRepoLocalPath,
  cloneRepo,
  pullRepo,
  syncRepo,
  syncAndPersist,
  syncAllRepos,
  periodicSyncLoop,
  configureIndexing,
  __internal,
} from "../src/repo-sync.js";

// buildIndex 的默认调度这批测试要精确控制它的开始/结束时机（人为延迟 + 记录
// 时间窗），来证明它有没有真的重新排进 per-repo 锁——不 mock 就没法可靠地
// 制造"buildIndex 还没跑完，第二次 sync 已经想动手"这个窗口。只替换
// buildIndex（importOriginal 保留真实 loadTags）——Phase 4b Task 5 的
// defaultOnSyncSuccess 在 buildIndex 成功后会调 collectChunks，后者从这同一
// 个模块 import 真实的 loadTags；整体替换成 `{ buildIndex: vi.fn() }` 会让
// loadTags 在这个模块里变成 undefined，collectChunks 一调用就抛错。
vi.mock("../src/tools/symbol-index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/symbol-index.js")>();
  return { ...actual, buildIndex: vi.fn() };
});
const mockedBuildIndex = vi.mocked(symbolIndex.buildIndex);

// __internal.*Unvalidated 绕开 validateUrl，只用于让"clone/sync/persist 机制
// 本身对不对"这批测试能对一个真实本地临时目录跑真实 git 子进程——见
// src/repo-sync.ts 里 cloneRepoCore 顶部注释：SSRF 网关要挡的地址
// (127.0.0.1/169.254.169.254/...) 恰好是离线沙箱里唯一真的连得通的地址，
// 不存在一个 host 能同时"离线可达"又"通过校验"。validateUrl 本身的行为
// （挡什么、放什么）在下面"SSRF 防护"块里用公开的 cloneRepo 单独黑盒测。
const { cloneRepoUnvalidated, syncRepoUnvalidated, syncAndPersistUnvalidated } = __internal;

// 用真实 execFile 包一层 spy：SSRF 测试断言它"从不被调用"，其余测试不覆盖
// mockImplementation，所以照常穿透到真的 git 子进程 —— 不需要网络 mock，
// 用本地临时目录当"远程" clone 源即可覆盖 happy path。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
const mockedExecFile = vi.mocked(execFileCb);

function initOriginRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  run(["add", "-A"]);
  run(["commit", "-m", "initial"]);
}

function commitFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir });
  run(["add", "-A"]);
  run(["commit", "-m", `add ${name}`]);
}

// Phase 4b Task 5 fixtures below —— chunking.ts's collectChunks gates ALL
// chunk collection (including the ctags-independent XML window chunker) on
// loadTags(repoPath) returning non-null (see chunking.ts's collectChunks:
// `if (tags === null) return [];`), so these tests need a real-looking
// ctags sidecar on disk even though buildIndex itself is mocked away above.
// A mapper XML file (rather than a ctags-parseable source file) sidesteps
// needing the real ctags binary to recognize a language in this sandbox —
// chunkXmlWindows only cares about the "resources"+"mapper" path
// convention, not ctags output.
function addMapperXmlFile(originDir: string): void {
  const dir = join(originDir, "resources", "mapper");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Foo.xml"), "<mapper>\n".repeat(5));
  const run = (args: string[]) => execFileSync("git", args, { cwd: originDir });
  run(["add", "-A"]);
  run(["commit", "-m", "add mapper xml"]);
}

/** buildIndex mock impl that plants an empty-but-valid ctags sidecar (real
 * loadTags sees "ran, found zero symbols" — not "never ran") and reports
 * success, without needing the real ctags binary. */
function mockBuildIndexSuccess(): void {
  mockedBuildIndex.mockImplementation(async (repoPath: string) => {
    writeFileSync(symbolIndex.indexPath(repoPath), "");
    return true;
  });
}

function makeEmbeddingSettings(overrides: Record<string, string | undefined> = {}): Settings {
  return loadSettings({
    ANTHROPIC_API_KEY: "llm-key",
    ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    APP_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    APP_EMBEDDING_API_KEY: "test-embed-key",
    APP_EMBEDDING_MODEL: "text-embedding-v4",
    APP_EMBEDDING_DIMENSIONS: "4",
    ...overrides,
  });
}

/** Fetch mock for the embedding endpoint: 200 + one fixed-dims vector per
 * requested input, after an optional artificial delay (to prove the embed
 * phase doesn't block a concurrent sync — see the "不持有仓库锁" test). */
function makeEmbeddingFetchMock(dims: number, delayMs = 0) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const body = JSON.parse(init.body) as { input: string[] };
    const data = body.input.map((_text, index) => ({
      index,
      embedding: Array.from({ length: dims }, (_v, i) => (index + i + 1) / 10),
    }));
    return { status: 200, json: async () => ({ data }) } as unknown as Response;
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("maskUrlCredentials", () => {
  it("剥离 user:pass@ 形态", () => {
    expect(maskUrlCredentials("https://alice:secret@github.com/x/y.git")).toBe(
      "https://github.com/x/y.git"
    );
  });

  it("剥离裸 token@ 形态", () => {
    expect(maskUrlCredentials("https://ghp_abc123@github.com/x/y.git")).toBe(
      "https://github.com/x/y.git"
    );
  });

  it("无凭证的 URL 原样返回", () => {
    expect(maskUrlCredentials("https://github.com/x/y.git")).toBe(
      "https://github.com/x/y.git"
    );
  });

  it("空/undefined 输入不抛错", () => {
    expect(maskUrlCredentials("")).toBe("");
  });
});

describe("getRepoLocalPath", () => {
  it("拼 reposDir/repoId", () => {
    expect(getRepoLocalPath("/data/repos", 42)).toBe(join("/data/repos", "42"));
  });
});

describe("SSRF 防护 —— _validate_url 等价逻辑", () => {
  let reposDir: string;

  beforeEach(() => {
    reposDir = mkdtempSync(join(tmpdir(), "repo-sync-ssrf-"));
    mockedExecFile.mockClear();
  });

  afterEach(() => {
    rmSync(reposDir, { recursive: true, force: true });
  });

  it("拒绝 127.0.0.1（loopback 字面 IP），且从不调用 git", async () => {
    const result = await cloneRepo({ url: "http://127.0.0.1/x", repoId: 1, reposDir });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/internal\/private host/);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("拒绝 169.254.169.254（云元数据地址），且从不调用 git", async () => {
    const result = await cloneRepo({ url: "http://169.254.169.254/", repoId: 2, reposDir });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/internal\/private host/);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("拒绝 localhost（DNS 解析到 loopback），且从不调用 git", async () => {
    const result = await cloneRepo({ url: "http://localhost/x", repoId: 3, reposDir });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/internal\/private host/);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("拒绝私网段 10.x/172.16-31.x/192.168.x/169.254.x", async () => {
    for (const host of ["10.1.2.3", "172.20.0.1", "192.168.1.1"]) {
      const result = await cloneRepo({ url: `http://${host}/x`, repoId: 9, reposDir });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/internal\/private host/);
    }
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("拒绝带方括号的 IPv6 字面量 host（[::1]/[fd00::1]/[fe80::1]），且从不调用 git", async () => {
    for (const bracketed of ["[::1]", "[fd00::1]", "[fe80::1]"]) {
      const result = await cloneRepo({ url: `http://${bracketed}/x`, repoId: 10, reposDir });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/internal\/private host/);
    }
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("拒绝 ftp:// 协议，且从不调用 git", async () => {
    const result = await cloneRepo({ url: "ftp://example.com/x", repoId: 4, reposDir });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid URL protocol/);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("正常 https:// host 校验通过后走真实 clone 路径（会调用 git，失败也没关系——这里只验证没被 SSRF 挡在前面）", async () => {
    const result = await cloneRepo({
      url: "https://example.invalid/nonexistent.git",
      repoId: 5,
      reposDir,
      // 用一个不可达但 DNS 语法合法的 host（.invalid 保留域，不会解析到私网段）
    });
    // 会真的尝试连接并失败（网络不可达/DNS 失败），但关键是它必须调用了 git —— 说明校验放行了
    expect(mockedExecFile).toHaveBeenCalled();
    expect(result.ok).toBe(false); // 连接注定失败，但失败原因不是 SSRF 拦截
    expect(result.message).not.toMatch(/Invalid URL protocol/);
    expect(result.message).not.toMatch(/internal\/private host/);
  }, 15000);
});

describe("cloneRepo —— 真实本地仓库", () => {
  let reposDir: string, originDir: string;

  beforeEach(() => {
    reposDir = mkdtempSync(join(tmpdir(), "repo-sync-repos-"));
    originDir = mkdtempSync(join(tmpdir(), "repo-sync-origin-"));
    initOriginRepo(originDir);
    mockedExecFile.mockClear();
  });

  afterEach(() => {
    rmSync(reposDir, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  });

  it("clone 成功，落地到 reposDir/repoId，.git 存在", async () => {
    const result = await cloneRepoUnvalidated({ url: originDir, repoId: 100, reposDir });
    expect(result.ok).toBe(true);
    const localPath = getRepoLocalPath(reposDir, 100);
    expect(existsSync(join(localPath, ".git"))).toBe(true);
    expect(existsSync(join(localPath, "README.md"))).toBe(true);
  });

  it("clone 失败不留下 .tmp 目录，也不破坏已有 checkout", async () => {
    // 先 clone 一次成功的
    await cloneRepoUnvalidated({ url: originDir, repoId: 101, reposDir });
    const localPath = getRepoLocalPath(reposDir, 101);
    expect(existsSync(localPath)).toBe(true);

    // 再对同一个 repoId 用一个不存在的分支名触发 clone 失败
    const result = await cloneRepoUnvalidated({
      url: originDir,
      repoId: 101,
      reposDir,
      branch: "does-not-exist-branch",
    });
    expect(result.ok).toBe(false);
    // 旧 checkout 应该还在（失败的 clone 不该破坏它）
    expect(existsSync(join(localPath, ".git"))).toBe(true);
    expect(existsSync(localPath + ".tmp")).toBe(false);
  });

  it("mask 掉的凭证不会出现在错误信息里", async () => {
    const badUrl = originDir; // 用不存在分支制造失败，凭证走 header 不走 URL，这里主要验证不 throw
    const result = await cloneRepoUnvalidated({
      url: badUrl,
      repoId: 102,
      reposDir,
      branch: "nope",
      credUsername: "alice",
      credToken: "sekrit",
    });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("sekrit");
  });
});

describe("pullRepo", () => {
  let reposDir: string, originDir: string;

  beforeEach(() => {
    reposDir = mkdtempSync(join(tmpdir(), "repo-sync-repos-"));
    originDir = mkdtempSync(join(tmpdir(), "repo-sync-origin-"));
    initOriginRepo(originDir);
  });

  afterEach(() => {
    rmSync(reposDir, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  });

  it("未 clone 过时返回 not found", async () => {
    const result = await pullRepo({ repoId: 999, reposDir });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/);
  });

  it("clone 后 pull 拿到新提交", async () => {
    await cloneRepoUnvalidated({ url: originDir, repoId: 200, reposDir });
    commitFile(originDir, "new.txt", "new content\n");
    const result = await pullRepo({ repoId: 200, reposDir });
    expect(result.ok).toBe(true);
    const localPath = getRepoLocalPath(reposDir, 200);
    expect(existsSync(join(localPath, "new.txt"))).toBe(true);
  });
});

describe("syncRepo —— pull 失败后自愈式 reclone", () => {
  let reposDir: string, originDir: string;

  beforeEach(() => {
    reposDir = mkdtempSync(join(tmpdir(), "repo-sync-repos-"));
    originDir = mkdtempSync(join(tmpdir(), "repo-sync-origin-"));
    initOriginRepo(originDir);
  });

  afterEach(() => {
    rmSync(reposDir, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  });

  it("首次 sync 走 clone 路径", async () => {
    const result = await syncRepoUnvalidated({ url: originDir, repoId: 300, reposDir });
    expect(result.ok).toBe(true);
    expect(existsSync(join(result.localPath, ".git"))).toBe(true);
  });

  it("非 fast-forward 的 origin 历史导致 pull 失败时，自动 reclone 并成功", async () => {
    await syncRepoUnvalidated({ url: originDir, repoId: 301, reposDir });
    const localPath = getRepoLocalPath(reposDir, 301);

    // origin 历史改写（amend），本地 checkout 上一次 pull --ff-only 会失败
    execFileSync("git", ["commit", "--amend", "-m", "rewritten history"], { cwd: originDir });
    execFileSync("git", ["log", "-1"], { cwd: originDir }); // 触发确保 amend 生效，无实际断言

    const result = await syncRepoUnvalidated({ url: originDir, repoId: 301, reposDir });
    expect(result.ok).toBe(true);
    // reclone 之后应该拿到改写后的历史
    const log = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: localPath })
      .toString()
      .trim();
    expect(log).toBe("rewritten history");
  });

  it("forceReclone=true 跳过 pull 直接 clone", async () => {
    await syncRepoUnvalidated({ url: originDir, repoId: 302, reposDir });
    commitFile(originDir, "extra.txt", "x\n");
    const result = await syncRepoUnvalidated({
      url: originDir,
      repoId: 302,
      reposDir,
      forceReclone: true,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(result.localPath, "extra.txt"))).toBe(true);
  });
});

describe("syncAndPersist", () => {
  let reposDir: string, originDir: string, dbDir: string, dbPath: string, client: DbClient;
  let repoId: number;

  beforeEach(async () => {
    reposDir = mkdtempSync(join(tmpdir(), "repo-sync-repos-"));
    originDir = mkdtempSync(join(tmpdir(), "repo-sync-origin-"));
    initOriginRepo(originDir);
    const seeded = makeSeededDb();
    dbDir = seeded.dir;
    dbPath = seeded.dbPath;
    client = createDbClient(dbPath);
    repoId = await client.createRepo({ name: "r1", url: originDir });
  });

  afterEach(async () => {
    await client.close();
    rmSync(reposDir, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("成功时持久化 local_path/last_sync_status=ok/last_sync_sha(真实 rev-parse 输出)", async () => {
    const result = await syncAndPersistUnvalidated(client, { repoId, url: originDir, reposDir });
    expect(result.ok).toBe(true);

    const row = await client.getRepoAdmin(repoId);
    expect(row).not.toBeNull();
    expect(row!.last_sync_status).toBe("ok");
    expect(row!.local_path).toBe(getRepoLocalPath(reposDir, repoId));
    expect(row!.last_sync_sha).toMatch(/^[0-9a-f]{10}$/);

    // 交叉核实：sha 与真实 git rev-parse 输出一致
    const localPath = getRepoLocalPath(reposDir, repoId);
    const realSha = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: localPath })
      .toString()
      .trim();
    expect(row!.last_sync_sha).toBe(realSha);
  });

  it("失败时 last_sync_status=error，不写 local_path", async () => {
    const badUrl = "http://127.0.0.1/nope"; // SSRF 拒绝，必然失败
    const result = await syncAndPersist(client, { repoId, url: badUrl, reposDir });
    expect(result.ok).toBe(false);

    const row = await client.getRepoAdmin(repoId);
    expect(row!.last_sync_status).toBe("error");
    expect(row!.local_path).toBeNull();
  });

  it("成功时调用 onSyncSuccess(repoId, localPath)，且不阻塞返回（fire-and-forget）", async () => {
    const onSyncSuccess = vi.fn();
    const result = await syncAndPersistUnvalidated(
      client,
      { repoId, url: originDir, reposDir },
      onSyncSuccess
    );
    expect(result.ok).toBe(true);
    expect(onSyncSuccess).toHaveBeenCalledWith(repoId, getRepoLocalPath(reposDir, repoId));
  });

  it("同一 repoId 的两个并发调用被序列化，而不是并发 rmtree 出竞态", async () => {
    // 光凭 resolve 顺序（谁先 .then 到）证明不了真的序列化——两个调用即使
    // 内部并发跑 git，也可能凑巧按发起顺序 resolve。这里用真实的人为延迟给
    // 每一次 execFile 调用套一层：在真的跑 git 之前先等 DELAY_MS，同时记录
    // 每次调用的起止时间戳。如果 withRepoLock 没有真的序列化（比如两个
    // clone 并发抢同一个 tmpPath），两次 git 调用的时间窗口会重叠；如果真的
    // 序列化了，后一次的开始时间必然不早于前一次的结束时间——DELAY_MS 远大于
    // Date.now() 的毫秒级抖动，所以这个断言不会因为时钟精度而 flaky。
    const DELAY_MS = 60;
    const passthroughExecFile = mockedExecFile.getMockImplementation()!;
    const invocations: { start: number; end: number }[] = [];

    mockedExecFile.mockImplementation(((...args: unknown[]) => {
      const start = Date.now();
      const rec = { start, end: start };
      invocations.push(rec);
      const cb = args[args.length - 1] as (...cbArgs: unknown[]) => void;
      const rest = args.slice(0, -1);
      setTimeout(() => {
        (passthroughExecFile as (...a: unknown[]) => void)(...rest, (...cbArgs: unknown[]) => {
          rec.end = Date.now();
          cb(...cbArgs);
        });
      }, DELAY_MS);
    }) as typeof execFileCb);

    let r1: { ok: boolean; message: string }, r2: { ok: boolean; message: string };
    try {
      [r1, r2] = await Promise.all([
        syncAndPersistUnvalidated(client, { repoId, url: originDir, reposDir }),
        syncAndPersistUnvalidated(client, { repoId, url: originDir, reposDir }),
      ]);
    } finally {
      mockedExecFile.mockImplementation(passthroughExecFile as typeof execFileCb);
    }

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // 两次 syncAndPersist 各自至少跑一次 clone（还可能有一次 rev-parse）——
    // 至少两次真实 git 调用发生过，且没有任何一次和另一次的时间窗口重叠。
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    invocations.sort((a, b) => a.start - b.start);
    for (let i = 1; i < invocations.length; i++) {
      expect(invocations[i].start).toBeGreaterThanOrEqual(invocations[i - 1].end);
    }

    const localPath = getRepoLocalPath(reposDir, repoId);
    expect(existsSync(join(localPath, ".git"))).toBe(true);
  });
});

describe("默认 onSyncSuccess —— buildIndex 重新排队到 per-repo 锁", () => {
  let reposDir: string, originDir: string, dbDir: string, dbPath: string, client: DbClient;
  let repoId: number;

  beforeEach(async () => {
    reposDir = mkdtempSync(join(tmpdir(), "repo-sync-repos-"));
    originDir = mkdtempSync(join(tmpdir(), "repo-sync-origin-"));
    initOriginRepo(originDir);
    const seeded = makeSeededDb();
    dbDir = seeded.dir;
    dbPath = seeded.dbPath;
    client = createDbClient(dbPath);
    repoId = await client.createRepo({ name: "r1", url: originDir });
    mockedBuildIndex.mockReset();
  });

  afterEach(async () => {
    await client.close();
    rmSync(reposDir, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
    mockedBuildIndex.mockReset();
  });

  // v1 的 _background_build_index 在跑 ctags 之前会 `async with
  // _get_repo_lock(repo_id)` 重新拿一次锁——目的是让"admin 强制 reclone、
  // rmtree 掉 checkout"不会和"上一次 sync 遗留的后台 buildIndex 还在读同一个
  // checkout"发生竞态。这条测试证明 Node 这边的默认 onSyncSuccess 复刻了这个
  // 语义：真的把 buildIndex 重新排进同一把 per-repo 锁，而不是纯粹
  // fire-and-forget、对锁一无所知。
  //
  // 证明手法和上面"两个并发调用被序列化"那条测试同源：给 buildIndex 一个人为
  // 延迟并记录它的起止时间窗，紧接着立刻发起第二次 sync（同一个 repoId，
  // forceReclone），记录第二次 sync 真正开始跑 git 的时间。如果 buildIndex
  // 真的重新排进了锁，第二次 sync 的 git 调用必然不会早于 buildIndex 结束；
  // 如果没排进锁（当前的 bug），两者会在时间窗上重叠。
  it("buildIndex 排在锁的队列里，紧随其后的第二次 sync 不会和它时间窗口重叠", async () => {
    const BUILD_INDEX_DELAY_MS = 80;
    const buildIndexWindow = { start: 0, end: 0 };
    mockedBuildIndex.mockImplementation(async () => {
      buildIndexWindow.start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, BUILD_INDEX_DELAY_MS));
      buildIndexWindow.end = Date.now();
      return true;
    });

    // 第一次 sync：成功，触发默认 onSyncSuccess -> 排队 buildIndex（不等它）。
    const r1 = await __internal.defaultOnSyncSuccessUnvalidated(client, {
      repoId,
      url: originDir,
      reposDir,
    });
    expect(r1.ok).toBe(true);

    // 第二次 sync：紧接着发起（forceReclone），同一个 repoId。它自己也要过
    // withRepoLock，所以如果 buildIndex 真排进了锁，这次 await 会一直等到
    // buildIndex 跑完才真正开始 git clone。
    const secondSyncCalledAt = Date.now();
    const r2 = await __internal.defaultOnSyncSuccessUnvalidated(client, {
      repoId,
      url: originDir,
      reposDir,
      forceReclone: true,
    });
    const secondSyncDoneAt = Date.now();

    expect(r2.ok).toBe(true);
    // 两次 sync 各自成功一次，各自的默认 onSyncSuccess 都会排一次 buildIndex——
    // 第一次是这条测试真正盯的那次（人为拖慢、量它的时间窗）；第二次是 r2 自己
    // 触发的，不影响下面的时序断言（r2 的 await 不等它自己排的这次 buildIndex）。
    expect(mockedBuildIndex).toHaveBeenCalledTimes(2);
    expect(mockedBuildIndex.mock.calls[0]).toEqual([getRepoLocalPath(reposDir, repoId)]);

    // buildIndex 必须已经跑完（它的结束时间点必须落在"第二次 sync 发起"和
    // "第二次 sync 完成"这段区间之内，且第二次 sync 的总耗时必须覆盖到
    // BUILD_INDEX_DELAY_MS——如果第二次 sync 完全没等 buildIndex，
    // secondSyncDoneAt - secondSyncCalledAt 会远小于 BUILD_INDEX_DELAY_MS）。
    expect(buildIndexWindow.end).toBeGreaterThan(0);
    expect(secondSyncDoneAt - secondSyncCalledAt).toBeGreaterThanOrEqual(BUILD_INDEX_DELAY_MS);
    expect(buildIndexWindow.end).toBeLessThanOrEqual(secondSyncDoneAt);
  });
});

describe("两阶段索引构建 —— chunk 收集 + embedding（Phase 4b Task 5）", () => {
  let reposDir: string, originDir: string, dbDir: string, dbPath: string, client: DbClient;
  let repoId: number;

  beforeEach(async () => {
    reposDir = mkdtempSync(join(tmpdir(), "repo-sync-repos-"));
    originDir = mkdtempSync(join(tmpdir(), "repo-sync-origin-"));
    initOriginRepo(originDir);
    addMapperXmlFile(originDir); // 给 collectChunks 一份保证非空的 chunk 来源
    const seeded = makeSeededDb();
    dbDir = seeded.dir;
    dbPath = seeded.dbPath;
    client = createDbClient(dbPath);
    repoId = await client.createRepo({ name: "r1", url: originDir });
    mockedBuildIndex.mockReset();
    mockBuildIndexSuccess();
  });

  afterEach(async () => {
    await client.close();
    rmSync(reposDir, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
    mockedBuildIndex.mockReset();
    vi.unstubAllGlobals();
  });

  // 必须是这个新 describe 块里第一条调用 configureIndexing 之前跑的测试——
  // configureIndexing 写的是模块级单例状态，在同一个测试文件里没有测试专用
  // 的重置入口（本任务的 brief 也没有要求一个），所以"从未配置"这个前提只有
  // 在文件里任何一次 configureIndexing 调用发生之前才成立。下面两条测试都会
  // 调 configureIndexing，因此这条必须排在它们前面。
  it("未调用 configureIndexing 时，defaultOnSyncSuccess 只建 ctags 索引、不尝试 embed，也不报错", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await __internal.defaultOnSyncSuccessUnvalidated(client, {
      repoId,
      url: originDir,
      reposDir,
    });
    expect(result.ok).toBe(true);

    const localPath = getRepoLocalPath(reposDir, repoId);
    // ctags 阶段确实跑了（mockBuildIndexSuccess 落的 sidecar 文件出现），
    // 证明"跳过 embed"不是因为整个两阶段构建都没触发。
    await waitFor(() => existsSync(symbolIndex.indexPath(localPath)));

    // 给 fire-and-forget 的构建流程一点时间——如果它错误地尝试了 embed，
    // fetch 会在这个窗口内被调用；没配置时它永远不应该被调用。
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readEmbeddingIndex(localPath)).toBeNull();
  });

  it("调用 configureIndexing 后，一次真实 sync 成功后能读到 .emb.v1.bin（mock fetch 提供 embedding 响应）", async () => {
    const dims = 4;
    configureIndexing(makeEmbeddingSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) }));
    const fetchMock = makeEmbeddingFetchMock(dims);
    vi.stubGlobal("fetch", fetchMock);

    const result = await __internal.defaultOnSyncSuccessUnvalidated(client, {
      repoId,
      url: originDir,
      reposDir,
    });
    expect(result.ok).toBe(true);

    const localPath = getRepoLocalPath(reposDir, repoId);
    await waitFor(() => readEmbeddingIndex(localPath) !== null);

    expect(fetchMock).toHaveBeenCalled();
    const index = readEmbeddingIndex(localPath)!;
    expect(index.dims).toBe(dims);
    expect(index.meta.length).toBeGreaterThan(0);
    expect(index.meta.some((m) => m.path.endsWith("Foo.xml"))).toBe(true);
  });

  it("embed 阶段不持有仓库锁——紧随其后的第二次 sync 不必等它跑完", async () => {
    const dims = 4;
    const EMBED_DELAY_MS = 200;
    configureIndexing(makeEmbeddingSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) }));
    const fetchMock = makeEmbeddingFetchMock(dims, EMBED_DELAY_MS);
    vi.stubGlobal("fetch", fetchMock);

    const r1 = await __internal.defaultOnSyncSuccessUnvalidated(client, {
      repoId,
      url: originDir,
      reposDir,
    });
    expect(r1.ok).toBe(true);

    // 紧接着发起第二次 sync（普通 pull，仓库已经 clone 过）。ctags+chunk
    // 收集阶段仍然在锁内、很快；embedding 阶段（EMBED_DELAY_MS 之后才会
    // resolve 的 mock fetch）在锁外——第二次 sync 的 git 操作不应该被它拖慢。
    const secondStart = Date.now();
    const r2 = await __internal.defaultOnSyncSuccessUnvalidated(client, {
      repoId,
      url: originDir,
      reposDir,
    });
    const secondDuration = Date.now() - secondStart;

    expect(r2.ok).toBe(true);
    expect(secondDuration).toBeLessThan(EMBED_DELAY_MS);

    // 确认 embed 阶段确实在后台跑完了（不是被完全跳过）——只是没有拖住 r2。
    const localPath = getRepoLocalPath(reposDir, repoId);
    await waitFor(() => readEmbeddingIndex(localPath) !== null);
  });
});

describe("syncAllRepos", () => {
  it("为每个带 url 的仓库调 syncAndPersist 落库，跳过没有 url 的仓库", async () => {
    const seeded = makeSeededDb();
    const client = createDbClient(seeded.dbPath);
    const reposDir = mkdtempSync(join(tmpdir(), "repo-sync-all-"));
    const idWithUrl = await client.createRepo({ name: "a", url: "http://127.0.0.1/x" });
    const idNoUrl = await client.createRepo({ name: "b", url: "" });

    // 用 SSRF 会拒绝的 host 保持这个测试快且离线——syncAllRepos 的职责是
    // "遍历 + 过滤 + 落库聚合"，不是重新验证 clone 机制本身（那部分见上面
    // syncRepo/syncAndPersist 的测试块）。
    await syncAllRepos(
      client,
      [
        { id: idWithUrl, name: "a", url: "http://127.0.0.1/x" },
        { id: idNoUrl, name: "b", url: "" },
      ],
      reposDir
    );

    const rowWithUrl = await client.getRepoAdmin(idWithUrl);
    expect(rowWithUrl!.last_sync_status).toBe("error"); // 被 SSRF 挡，但确实跑过了

    const rowNoUrl = await client.getRepoAdmin(idNoUrl);
    expect(rowNoUrl!.last_sync_status).toBeNull(); // 空 url 被过滤掉，从未触发同步

    await client.close();
    rmSync(seeded.dir, { recursive: true, force: true });
    rmSync(reposDir, { recursive: true, force: true });
  });
});

describe("periodicSyncLoop", () => {
  const fakeDb = {} as unknown as DbClient; // 两个测试都不会真的碰 DB（fetchRepos 要么不被调，要么返回 []）

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("interval<=0 时完全不调度，stop() 是安全的 no-op", () => {
    const fetchRepos = vi.fn();
    const { stop } = periodicSyncLoop(0, fetchRepos, fakeDb, "/tmp/does-not-matter");
    vi.advanceTimersByTime(60 * 60_000);
    expect(fetchRepos).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it("按间隔调用 fetchRepos，stop() 后不再触发", async () => {
    const fetchRepos = vi.fn().mockResolvedValue([]);
    const { stop } = periodicSyncLoop(1, fetchRepos, fakeDb, "/tmp/does-not-matter");

    expect(fetchRepos).not.toHaveBeenCalled(); // 第一次间隔到之前不触发
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchRepos).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchRepos).toHaveBeenCalledTimes(1); // stop 之后不再调度下一轮
  });
});
