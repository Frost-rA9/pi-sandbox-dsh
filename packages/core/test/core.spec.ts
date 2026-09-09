/**
 * pi-sandbox-dsh-core 纯逻辑测试：状态折叠 / 标记 / denial 探测 / 升级词表。
 */
import { foldSandboxMode } from "../src/state.ts";
import {
  shouldAdvertiseEscalation,
  escalationTargets,
  detectDenial,
  appendSandboxMarkers,
  bashDescription,
} from "../src/tools.ts";

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

console.log("=== tools: shouldAdvertiseEscalation / escalationTargets ===");
assert(shouldAdvertiseEscalation({ mode: "read-only" }) === true, "read-only advertises");
assert(shouldAdvertiseEscalation({ mode: "workspace-write" }) === true, "workspace-write advertises");
assert(shouldAdvertiseEscalation({ mode: "danger-full-access" }) === false, "danger does not advertise");
assert(escalationTargets("read-only").length === 2, "read-only targets 2");
assert(escalationTargets("workspace-write").length === 1, "workspace-write targets 1");
assert(escalationTargets("danger-full-access").length === 0, "danger targets 0");

console.log("=== tools: bashDescription ===");
assert(bashDescription(false).includes("file access denied"), "base description mentions denial");
assert(bashDescription(true).includes("sandbox_permissions"), "advertised description mentions escalation");

console.log("=== tools: detectDenial + appendSandboxMarkers ===");
const denied = { content: [{ type: "text", text: "cp: cannot create file 'x': Read-only file system" }] };
const ok = { content: [{ type: "text", text: "hello" }] };
assert(detectDenial(denied, "bwrap") === true, "bwrap denial detected");
assert(detectDenial(ok, "bwrap") === false, "bwrap no false positive");
const marked = appendSandboxMarkers(denied, "read-only", true);
assert(JSON.stringify(marked.content).includes("file access denied under read-only mode"), "denial marker appended");
assert(JSON.stringify(marked.content).includes("escalation available"), "hint appended when advertised");
const markedNoHint = appendSandboxMarkers(denied, "read-only", false);
assert(!JSON.stringify(markedNoHint.content).includes("escalation available"), "no hint when not advertised");

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
