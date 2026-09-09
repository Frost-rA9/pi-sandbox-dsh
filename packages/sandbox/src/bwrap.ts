/**
 * pi-sandbox-dsh-sandbox · bwrap 写面后端（Linux/WSL2）。
 *
 * 单一参考源 = dsh（`sandbox-local/profiles.ts` `bwrapProfileArgs`），按 pi 裁剪：
 * - 只读基座 `--ro-bind / /`（读全开）+ workspace-write 追加 `--tmpfs /tmp` + `--bind <workspace>`。
 * - **无 `--unshare-net`**（网络共享，对齐 dsh "network outside vocabulary"）。
 * - **无敏感路径掩码**（不藏读，不 deny-read）。
 * - `--unshare-pid`：进程隔离（对齐 dsh）。
 */

import { spawnSync } from "node:child_process";
import type { SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";

/** 检测 bwrap 是否可用（Linux/WSL2；userns 实测正常）。 */
export function detectBwrap(): boolean {
  try {
    const r = spawnSync("bwrap", ["--version"], { timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

let bwrapDetect: () => boolean = detectBwrap;
export function overrideBwrapDetect(fn: () => boolean): void {
  bwrapDetect = fn;
}
export function probeBwrap(): boolean {
  return bwrapDetect();
}

/** 把原始命令嵌入 `sh -c '<cmd>'`（POSIX 单引号包裹，内部单引号转义）。 */
export function safeQuote(command: string): string {
  return `'${command.replace(/'/g, `'\\''`)}'`;
}

/** bwrap profile 参数（对齐 dsh `bwrapProfileArgs`，按 pi 裁剪可不含网络/凭据）。 */
export function bwrapProfileArgs(policy: SandboxExecutionPolicy): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"];
  if (policy.mode === "workspace-write") {
    args.push("--tmpfs", "/tmp");
    args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
  }
  return args;
}

/** 构建 bwrap 包装命令字符串（pi bash 工具的 spawnHook 使用）。 */
export function buildBwrapCommand(command: string, policy: SandboxExecutionPolicy): string {
  const parts = ["bwrap", ...bwrapProfileArgs(policy)];
  parts.push("--chdir", policy.workspaceRoot);
  parts.push("--", "sh", "-c", safeQuote(command));
  return parts.join(" ");
}
