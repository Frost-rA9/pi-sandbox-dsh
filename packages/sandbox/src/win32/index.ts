/**
 * pi-sandbox-dsh-sandbox · winacl（Windows 受限令牌 + NTFS ACE）win32 层入口。
 *
 * 单一源 = dsh `sandbox/sandbox-windows-acl`（结构、语义、失败处理逐项对齐）：
 * - `acl-sandbox.ts`：`AclSandbox`（受限令牌 + 写 SID grant + spawn 组装）。
 * - `token.ts` / `acl.ts` / `grant.ts` / `spawn.ts` / `process.ts` / `ffi.ts`：
 *   令牌构建、DACL 读写（含 per-path LockFileEx 串行化）、grant 生命周期、受限 spawn、koffi 绑定。
 * - `runner.ts`：argv-prefix 包装器（在独立 Node 子进程里执行全部 Win32 逻辑）。
 *
 * 平台约定：本层是 **Windows-only**。pi 宿主是 Bun，**不能加载 koffi**，所以宿主侧只做两件事：
 * 静态 import 本模块（不触发原生调用）＋ spawn `node runner.ts` 子进程。宿主 ↔ runner 的 argv
 * 契约放在 `runner-contract.ts`（纯函数、无原生依赖），供宿主单独 import。
 */
export * from "./acl-sandbox.ts";
export { assertPrivateTempDisjoint } from "./path-boundary.ts";
