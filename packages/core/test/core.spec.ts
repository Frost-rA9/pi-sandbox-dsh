/**
 * pi-sandbox-dsh-core 纯逻辑测试：状态折叠 / 文件工具写面围栏。
 */
import { foldSandboxMode } from "../src/state.ts";
import { classifyFileWrite, denyReason } from "../src/tools-fs.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== state: foldSandboxMode ===");
assert(foldSandboxMode([], "read-only") === "read-only", "empty → default");
const entries = [
  { customType: "x", data: { mode: "workspace-write" } },
  { customType: "sandbox-mode", data: { mode: "read-only" } },
  { customType: "sandbox-mode", data: { mode: "danger-full-access" } },
];
assert(foldSandboxMode(entries, "read-only") === "danger-full-access", "fold takes last");
assert(foldSandboxMode([{ customType: "sandbox-mode", data: { mode: "garbage" } }], "read-only") === "read-only", "invalid mode → default");

console.log("=== tools-fs: classifyFileWrite ===");
const roPolicy = { mode: "read-only" as const, workspaceRoot: "/w" };
const wwPolicy = { mode: "workspace-write" as const, workspaceRoot: "/w" };
const danger = { mode: "danger-full-access" as const, workspaceRoot: "/w" };
assert(classifyFileWrite({ toolName: "write", target: "/w/a.txt" }, roPolicy).decision === "deny", "read-only denies write");
assert(classifyFileWrite({ toolName: "edit", target: "/w/a.txt" }, wwPolicy).decision === "allow", "workspace-write allows in root");
assert(classifyFileWrite({ toolName: "write", target: "/outside.txt" }, wwPolicy).decision === "deny", "workspace-write denies outside");
assert(classifyFileWrite({ toolName: "write", target: "/outside.txt" }, danger).decision === "allow", "danger allows");
assert(classifyFileWrite({ toolName: "write", target: undefined }, wwPolicy).decision === "deny", "no target denies");
assert(denyReason({ reason: "x" }, true).includes("/sandbox"), "denyReason adds the mode-switch hint when advertise");
assert(!denyReason({ reason: "x" }, false).includes("/sandbox"), "denyReason omits the hint when not advertise");
// 回归：pi 的 write/edit 没有 per-call 升级参数，hint 绝不能指引模型去传它。
assert(!denyReason({ reason: "x" }, true).includes("sandbox_permissions"), "denyReason never advertises a parameter pi's write/edit lack");

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
