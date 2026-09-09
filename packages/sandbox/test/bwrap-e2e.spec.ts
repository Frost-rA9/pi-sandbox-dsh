/**
 * pi-sandbox-dsh-sandbox · bwrap 端到端（真机执行，非字符串）。
 *
 * 用真实 bwrap 验证 Linux 写面语义：
 * - read-only：写工作区失败（EROFS），读全开。
 * - workspace-write：写工作区成功。
 * - 无凭据隐藏：沙箱内可读 ~/.gitconfig（读不受限）。
 * bwrap 不可用时跳过（不 fail）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBwrapCommand } from "../src/index.ts";
import type { SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name}`); }
}

// bwrap 可用性
const bwrapAvailable = spawnSync("bwrap", ["--version"], { timeout: 3000 }).status === 0;
if (!bwrapAvailable) {
  console.log("bwrap 不可用，跳过 e2e（仅结构测试）");
  process.exit(0);
}

const ws = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dsh-e2e-"));
const file = join(ws, "x.txt");
function run(wrapped: string): { exitCode: number | null; stdout: string; stderr: string } {
  const r = spawnSync(wrapped, { shell: true, encoding: "utf8", timeout: 20000 });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error?.message ?? "") };
}

const ro: SandboxExecutionPolicy = { mode: "read-only", workspaceRoot: ws };
const ww: SandboxExecutionPolicy = { mode: "workspace-write", workspaceRoot: ws };

console.log("=== e2e: read-only 写被拒 + 读全开 ===");
writeClean(file);
const roWrite = run(buildBwrapCommand(`echo hi > ${file}`, ro));
assert(roWrite.exitCode !== 0, "read-only write fails (exit≠0)");
assert(/read-only file system/i.test(roWrite.stderr) || /read-only file system/i.test(roWrite.stdout), "read-only stderr EROFS");
writeClean(file);
writeFileSync(file, "hi\n"); // host 侧写入，read-only 读测试目标存在
const roRead = run(buildBwrapCommand(`wc -c ${file}`, ro));
assert(roRead.exitCode === 0, "read-only read succeeds");
assert(/^\s*\d+/.test(roRead.stdout), "read returns byte count");

console.log("=== e2e: workspace-write 写成功 ===");
writeClean(file);
const wwWrite = run(buildBwrapCommand(`echo hi > ${file}`, ww));
assert(wwWrite.exitCode === 0, "workspace-write write succeeds");
assert(existsSync(file) && readFileSync(file, "utf8").trim() === "hi", "workspace-write file content");

console.log("=== e2e: 无凭据隐藏（读 ~/.gitconfig / 家目录） ===");
const gitconfig = join(homedir(), ".gitconfig");
if (existsSync(gitconfig)) {
  const readGc = run(buildBwrapCommand(`wc -c ${gitconfig}`, ro));
  assert(readGc.exitCode === 0, "read-only reads ~/.gitconfig (no credential hiding)");
} else {
  console.log("=== e2e: bwrap 不可用时跳过 ===");
}

function writeClean(p: string): void {
  try { rmSync(p, { force: true }); } catch { /* ignore */ }
}
rmSync(ws, { recursive: true, force: true });

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
