// worker.ts 的真正入口是这个纯 .mjs 文件，而不是 worker.ts 本身。
//
// 原因（详见 task-3-report.md）：`new Worker(new URL("./worker.ts", ...), { execArgv:
// ["--import", "tsx"] })` 在 worker 线程里不生效 —— tsx 的自动 ESM hook 注册在其
// esm/index.mjs 里被 `isMainThread` 挡住了，只有主线程 `--import tsx` 才会自动注册；
// worker 线程里这段自注册直接被跳过，于是 worker.ts 里 `./storage.js` 这类 .js→.ts
// 的 specifier 重写全部失效，报 ERR_MODULE_NOT_FOUND。
//
// tsx 另外导出了一个不受 isMainThread 限制的编程式 API —— `tsx/esm/api` 的
// `tsImport()`，在调用方所在线程里手动跑一遍同样的 register/resolve/load 逻辑。
// 这个 bootstrap 就是在 worker 线程里手动调用它，加载真正的 worker.ts。
// workerData 由 Worker 构造函数注入，是线程级别的，与哪个模块发起 import 无关，
// 所以 worker.ts 内 `import { workerData } from "node:worker_threads"` 仍能拿到值。
import { tsImport } from "tsx/esm/api";

await tsImport("./worker.ts", import.meta.url);
