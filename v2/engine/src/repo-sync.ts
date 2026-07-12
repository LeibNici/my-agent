// 仓库同步 —— git clone/pull 到本地存储，端口自 v1 的 app/repo_sync.py（asyncio
// subprocess 模型），换成 Node child_process。逐函数对照迁移，语义保持一致；
// 差异点在各函数注释里标注。

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { DbClient } from "./db/client.js";
import type { UpdateRepoFields } from "./db/storage.js";
import { pyLocalIsoNow } from "./db/py-compat.js";
import { buildIndex } from "./tools/symbol-index.js";

const GIT_TIMEOUT_MS = 120_000;

// URL 的 userinfo 部分（"user:pass@" 或 "token@"）——既用于清理回显给客户端的
// URL，也用于清理 git 报错文本里可能带出的凭证（git 的出错信息经常原样回显
// 它当时在连的 URL）。
const CREDENTIALS_RE = /:\/\/[^/@\s]+@/g;

function redactCredentials(text: string): string {
  return text.replace(CREDENTIALS_RE, "://***@");
}

/**
 * 剥离 URL 里嵌入的 userinfo（user:token@），任何要暴露给客户端的 URL 都要过
 * 这一层——非管理员和管理员的仓库视图共用，这样即便有人把凭证直接粘进 url
 * 字段（而不是走专门的 cred_username/cred_token 字段），也不会被原样回显。
 */
export function maskUrlCredentials(url: string): string {
  return (url || "").replace(CREDENTIALS_RE, "://");
}

/**
 * 构造携带凭证的 `-c http.extraheader=...` git 参数（HTTP Basic Auth header），
 * 仅对本次调用生效。
 *
 * 故意不嵌入到远程 URL 里：git 会把给它的 URL 原样持久化进 checkout 的
 * `.git/config`，嵌在 URL 里的凭证就会明文永久躺在磁盘上，每次后续 pull 都在。
 * 用一次性的 `-c` 配置传递，磁盘上的 remote 就始终不带凭证——pull_repo 每次
 * 调用都重新提供一份新鲜的 header，而不依赖 clone 时持久化下来的任何东西。
 *
 * 只设了 token 没设 username 时，token 裸值当 Basic auth 的用户名用——大多数
 * host（GitHub、GitLab 的 PAT）都认这个约定。
 */
function credentialHeaderArgs(
  credUsername?: string | null,
  credToken?: string | null
): string[] {
  if (!credUsername && !credToken) return [];
  const userpass = credUsername ? `${credUsername}:${credToken ?? ""}` : (credToken as string);
  const encoded = Buffer.from(userpass).toString("base64");
  return ["-c", `http.extraheader=Authorization: Basic ${encoded}`];
}

export function getRepoLocalPath(reposDir: string, repoId: number): string {
  return path.join(reposDir, String(repoId));
}

// SSRF 防护：拒绝解析到 loopback/private/link-local 地址的 host。范围表对照
// brief 给出的清单（v1 用 Python `ipaddress.is_loopback/is_private/
// is_link_local/is_reserved`，覆盖面更广——比如 0.0.0.0/8、multicast 等 v1
// 的 is_reserved 也会挡，这里没有一一复刻，只挡 brief 列出的这几段）。
//
// 用 node:net 的 BlockList 而不是手写 CIDR 判断：BlockList.addSubnet +
// .check() 本来就是给这种场景设计的内置 API（Node 15+），比手撸 IPv6 的零压缩
// 展开/前缀位判断可靠得多——尤其 IPv6 地址有多种等价书写形式（`::1` vs
// `0:0:0:0:0:0:0:1`），手写解析很容易漏掉某种形式；BlockList 内部处理这些。
const PRIVATE_BLOCKLIST = new BlockList();
PRIVATE_BLOCKLIST.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("169.254.0.0", 16, "ipv4"); // 含云元数据地址 169.254.169.254
PRIVATE_BLOCKLIST.addSubnet("::1", 128, "ipv6");
PRIVATE_BLOCKLIST.addSubnet("fc00::", 7, "ipv6");
PRIVATE_BLOCKLIST.addSubnet("fe80::", 10, "ipv6");

