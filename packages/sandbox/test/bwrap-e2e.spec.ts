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
import { chmodSync, existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBwrapCommand, createBwrapBackend } from "../src/index.ts";
import type { SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import { SANDBOX_UNAVAILABLE } from "pi-sandbox-dsh-bridge";

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

console.log("=== e2e: 结果侧分类（生产路径：spawnHook → operations.exec） ===");
// pi 的真实调用顺序：工具先跑 spawnHook（包 argv），再把 command/cwd/env 交给 operations.exec。
const backend = createBwrapBackend();
const toolOptions = backend.createToolOptions({ workspaceRoot: ws, readState: () => ro });
const spawnHook = toolOptions.spawnHook;
const operations = toolOptions.operations;
if (spawnHook === undefined || operations === undefined) {
  assert(false, "bwrap backend exposes spawnHook + operations");
} else {
  const exec = async (command: string) => {
    const context = spawnHook({ command, cwd: ws, env: process.env });
    const chunks: string[] = [];
    try {
      const result = await operations.exec(context.command, context.cwd, {
        onData: (data) => chunks.push(Buffer.from(data).toString("utf8")),
        env: context.env,
      });
      return { output: chunks.join(""), exitCode: result.exitCode, error: undefined as Error | undefined };
    } catch (error) {
      return { output: chunks.join(""), exitCode: null, error: error as Error };
    }
  };

  writeClean(file);
  const denied = await exec(`echo hi > ${file}`);
  assert(denied.exitCode !== 0, "classified: read-only write still fails");
  assert(denied.output.includes("[sandbox: file access denied under read-only mode]"), "classified: real EROFS yields the denial marker");
  assert(denied.output.includes("/sandbox"), "classified: denial carries the widening hint");

  writeFileSync(file, "hi\n");
  const allowed = await exec(`wc -c ${file}`);
  assert(allowed.exitCode === 0, "classified: read-only read succeeds");
  assert(!allowed.output.includes("[sandbox:"), "classified: success carries no denial marker");

  // runner 失败：PATH 前置一个假 bwrap（spawnHook 的白名单 env 取自 process.env，故注入 process 级 PATH），
  // 它打印致命签名后退出非零，并同时输出一段 denial 方言文本。
  const fakeBin = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dsh-fakebin-"));
  const fakeBwrap = join(fakeBin, "bwrap");
  writeFileSync(fakeBwrap, "#!/bin/sh\necho 'bwrap: simulated runner failure: setting up uid map: Permission denied' >&2\necho \"cp: cannot create regular file 'x': Read-only file system\" >&2\nexit 1\n");
  chmodSync(fakeBwrap, 0o755);
  const realPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeBin}:${realPath}`;
  const runnerFailed = await exec(`echo hi > ${file}`);
  process.env.PATH = realPath;
  assert((runnerFailed.error as unknown as { code?: string } | undefined)?.code === SANDBOX_UNAVAILABLE, "classified: runner failure is fail-closed");
  assert(runnerFailed.error?.message.includes("not a policy denial") === true, "classified: runner failure refuses the denial reading");
  assert(!runnerFailed.output.includes("[sandbox: file access denied"), "classified: runner failure outranks the denial dialect");
  rmSync(fakeBin, { recursive: true, force: true });
}

function writeClean(p: string): void {
  try { rmSync(p, { force: true }); } catch { /* ignore */ }
}
rmSync(ws, { recursive: true, force: true });

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
