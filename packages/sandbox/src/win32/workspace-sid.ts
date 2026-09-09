/**
 * pi-sandbox-dsh-sandbox · Windows ACL 写 SID 派生（纯函数，可测）。
 *
 * 对齐 dsh `sandbox-windows-acl/workspace-sid.ts`：
 * - workspace SID：`S-1-4-x-y`，由规范化工作区路径 SHA256 确定性派生 —— 同工作区跨会话/重启同 SID，
 *   工作区根 ACE 只物化一次（per-workspace reuse cache）。
 * - temp SID：`S-1-4-x-y-1`，由随机 private temp 目录路径派生，第三子域分离域，隔开兄弟会话。
 * - 注：`input` 须为规范化（realpath）路径。
 */
import { createHash } from "node:crypto";

function baseTwo(seed: Buffer, offset: number): number {
  return (seed.readUInt32LE(offset) % (2 ** 30 - 1)) + 1;
}

/** 工作区写 SID：`S-1-4-x-y`（30-bit 子域，匹配 token/ACE 层的 capability 形态）。 */
export function workspaceWriteSid(workspaceRoot: string): string {
  const digest = createHash("sha256").update(workspaceRoot, "utf8").digest();
  return `S-1-4-${baseTwo(digest, 0)}-${baseTwo(digest, 4)}`;
}

/** 单 private temp 目录的写 SID：`S-1-4-x-y-1`（第三子域域分离，与 workspace SID 区分）。 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash("sha256").update("temp\0", "utf8").update(tempDir, "utf8").digest();
  return `S-1-4-${baseTwo(digest, 0)}-${baseTwo(digest, 4)}-1`;
}