/**
 * 拒绝解析到 loopback/private/link-local 地址的 host，降低管理员填的 clone
 * URL 带来的 SSRF 风险。
 */
async function isDisallowedHost(host: string): Promise<boolean> {
  const literalVersion = isIP(host); // 0 = 不是字面 IP，4/6 = IP 版本
  if (literalVersion === 4) return PRIVATE_BLOCKLIST.check(host, "ipv4");
  if (literalVersion === 6) return PRIVATE_BLOCKLIST.check(host, "ipv6");
  // 不是字面 IP —— 走 DNS 解析，对照 v1 的 socket.gethostbyname
  // （dns.lookup 用 OS 解析器，是对应物）。解析失败：让 git 自己去踩这个错，
  // 不在这里挡（对照 v1 except 分支）。
  try {
    const { address, family } = await lookup(host);
    return PRIVATE_BLOCKLIST.check(address, family === 6 ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}

const ALLOWED_PROTOCOLS = ["https://", "http://", "git://"];

/** URL 不安全时返回错误信息，否则返回 null。 */
async function validateUrl(url: string): Promise<string | null> {
  if (!ALLOWED_PROTOCOLS.some((p) => url.startsWith(p))) {
    return "Invalid URL protocol: only https://, http://, and git:// are allowed";
  }
  let host: string | null = null;
  try {
    // WHATWG URL 给 IPv6 字面量 host 保留方括号（"[::1]"），但 isIP()/dns.lookup()
    // 都不认识带方括号的写法——isIP("[::1]") 返回 0（当成"不是字面 IP"），
    // lookup("[::1]") 直接 ENOTFOUND。两者都不 throw 出"这是私网地址"，而是
    // 分别走进"当成域名去 DNS 解析"和"解析失败→放行"这两条分支，SSRF 网关被
    // 整个绕过。剥掉外层方括号，让 isIP/lookup 看到的是裸地址。
    host = (new URL(url).hostname || null)?.replace(/^\[|\]$/g, "") ?? null;
  } catch {
    host = null;
  }
  if (host && (await isDisallowedHost(host))) {
    return `Refusing to sync from internal/private host: ${host}`;
  }
  return null;
}

type GitResult = { code: number; stdout: string; stderr: string };

/**
 * 跑一条 git 命令，带超时，返回 (code, stdout, stderr)。
 *
 * 对照 v1 的 `_run_git`：v1 用 asyncio.wait_for 包 proc.communicate()，超时/
 * 调用方 cancel 都会 kill 子进程再收尸。Node 这边用 execFile 自带的 `timeout`
 * 选项做超时 kill（内部就是到点发 SIGTERM），效果等价，不用自己再管一层
 * timer+kill。调用方 cancel-then-kill 那条路径（v1 的 asyncio.CancelledError
 * 分支）没有照搬——按 brief 的说法，这条路径没有测试覆盖要求，Node 里没有
 * "await 点被外部取消" 这种和 asyncio 对等的原语，强行加一个
 * AbortSignal 参数只是没人调用的摆设，先不加，见 report。
 */
function runGit(args: string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 200 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        if (err.killed) {
          resolve({
            code: 1,
            stdout: "",
            stderr: `git command timed out after ${GIT_TIMEOUT_MS / 1000}s`,
          });
          return;
        }
        const code = typeof err.code === "number" ? err.code : 1;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    );
  });
}

export type CloneRepoOptions = {
  url: string;
  repoId: number;
  reposDir: string;
  branch?: string | null;
  credUsername?: string | null;
  credToken?: string | null;
};

/**
 * clone 的实际机制（临时目录 clone→原子改名、凭证 header、错误脱敏），不做
 * URL 校验——校验是 `cloneRepo` 这层公开导出的职责。拆出这一层纯粹是为了
 * 测试:SSRF 网关必须挡掉的地址（127.0.0.1、169.254.169.254 这类）恰好就是
 * 离线沙箱里唯一"真的连得通"的地址，没有任何 host 能同时满足"离线可达"和
 * "通过 SSRF/协议校验"——这不是测试的不方便,是 SSRF 网关在正确地干它的活。
 * 所以"clone 机制本身对不对"（tmp-then-rename、凭证 header、失败清理……）
 * 用这个不做校验的核心直接对着本地临时目录跑真实 git 子进程测;"SSRF/协议
 * 校验挡没挡住"用公开的 `cloneRepo` 单独黑盒测（下面 SSRF 防护那个 describe
 * 块），两边互不遮蔽。生产路径上 `cloneRepo`/`syncRepo`/`syncAndPersist`
 * 永远先过 `validateUrl` 再到这里，和 v1 的 clone_repo 语义完全一致。
 */
