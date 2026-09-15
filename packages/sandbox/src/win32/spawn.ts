/**
 * pi-sandbox-dsh-sandbox · 受限令牌 spawn 适配层。
 *
 * 单一源 = dsh `sandbox-windows-acl/src/spawn.ts`（去掉 dsh 的 control-pipe 透传：
 * pi 没有子进程控制面这个概念）。
 */
import { drainPipe, spawnInheritedJobProcess, spawnPipedProcess, waitForProcessExit } from "./process.ts";
import type { SpawnedJobProcess, SpawnedPipedProcess } from "./process.ts";
import type { NativePtr, Win32Bindings } from "./ffi.ts";

export { drainPipe };

/** 管道 stdio 的受限子进程。 */
export type SpawnedNative = SpawnedPipedProcess;
/** 挂入 kill-on-close Job 的受限子进程。 */
export type SpawnedInherited = SpawnedJobProcess;

/**
 * 以受限令牌拉起管道 stdio 子进程。
 * @param api - 令牌/ACE 绑定表。
 * @param token - 受限主令牌。
 * @param options - 命令、参数与工作目录。
 * @returns 进程与调用方持有的管道句柄。
 */
export function spawnSandboxed(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): SpawnedNative {
  return spawnPipedProcess(api, { ...options, token });
}

/**
 * 以受限令牌拉起继承 stdio 的子进程，挂入 kill-on-close Job。
 * @param api - 令牌/ACE 绑定表。
 * @param token - 受限主令牌。
 * @param options - 命令、参数与工作目录。
 * @returns 分配并恢复执行后的进程与 Job 句柄。
 */
export function spawnSandboxedInherited(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): SpawnedInherited {
  return spawnInheritedJobProcess(api, { ...options, token });
}

/**
 * 等待受限子进程并关闭其进程句柄。
 * @param api - 令牌/ACE 绑定表。
 * @param process - 调用方持有的进程句柄。
 * @returns 直接退出码。
 */
export function waitForExit(api: Win32Bindings, process: NativePtr): number {
  return waitForProcessExit(api, process);
}
