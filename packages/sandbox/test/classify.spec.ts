/**
 * pi-sandbox-dsh-sandbox 结果侧分类测试（createConfinedOperations）。
 *
 * 覆盖（对齐 dsh `bash-sandbox` 的判定顺序，按 pi 裁剪）：
 * - danger 档无事实 → 原样透传、不判定；
 * - denial = 非零退出 + 本后端方言 → 在模型可见输出尾部追标记；
 * - exit 0 / 无事实 → 不追标记（吞掉失败的命令不拿标记）；
 * - runner 失败优先于 denial → 抛 SANDBOX_UNAVAILABLE，不追 denial 标记；
 * - 流式输出保持（分片按序转发，标记在最后）；
 * - 分类窗口有界（落在窗口外的致命行不参与判定）。
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import { DENIAL_SIGNATURES, RUNNER_FAILURE_RULES, SANDBOX_UNAVAILABLE } from "pi-sandbox-dsh-bridge";
import { MAX_CLASSIFY_BYTES, createBwrapBackend, createConfinedOperations } from "../src/index.ts";
import type { ConfinedRunFacts } from "../src/index.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name}`); }
}

const readOnlyFacts: ConfinedRunFacts = {
  mode: "read-only",
  denialSignatures: DENIAL_SIGNATURES.bwrap,
  runnerFailureRules: RUNNER_FAILURE_RULES.bwrap,
};

/** 假基础 operations：把 script 的每一段按序推给 onData，再返回固定退出码。 */
function fakeBase(script: string[], exitCode: number | null): BashOperations {
  return {
    exec: async (_command, _cwd, options) => {
      for (const chunk of script) options.onData(Buffer.from(chunk));
      return { exitCode };
    },
  };
}

/** 跑一次包装后的 operations，收集模型可见输出与抛出的错误。 */
async function run(
  base: BashOperations,
  facts: ConfinedRunFacts | undefined,
  cwd = "/w",
): Promise<{ output: string; exitCode: number | null; error?: Error }> {
  const ops = createConfinedOperations(base, () => facts);
  const chunks: string[] = [];
  try {
    const result = await ops.exec("echo hi", cwd, { onData: (d) => chunks.push(Buffer.from(d).toString("utf8")) });
    return { output: chunks.join(""), exitCode: result.exitCode };
  } catch (error) {
    return { output: chunks.join(""), exitCode: null, error: error as Error };
  }
}

console.log("=== danger 档 / 无事实：不判定 ===");
{
  const denied = await run(fakeBase(["Read-only file system\n"], 1), undefined);
  assert(!denied.output.includes("[sandbox:"), "no facts → no denial marker");
  assert(denied.exitCode === 1, "no facts → exit code untouched");
}

console.log("=== denial：非零退出 + 本后端方言 ===");
{
  const denied = await run(fakeBase(["cp: cannot create regular file 'x': Read-only file system\n"], 1), readOnlyFacts);
  assert(denied.output.includes("[sandbox: file access denied under read-only mode]"), "denial marker appended");
  assert(denied.output.includes("/sandbox"), "widening hint appended next to the marker");
  assert(denied.output.indexOf("cp: cannot create") < denied.output.indexOf("[sandbox:"), "marker lands after the command output");
  assert(denied.exitCode === 1, "exit code still reported to pi");
}
{
  const ok = await run(fakeBase(["Read-only file system\n"], 0), readOnlyFacts);
  assert(!ok.output.includes("[sandbox:"), "exit 0 is not a denial");
}
{
  const unrelated = await run(fakeBase(["hello\n"], 1), readOnlyFacts);
  assert(!unrelated.output.includes("[sandbox:"), "unrelated failure is not a denial");
}

console.log("=== runner 失败优先于 denial ===");
{
  const mixed = await run(fakeBase(["bwrap: setting up uid map: Permission denied\nRead-only file system\n"], 1), readOnlyFacts);
  assert(mixed.error !== undefined, "runner failure throws (fail-closed)");
  const code = (mixed.error as unknown as { code?: string } | undefined)?.code;
  assert(code === SANDBOX_UNAVAILABLE, "thrown error carries SANDBOX_UNAVAILABLE");
  assert(mixed.error?.message.includes("not a policy denial") === true, "message refuses the denial reading");
  assert(!mixed.output.includes("[sandbox: file access denied"), "no denial marker on runner failure");
}

console.log("=== 流式输出保持 ===");
{
  const streamed = await run(fakeBase(["a", "b", "Read-only file system\n"], 1), readOnlyFacts);
  assert(streamed.output.startsWith("ab"), "chunks forwarded in order");
  assert(!streamed.output.includes("Read-only file system\n[sandbox:"), "marker separated from the last chunk");
}

console.log("=== 分类窗口有界 ===");
{
  const signatureOutsideWindow = "Read-only file system\n" + "x".repeat(MAX_CLASSIFY_BYTES + 10);
  const dropped = await run(fakeBase([signatureOutsideWindow], 1), readOnlyFacts);
  assert(!dropped.output.includes("[sandbox: file access denied"), "signature dropped from the retained tail is not matched");
  const signatureInsideWindow = "x".repeat(MAX_CLASSIFY_BYTES + 10) + "Read-only file system\n";
  const kept = await run(fakeBase([signatureInsideWindow], 1), readOnlyFacts);
  assert(kept.output.includes("[sandbox: file access denied"), "signature inside the window is matched");
}

console.log("=== 后端事实接线 ===");
{
  const backend = createBwrapBackend();
  const readState = (): SandboxExecutionPolicy => ({ mode: "read-only", workspaceRoot: "/w" });
  const options = backend.createToolOptions({ workspaceRoot: "/w", readState });
  assert(typeof options.spawnHook === "function", "bwrap keeps its argv spawnHook");
  assert(typeof options.operations?.exec === "function", "bwrap adds classifying operations");
  assert(backend.runnerFailureRules[0]?.fatalSignatures.includes("bwrap: ") === true, "bwrap declares its runner-failure signature");
}

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
