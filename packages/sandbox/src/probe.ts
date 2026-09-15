/**
 * pi-sandbox-dsh-sandbox · 真机 probe（`npm run probe`）。
 *
 * 结构测试（`npm test`）只验证纯函数与 argv 契约；本文件在**真机**验证后端能不能真正约束写面：
 * - Linux/WSL2：bwrap 可用性（完整 e2e 在 `test/bwrap-e2e.spec.ts`）。
 * - Windows：winacl runner 能力探针 + 受限令牌往返 —— read-only 写被拒 / 读全开；
 *   workspace-write 写工作区成功、写工作区外被拒；工作区 ACE 幂等保留（standing reuse cache），
 *   runner 退出后自建的私有 temp 目录不残留。
 *
 * 退出码 0 = 全部通过；1 = 有失败（fail-closed：探针失败即视为后端不可用）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPowerShellConfig } from "@earendil-works/pi-coding-agent";
import { probeBwrap } from "./bwrap.ts";
import { buildWinaclRunnerArgv, winaclUsable } from "./win32/runner-contract.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "win32", "runner.ts");
const NODE_FLAGS = ["--experimental-strip-types"] as const;

/** 跑一次 runner（与宿主同一条 argv 契约），返回退出码与合并输出。 */
function runRunner(args: readonly string[]): { status: number | null; output: string } {
  const r = spawnSync("node", [...NODE_FLAGS, RUNNER, ...args], { timeout: 120_000, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 用 pwsh 执行一段脚本（**不包 try/catch**：受限令牌下 PowerShell 运行在 ConstrainedLanguage，
 *  catch 里的 [Console]::Error.WriteLine / $_.Exception.GetType() 这类方法调用会被 CLM 拒掉，
 *  反而掩盖真实错误；让 cmdlet 自己报错就能拿到 `Access to the path … is denied.` 原文）。 */
function pwshCommand(body: string): string[] {
  const shell = getPowerShellConfig();
  return [shell.shell, ...shell.args, body];
}

/** 工作区 DACL 里 capability SID ACE 的条数（icacls 对无法解析的 SID 打印 `S-1-4-…`）。 */
function countCapabilityAces(workspace: string): number {
  const r = spawnSync("icacls", [workspace], { encoding: "utf8" });
  const matches = (r.stdout ?? "").match(/S-1-4-\d+-\d+(-\d+)?/g) ?? [];
  return matches.length;
}

function probeLinux(): void {
  console.log("=== Linux/WSL2 · bwrap ===");
  const available = probeBwrap();
  assert(available, "bwrap 可用（probe 通过）", "bwrap --version 未通过 → 后端不可用（fail-closed）");
  if (available) {
    console.log("  完整写面 e2e 见 `npm test`（test/bwrap-e2e.spec.ts）");
  }
}

function probeWindows(): void {
  const scratch = mkdtempSync(join(tmpdir(), "pi-sandbox-dsh-probe-"));
  const workspace = join(scratch, "ws");
  const tempRoot = join(scratch, "tmp");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  const outsidePath = join(scratch, "outside.txt");
  writeFileSync(outsidePath, "outside\n", "utf8");
  const insidePath = join(workspace, "inside.txt");

  try {
    console.log("=== winacl · runner 能力探针 ===");
    const probe = spawnSync("node", [...NODE_FLAGS, RUNNER, "--probe"], { timeout: 120_000, encoding: "utf8" });
    assert(probe.status === 0, "runner --probe 返回 0（koffi/令牌/DACL/Job 能力齐备）",
      `${probe.status}: ${(probe.stderr ?? "").trim()}`);

    console.log("=== winacl · read-only 往返 ===");
    const roWrite = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "read-only", "--",
      ...pwshCommand(`Set-Content -LiteralPath '${insidePath}' -Value ro -ErrorAction Stop`),
    ]);
    assert(roWrite.status !== 0, "read-only：写工作区被拒（非零退出）", `status=${String(roWrite.status)}`);
    assert(existsSync(insidePath) === false, "read-only：工作区文件确实未被创建");
    assert(/access to the path|access is denied|permission denied|operation not permitted/i.test(roWrite.output),
      "read-only：stderr 命中本后端 denial 方言", roWrite.output.trim().slice(0, 200));

    const roRead = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "read-only", "--",
      ...pwshCommand(`Get-Content -LiteralPath '${outsidePath}' -ErrorAction Stop | Out-Null`),
    ]);
    assert(roRead.status === 0, "read-only：读工作区外文件成功（读不受限）", roRead.output.trim().slice(0, 200));

    console.log("=== winacl · workspace-write 往返 ===");
    const wwScript = `Set-Content -LiteralPath '${insidePath}' -Value ww -ErrorAction Stop`;
    const wwWrite = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "workspace-write", "--",
      ...pwshCommand(wwScript),
    ]);
    assert(wwWrite.status === 0, "workspace-write：写工作区成功", `${wwWrite.status}: ${wwWrite.output.trim().slice(0, 200)}`);
    assert(existsSync(insidePath), "workspace-write：工作区文件确实落盘");

    const wwOutside = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "workspace-write", "--",
      ...pwshCommand(`Set-Content -LiteralPath '${outsidePath}' -Value escaped -ErrorAction Stop`),
    ]);
    assert(wwOutside.status !== 0, "workspace-write：写工作区外被拒（非零退出）", `status=${String(wwOutside.status)}`);

    console.log("=== winacl · 受限令牌下的 PowerShell 语言模式（已知边界，仅报告）===");
    const languageMode = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "read-only", "--",
      ...pwshCommand("$ExecutionContext.SessionState.LanguageMode"),
    ]);
    console.log(`  · pwsh LanguageMode = ${languageMode.output.trim()}（受限令牌下为 ConstrainedLanguage：.NET 方法调用被禁，纯 cmdlet/外部命令不受影响）`);

    console.log("=== winacl · grant 生命周期 ===");
    const acesAfter = countCapabilityAces(workspace);
    assert(acesAfter === 1, "工作区 standing ACE 幂等：两次 grant 后仅 1 条 capability ACE", `实际 ${acesAfter} 条`);
    const leftovers = readdirSync(tempRoot).filter((name) => name.startsWith("pi-sandbox-dsh-"));
    assert(leftovers.length === 0, "runner 自建私有 temp 目录已清理（temp ACE 随之不可残留）", leftovers.join(", "));

    console.log("=== winacl · read-only 不携带写能力 ===");
    const workspaceViaRo = countCapabilityAces(workspace);
    assert(workspaceViaRo === 1, "read-only 运行后工作区 ACE 保留但不生效（standing 缓存）", `实际 ${workspaceViaRo} 条`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(`=== pi-sandbox-dsh probe（platform=${process.platform}）===`);
if (winaclUsable()) {
  // winaclUsable 只判平台；argv 契约本身也顺带校验一次。
  const argv = buildWinaclRunnerArgv({ workspace: "C:\\ws", temp: "C:\\tmp", mode: "read-only", runnerEntry: RUNNER });
  assert(argv.length === 8 && argv[0] === "node", "runner argv 契约（read-only 8 段）", argv.join(" "));
  probeWindows();
} else {
  probeLinux();
}
console.log(`\n结果是: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
