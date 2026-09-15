/**
 * pi-sandbox-dsh-sandbox · winacl 结构测试（Windows-only 部分为结构/纯函数；FFI/令牌不在此验证）。
 */
import {
  selectBackend,
  winaclUsable,
  buildWinaclRunnerArgv,
  workspaceWriteSid,
  tempWriteSid,
  assertTempRootOutsideWorkspace,
} from "../src/index.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name}`); }
}
function throws(fn: () => void, name: string): void {
  try { fn(); failed++; console.error(`  ✗ ${name} (no throw)`); }
  catch { passed++; }
}

console.log("=== winaclUsable / selectBackend ===");
assert(typeof winaclUsable() === "boolean", "winaclUsable returns boolean");
const win = selectBackend("win32");
assert(win.kind === "winacl", "selectBackend(win32) → winacl");
assert(win.shellTool === "powershell", "winacl shellTool=powershell");
if (process.platform === "win32") {
  // 真机能力（koffi/令牌/DACL/Job）由 `npm run probe` 验证 —— 单元测试不拉起 runner 子进程。
  console.log("  · win32 宿主：probe() 的真机结果见 `npm run probe`");
  assert(typeof win.info.available === "boolean", "winacl info.available 形状");
} else {
  assert(win.probe() === false, "probe false on non-win32 host");
}
const linux = selectBackend("linux");
assert(linux.kind === "bwrap", "selectBackend(linux) → bwrap");

console.log("=== buildWinaclRunnerArgv (runner argv 契约) ===");
const ro = buildWinaclRunnerArgv({ workspace: "C:\\w", temp: "C:\\tmp", mode: "read-only", runnerEntry: "runner.ts" });
assert(ro.includes("--workspace") && ro.includes("--mode") && ro.includes("read-only"), "read-only argv base");
assert(!ro.includes("--write-sid"), "read-only has no write-sid");
const ww = buildWinaclRunnerArgv({ workspace: "C:\\w", temp: "C:\\tmp", mode: "workspace-write", writeSid: "S-1-4-1-2", tempWriteSid: "S-1-4-3-4-1", runnerEntry: "runner.ts" });
assert(ww.includes("--write-sid") && ww.includes("S-1-4-1-2"), "workspace-write has write-sid");
assert(ww.includes("--temp-write-sid") && ww.includes("S-1-4-3-4-1"), "workspace-write has temp-write-sid");

console.log("=== workspaceWriteSid / tempWriteSid (确定性 + 域分离) ===");
assert(workspaceWriteSid("C:\\w") === workspaceWriteSid("C:\\w"), "workspace SID deterministic");
assert(workspaceWriteSid("C:\\w") !== workspaceWriteSid("C:\\w2"), "different workspace → different SID");
assert(/^S-1-4-\d+-\d+$/.test(workspaceWriteSid("C:\\w")), "workspace SID shape S-1-4-x-y");
const wt = tempWriteSid("C:\\tmp\\dsh-abc");
assert(/^S-1-4-\d+-\d+-1$/.test(wt), "temp SID shape S-1-4-x-y-1");
assert(tempWriteSid("C:\\tmp\\dsh-abc") !== workspaceWriteSid("C:\\tmp\\dsh-abc"), "temp SID distinct from workspace via domain sep");

console.log("=== assertTempRootOutsideWorkspace ===");
assert(typeof assertTempRootOutsideWorkspace === "function", "boundary fn exists");

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
