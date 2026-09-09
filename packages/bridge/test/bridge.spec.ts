/**
 * pi-sandbox-dsh-bridge 纯函数测试。
 * 覆盖：档位阶梯（严格更宽）/ denial+hint 标记 / 升级参数配对 / policy 优先级 / denial 探测 / fail-closed。
 */
import {
  isSandboxMode,
  isStrictlyWider,
  WIDER_MODES,
  ESCALATION_TARGETS,
  sandboxDenialMarker,
  escalationHintMarker,
  validateEscalationArgs,
  assertStrictlyWider,
  resolveSandboxPolicy,
  renderPolicyContext,
  looksLikeDenial,
  SANDBOX_MODE_DESCRIPTIONS,
  isConfinedMode,
  SANDBOX_UNAVAILABLE,
} from "../src/index.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function throws(fn: () => void, name: string): void {
  try { fn(); failed++; console.error(`  ✗ ${name} (no throw)`); }
  catch { passed++; }
}

console.log("=== 1) 档位阶梯 / 严格更宽 ===");
assert(isSandboxMode("read-only"), "isSandboxMode read-only");
assert(!isSandboxMode("nope"), "isSandboxMode rejects unknown");
assert(isConfinedMode("read-only"), "read-only is confined");
assert(isConfinedMode("workspace-write"), "workspace-write is confined");
assert(!isConfinedMode("danger-full-access"), "danger-full-access is not confined");
assert(isStrictlyWider("read-only", "workspace-write"), "read-only → workspace-write");
assert(isStrictlyWider("read-only", "danger-full-access"), "read-only → danger");
assert(isStrictlyWider("workspace-write", "danger-full-access"), "workspace-write → danger");
assert(!isStrictlyWider("workspace-write", "read-only"), "workspace-write → read-only (down) rejected");
assert(!isStrictlyWider("read-only", "read-only"), "read-only → read-only (same) rejected");
assert(!isStrictlyWider("danger-full-access", "workspace-write"), "danger → workspace rejected");
assert(JSON.stringify(ESCALATION_TARGETS) === JSON.stringify(["workspace-write", "danger-full-access"]), "ESCALATION_TARGETS floor excludes read-only");
assert(WIDER_MODES["danger-full-access"].length === 0, "danger has no wider");

console.log("=== 2) denial + hint 标记 ===");
assert(sandboxDenialMarker("read-only") === "[sandbox: file access denied under read-only mode]", "denial marker ascii");
assert(escalationHintMarker("command").includes("sandbox_permissions"), "hint mentions sandbox_permissions");
assert(escalationHintMarker("command").includes("justification"), "hint mentions justification");

console.log("=== 3) 升级参数配对校验 ===");
throws(() => validateEscalationArgs(undefined, "abc"), "justification without permissions throws");
throws(() => validateEscalationArgs("workspace-write", undefined), "permissions without justification throws");
throws(() => validateEscalationArgs("workspace-write", "   "), "empty justification throws");
validateEscalationArgs("workspace-write", "need to install deps"); passed++;
validateEscalationArgs(undefined, undefined); passed++;

console.log("=== 4) assertStrictlyWider ===");
assert(assertStrictlyWider({ requestedMode: "workspace-write", justification: "x", effectiveMode: "read-only", subject: "command" }) === "workspace-write", "strict widening returns mode");
throws(() => assertStrictlyWider({ requestedMode: "read-only", justification: "x", effectiveMode: "workspace-write", subject: "command" }), "non-widening throws");

console.log("=== 5) resolveSandboxPolicy 优先级 ===");
const p = resolveSandboxPolicy({ approvedMode: "danger-full-access", sessionOverride: "workspace-write", defaultMode: "read-only", sessionCwd: "/w" });
assert(p.mode === "danger-full-access" && p.workspaceRoot === "/w", "approvedMode > sessionOverride > default; root=cwd");
const p2 = resolveSandboxPolicy({ sessionOverride: "workspace-write", defaultMode: "read-only", sessionCwd: "/w" });
assert(p2.mode === "workspace-write", "sessionOverride > default");
const p3 = resolveSandboxPolicy({ defaultMode: "read-only", sessionCwd: "/w" });
assert(p3.mode === "read-only", "default fallback");
const p4 = resolveSandboxPolicy({ defaultMode: "read-only", fallbackRoot: "/f" });
assert(p4.mode === "read-only" && p4.workspaceRoot === "/f", "fallback root when no cwd");
assert(typeof SANDBOX_MODE_DESCRIPTIONS["workspace-write"] === "string", "descriptions exist");

console.log("=== 6) renderPolicyContext ===");
assert(renderPolicyContext({ mode: "read-only", workspaceRoot: "/" }).includes("read-only"), "read-only context");
assert(renderPolicyContext({ mode: "workspace-write", workspaceRoot: "/w" }).includes("/w"), "workspace-write context names root");
assert(renderPolicyContext({ mode: "danger-full-access", workspaceRoot: "/" }).includes("does not restrict file modifications"), "danger context");

console.log("=== 7) denial 探测 ===");
assert(looksLikeDenial("bwrap", "cp: cannot create regular file 'x': Read-only file system"), "bwrap EROFS detected");
assert(!looksLikeDenial("bwrap", "hello world"), "bwrap no false positive");
assert(looksLikeDenial("winacl", "Access to the path 'x' is denied."), "winacl access denied");
assert(SANDBOX_UNAVAILABLE === "SANDBOX_UNAVAILABLE", "fail-closed code");

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