async function cloneRepoCore(
  opts: CloneRepoOptions
): Promise<{ ok: boolean; message: string }> {
  const { url, repoId, reposDir, branch, credUsername, credToken } = opts;
  const localPath = getRepoLocalPath(reposDir, repoId);
  const tmpPath = localPath + ".tmp";

  // 清理上一次失败尝试留下的临时目录
  if (fs.existsSync(tmpPath)) {
    fs.rmSync(tmpPath, { recursive: true, force: true });
  }

  fs.mkdirSync(reposDir, { recursive: true });

  const gitArgs = [...credentialHeaderArgs(credUsername, credToken), "clone", "--depth", "1"];
  if (branch) gitArgs.push("--branch", branch);
  gitArgs.push(url, tmpPath); // 干净的 url —— 从不携带嵌入的凭证

  const { code, stderr } = await runGit(gitArgs);

  if (code !== 0) {
    fs.rmSync(tmpPath, { recursive: true, force: true });
    return { ok: false, message: `Clone failed: ${redactCredentials(stderr.trim())}` };
  }

  // clone 成功 —— 原子地把旧 checkout（如果有）换成新的
  if (fs.existsSync(localPath)) {
    fs.rmSync(localPath, { recursive: true, force: true });
  }
  fs.renameSync(tmpPath, localPath);

  return {
    ok: true,
    message: `Cloned to ${localPath}` + (branch ? ` (branch: ${branch})` : ""),
  };
}

/**
 * 把仓库 clone 到本地存储。branch 留空则 clone 远程默认分支（HEAD）。
 *
 * 先 clone 进一个临时目录，只有 clone 成功才把它换到位——一次失败的 clone
 * （分支名不对、网络抖动……）永远不会破坏掉之前一个能用的 checkout。
 */
export async function cloneRepo(
  opts: CloneRepoOptions
): Promise<{ ok: boolean; message: string }> {
  const err = await validateUrl(opts.url);
  if (err) return { ok: false, message: err };
  return cloneRepoCore(opts);
}

export type PullRepoOptions = {
  repoId: number;
  reposDir: string;
  credUsername?: string | null;
  credToken?: string | null;
};

/**
 * 给一个已 clone 的仓库拉最新变更。checkout 的 remote URL 永远不带凭证
 * （clone_repo 从不把凭证持久化进去），所以这里也是通过和 clone 相同的
 * `-c http.extraheader` 机制现拼一份凭证，而不是从磁盘上的什么地方读。
 */
export async function pullRepo(
  opts: PullRepoOptions
): Promise<{ ok: boolean; message: string }> {
  const { repoId, reposDir, credUsername, credToken } = opts;
  const localPath = getRepoLocalPath(reposDir, repoId);

  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
    return { ok: false, message: `Repository not found at ${localPath}` };
  }

  const gitArgs = [...credentialHeaderArgs(credUsername, credToken), "pull", "--ff-only"];
  const { code, stdout, stderr } = await runGit(gitArgs, localPath);

  if (code !== 0) {
    return { ok: false, message: `Pull failed: ${redactCredentials(stderr.trim())}` };
  }

  return { ok: true, message: redactCredentials(stdout.trim()) || "Already up to date" };
}

export type SyncRepoOptions = {
  url: string;
  repoId: number;
  reposDir: string;
  branch?: string | null;
  forceReclone?: boolean;
  credUsername?: string | null;
  credToken?: string | null;
};

/**
 * Clone 或 pull 一个仓库。
 *
 * forceReclone 该由已经知道 (url, branch) 刚变过的调用方设置（比如管理员编辑
 * 了配置）——sync_repo 自己不再尝试通过查询 git 来探测配置漂移了，那种做法
 * 很脆：分支比对在 detached HEAD（tag/commit 当"分支"用）上会坏掉，把分支清回
 * "默认" 也会静默地什么都不做。调用方直接对比新旧配置，比从 git 里反推更可靠。
 *
 * 如果一次普通 pull 失败（比如一次 force-push 导致非 fast-forward），会自愈
 * 成一次全新 clone —— 安全，因为这些 clone 是只读的（没有任何工具会往里写），
 * 没有本地状态会丢。
 *
 * 本身不加锁 —— 唯一的调用方 syncAndPersist 的 clone/pull 本体、以及它成功后
 * 排队的索引重建（默认 onSyncSuccess，见 defaultOnSyncSuccess），全程都串在
 * 同一把 per-repo 锁的队列里（先后顺序严格保序，但锁在两段之间有一个短暂的
 * 释放-重新获取的缝隙，不是从头到尾连续持有同一次加锁）。所以同一个仓库的
 * 第二次 sync 永远不会插队到前一次 sync 的索引重建前面，也就不会观察到或
 * 竞争一个写到一半的 checkout。
 *
 * 按 cloneFn 参数化（默认真正校验 URL 的 `cloneRepo`），理由同 cloneRepoCore
 * 顶部注释——测试 pull-fails-then-reclone 自愈这条路径需要对一个真实本地
 * 临时目录跑真实 git，同时又不能绕开生产路径上的 SSRF 校验。
 */
async function syncRepoImpl(
  opts: SyncRepoOptions,
  cloneFn: (o: CloneRepoOptions) => Promise<{ ok: boolean; message: string }>
): Promise<{ ok: boolean; message: string; localPath: string }> {
  const { url, repoId, reposDir, branch, forceReclone, credUsername, credToken } = opts;
  const localPath = getRepoLocalPath(reposDir, repoId);
  const alreadyCloned = fs.existsSync(path.join(localPath, ".git"));

  let result: { ok: boolean; message: string };
  if (alreadyCloned && !forceReclone) {
    result = await pullRepo({ repoId, reposDir, credUsername, credToken });
    if (!result.ok) {
      result = await cloneFn({ url, repoId, reposDir, branch, credUsername, credToken });
    }
  } else {
    result = await cloneFn({ url, repoId, reposDir, branch, credUsername, credToken });
  }

  return { ...result, localPath };
}

export async function syncRepo(
  opts: SyncRepoOptions
): Promise<{ ok: boolean; message: string; localPath: string }> {
  return syncRepoImpl(opts, cloneRepo);
}

// 每仓库一把锁，让 periodic sync、手动 sync、create/update 触发的 sync 永远
// 不会在同一个磁盘 checkout 上互相竞争。用 Promise 链模拟 asyncio.Lock：
// 每次调用把自己接在上一次调用的"尾巴"promise 后面，不管上一次成功还是失败
// 都放行下一个（asyncio.Lock 的 release 语义在 finally 里，无论成败都放）。
const repoLocks = new Map<number, Promise<void>>();

function withRepoLock<T>(repoId: number, fn: () => Promise<T>): Promise<T> {
  const tail = repoLocks.get(repoId) ?? Promise.resolve();
  const result = tail.then(fn, fn);
  repoLocks.set(
    repoId,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}

export type SyncAndPersistOptions = {
  repoId: number;
  url: string;
  reposDir: string;
  branch?: string | null;
  forceReclone?: boolean;
  credUsername?: string | null;
  credToken?: string | null;
};

/**
 * Sync 一个仓库，成功时把结果持久化。是"先 sync 再存结果"这套流程唯一的
 * 实现处 —— 启动时、周期性循环、每一次管理员触发的 sync 都调这个，而不是
 * 各自手搓一遍"sync 然后可能要存"的逻辑。
 *
 * 索引重建不在这里 await（对照 v1 的 asyncio.create_task 拆成后台任务），
 * 所以管理员的 create/update/手动 sync API 调用一旦 git 跑完就能返回，
 * 不用连带等 ctags 建完。这里换成显式的 onSyncSuccess 回调而不是 v1 那种
 * 运行时 `from app.tools.symbol_index import build_index` 的动态 import——
 * 索引构建是 Task 6 的活，这里不知道它、也不该 import 它；onSyncSuccess 是
 * fire-and-forget（不 await）——"排队到 per-repo 锁"这件事不是靠调用方各自
 * 记得做，是下面默认挂的 `defaultOnSyncSuccess` 自己内部重新拿一次锁（对照
 * v1 的 _background_build_index，见那里的注释）。显式传入别的 onSyncSuccess
 * （比如测试用 vi.fn() 探针）会整个覆盖掉这个默认实现，自然也就不再有这层
 * 锁保护——调用方主动选择绕开时，后果自负。
 *
 * 按 syncFn 参数化（默认真正校验 URL 的 `syncRepo`），理由同上——测试
 * updateRepo 落库 + last_sync_sha + 并发序列化这几件事需要对一个真实本地
 * 临时目录跑真实 git。
 */
async function syncAndPersistImpl(
  db: DbClient,
  opts: SyncAndPersistOptions,
  onSyncSuccess: ((repoId: number, localPath: string) => void) | undefined,
  syncFn: (
    o: SyncRepoOptions
  ) => Promise<{ ok: boolean; message: string; localPath: string }>
): Promise<{ ok: boolean; message: string }> {
  const { repoId, url, reposDir, branch, forceReclone, credUsername, credToken } = opts;

  return withRepoLock(repoId, async () => {
    const result = await syncFn({
      url,
      repoId,
      reposDir,
      branch,
      forceReclone,
      credUsername,
      credToken,
    });
    const now = pyLocalIsoNow();

    if (result.ok) {
      // 刚同步完的 checkout 的 HEAD —— 在管理后台仓库页展示，让管理员一眼
      // 看出助手当前的代码分析基于哪个具体 commit。rev-parse 失败时字段
      // 干脆不传（对照 v1 把 sha 留 None 时 update_repo 不碰这一列）——一次
      // 瞬时的 rev-parse 抖动不该抹掉之前记录的好 sha，让管理后台显示
      // "unknown"，明明这个 checkout 其实是好的。
      const rev = await runGit(["rev-parse", "--short=10", "HEAD"], result.localPath);
      const fields: UpdateRepoFields = {
        localPath: result.localPath,
        lastSyncAt: now,
        lastSyncStatus: "ok",
        lastSyncMessage: result.message,
      };
      if (rev.code === 0) {
        fields.lastSyncSha = rev.stdout.trim();
      }
      await db.updateRepo(repoId, fields);
    } else {
      await db.updateRepo(repoId, {
        lastSyncAt: now,
        lastSyncStatus: "error",
        lastSyncMessage: result.message,
      });
    }

    if (result.ok) {
      onSyncSuccess?.(repoId, result.localPath);
    }

    return { ok: result.ok, message: result.message };
  });
}

// Task 6 挂的默认 onSyncSuccess —— 模块级 import buildIndex（symbol-index.ts
// 不反向依赖 repo-sync.ts，两者本就在同一 Node 进程里，不像 v1 要担心动态
// import 的时机）。对 syncAndPersistImpl 而言仍是 fire-and-forget（这里自己
// `void withRepoLock(...)`，不 await，syncAndPersistImpl 也不等它返回）——
// 触发它的 create/update/手动 sync API 调用一旦 git 跑完就能返回，不用连带
// 等 ctags 建完。
//
// 但 fire-and-forget 不等于对锁一无所知：ctags 扫描要读整个 checkout，如果
// admin 紧接着一次 force-reclone 把 checkout rmtree 掉，这次 buildIndex 就
// 在读一个正被删除/替换的目录——非崩溃性但会读到残缺/不存在的文件。所以像
// v1 的 _background_build_index 那样，在真正跑 buildIndex 之前重新
// `withRepoLock(repoId, ...)` 排队：这次 buildIndex 会排在"触发它的那次
// sync"释放锁之后、"下一次 sync"拿到锁之前，两者不会再共享同一个 checkout
// 目录的读写窗口。锁在 buildIndex 跑的时候被重新持有，而不是从触发它的那次
// sync 起就没释放过——中间有一个短暂的“未上锁”缝隙，和 v1 两个独立的
// `async with` 块语义一致，不是一次连续加锁。
function defaultOnSyncSuccess(repoId: number, localPath: string): void {
  void withRepoLock(repoId, () => buildIndex(localPath));
}

export async function syncAndPersist(
  db: DbClient,
  opts: SyncAndPersistOptions,
  // 显式传入 onSyncSuccess（包括显式传 undefined，见 syncAllRepos/
  // periodicSyncLoop 的透传）会覆盖这个默认值——调用方（比如测试）想绕开
  // 索引重建、换一个 mock 时依然可以，但也就不再享有上面这层锁保护。
  onSyncSuccess: (repoId: number, localPath: string) => void = defaultOnSyncSuccess
): Promise<{ ok: boolean; message: string }> {
  return syncAndPersistImpl(db, opts, onSyncSuccess, syncRepo);
}

// 仅供测试使用：绕开 validateUrl，直接跑 clone/sync/persist 的真实机制。
// 生产代码路径（上面的 cloneRepo/syncRepo/syncAndPersist）永远先过
// validateUrl —— 这个绕行口只在测试文件里用得到，理由见 cloneRepoCore 顶部
// 的注释。不是 Task 3 brief 列出的 6 个正式导出之一，调用方（Task 6/7 等
// 后续任务）不应该依赖这个符号。
export const __internal = {
  cloneRepoUnvalidated: cloneRepoCore,
  syncRepoUnvalidated: (opts: SyncRepoOptions) => syncRepoImpl(opts, cloneRepoCore),
  syncAndPersistUnvalidated: (
    db: DbClient,
    opts: SyncAndPersistOptions,
    onSyncSuccess?: (repoId: number, localPath: string) => void
  ) => syncAndPersistImpl(db, opts, onSyncSuccess, (o) => syncRepoImpl(o, cloneRepoCore)),
  // syncAndPersistUnvalidated 在 onSyncSuccess 被省略时传的是字面 undefined
  // 给 syncAndPersistImpl（一个已经声明了形参、没有默认值的普通函数），JS
  // 不会在那一层触发 `syncAndPersist` 导出函数自己的默认参数替换——那个默认
  // 值只存在于 `syncAndPersist` 这个具名导出的参数列表里。所以要在测试里对
  // 一个真实本地 origin 目录（validateUrl 会拒绝的那种）验证"生产真正会用的
  // 默认 onSyncSuccess 是否重新排队到锁"，需要单独一个绕开 validateUrl、但
  // 仍然接上 defaultOnSyncSuccess 的入口——否则测试只能验到自己传的 mock，
  // 验不到默认实现本身。
  defaultOnSyncSuccessUnvalidated: (db: DbClient, opts: SyncAndPersistOptions) =>
    syncAndPersistImpl(db, opts, defaultOnSyncSuccess, (o) => syncRepoImpl(o, cloneRepoCore)),
  // 同上，供 startServer()（src/server/main.ts）的 e2e 测试用：main.ts 启动时
  // 跑的是公开的 syncAllRepos（过 validateUrl），e2e 测试要对一个真实本地
  // origin 目录验证"启动确实同步成功了"，需要绕开 SSRF 网关的同款入口——
  // main.ts 自己的 StartServerOptions.syncAllRepos 注入点默认还是走生产的
  // 真实实现，只有测试显式传这个才会换成不校验 URL 的版本，和
  // admin-routes.ts 的 deps.syncAndPersist 注入是同一套模式。
  syncAllReposUnvalidated: (
    db: DbClient,
    repos: RepoSyncDescriptor[],
    reposDir: string,
    onSyncSuccess?: (repoId: number, localPath: string) => void
  ) =>
    syncAllReposImpl(db, repos, reposDir, onSyncSuccess, (d, o, cb) =>
      syncAndPersistImpl(d, o, cb, (oo) => syncRepoImpl(oo, cloneRepoCore))
    ),
};

export type RepoSyncDescriptor = {
  id: number;
  name: string;
  url: string;
  branch?: string | null;
  credUsername?: string | null;
  credToken?: string | null;
};

/**
 * 并发 sync 一批仓库。启动时和周期性循环都调这个 —— 每个仓库已经有自己的锁
 * (withRepoLock)，没有理由串行同步，串行只会让一个慢/挂住的远程拖住排在它
 * 后面的所有仓库。
 *
 * 对照 v1 的 sync_all_repos(repos: list[dict])：v1 的 repos 直接来自
 * `SELECT *`（带凭证）；Node 这边的 DbClient.listRepos() 是给客户端用的
 * 精简列（不带 cred_username/cred_token），所以这里同样把 repos 列表作为
 * 参数交给调用方负责组装（而不是自己去查 DB），调用方（Task 6/7 或后续的
 * server 启动流程）用 getRepoAdmin 之类拿到带凭证的全量行再传进来。
 */
async function syncAllReposImpl(
  db: DbClient,
  repos: RepoSyncDescriptor[],
  reposDir: string,
  onSyncSuccess: ((repoId: number, localPath: string) => void) | undefined,
  syncAndPersistFn: (
    db: DbClient,
    opts: SyncAndPersistOptions,
    onSyncSuccess?: (repoId: number, localPath: string) => void
  ) => Promise<{ ok: boolean; message: string }>
): Promise<void> {
  await Promise.all(
    repos
      .filter((repo) => repo.url)
      .map(async (repo) => {
        const result = await syncAndPersistFn(
          db,
          {
            repoId: repo.id,
            url: repo.url,
            reposDir,
            branch: repo.branch,
            credUsername: repo.credUsername,
            credToken: repo.credToken,
          },
          onSyncSuccess
        );
        const status = result.ok ? "✅" : "❌";
        console.log(`  ${status} [${repo.name}] ${result.message}`);
      })
  );
}

export async function syncAllRepos(
  db: DbClient,
  repos: RepoSyncDescriptor[],
  reposDir: string,
  onSyncSuccess?: (repoId: number, localPath: string) => void
): Promise<void> {
  return syncAllReposImpl(db, repos, reposDir, onSyncSuccess, syncAndPersist);
}

/**
 * 后台任务：按固定间隔重新 sync 所有仓库，直到被 stop()。interval 为假值
 * （0/负数）时整个周期性 sync 直接不开（启动时/手动 sync 仍然照常工作）。
 *
 * 对照 v1 的 periodic_sync_loop(interval_minutes)：v1 内部直接 `await
 * list_repos()` 拿全量行（含凭证），再传给 sync_all_repos。Node 的
 * DbClient 没有对等的"列出全部仓库且带凭证"方法（listRepos() 是刻意裁剪过
 * 的客户端安全视图），硬去查会要么静默丢凭证（私有仓库的周期性重同步全部
 * 失效，是真实的行为倒退）要么得在这个文件里新造一个越界的 DB 方法。两条
 * 都不对，所以这里把"怎么拿到带凭证的仓库列表"做成注入的 fetchRepos 参数，
 * 由调用方（拥有 getRepoAdmin 权限的那一层）提供 —— periodicSyncLoop 自己
 * 不读 settings、也不碰 DB 的具体读法，只认一个数字和两个回调。
 *
 * v1 靠 asyncio task 被 cancel 来停；Node 没有对等原语，所以这里返回一个
 * { stop } 句柄给调用方在进程关闭时清理定时器。
 */
export function periodicSyncLoop(
  intervalMinutes: number,
  fetchRepos: () => Promise<RepoSyncDescriptor[]>,
  db: DbClient,
  reposDir: string,
  onSyncSuccess?: (repoId: number, localPath: string) => void
): { stop: () => void } {
  if (!intervalMinutes || intervalMinutes <= 0) {
    return { stop: () => {} };
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, intervalMinutes * 60_000);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const repos = await fetchRepos();
      if (repos.length) {
        await syncAllRepos(db, repos, reposDir, onSyncSuccess);
      }
    } catch (e) {
      const label = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
      console.log(`  ❌ periodic repo sync failed: ${label}`);
    }
    scheduleNext();
  };

  scheduleNext();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
