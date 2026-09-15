/**
 * pi-sandbox-dsh-bridge 纯函数测试。
 * 覆盖：档位阶梯（严格更宽）/ denial+hint 标记 / 升级参数配对 / policy 优先级 / 结果侧分类 / fail-closed。
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
  DENIAL_SIGNATURES,
  RUNNER_FAILURE_RULES,
  WINACL_RUNNER_FAILURE_EXIT,
  matchesSignature,
  classifyDenial,
  classifyRunnerFailure,
  sandboxRunnerFailureMessage,
  sandboxWideningHint,
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

console.log("=== 7) 结果侧分类（denial 方言 / runner 失败 / fail-closed 文案） ===");
const bwrapDenial = DENIAL_SIGNATURES.bwrap;
assert(matchesSignature(1, "cp: cannot create regular file 'x': Read-only file system", bwrapDenial), "bwrap EROFS detected (nonzero exit)");
assert(!matchesSignature(0, "Read-only file system", bwrapDenial), "exit 0 is not a denial");
assert(!matchesSignature(null, "Read-only file system", bwrapDenial), "signal death is not a denial");
assert(!matchesSignature(1, "hello world", bwrapDenial), "bwrap no false positive");
assert(matchesSignature(1, "Access to the path 'x' is denied.", DENIAL_SIGNATURES.winacl), "winacl access denied");
assert(matchesSignature(1, "Error: EPERM: operation not permitted, open 'x'", DENIAL_SIGNATURES.winacl), "winacl Node EPERM denied");
assert(matchesSignature(1, "EPERM: OPERATION NOT PERMITTED", DENIAL_SIGNATURES.winacl), "denial matching is case-insensitive");
assert(classifyDenial(1, "Read-only file system", bwrapDenial), "classifyDenial parity with matchesSignature");

assert(classifyRunnerFailure(1, "bwrap: setting up uid map: Permission denied", RUNNER_FAILURE_RULES.bwrap) === "bwrap: setting up uid map: Permission denied", "bwrap runner failure returns the fatal line");
assert(classifyRunnerFailure(1, "sh: 1: bwrap: not found", RUNNER_FAILURE_RULES.bwrap) === "sh: 1: bwrap: not found", "missing bwrap on PATH is a runner failure");
assert(classifyRunnerFailure(0, "bwrap: boom", RUNNER_FAILURE_RULES.bwrap) === undefined, "exit 0 is not a runner failure");
assert(classifyRunnerFailure(null, "bwrap: boom", RUNNER_FAILURE_RULES.bwrap) === undefined, "signal death is not a runner failure");
assert(classifyRunnerFailure(1, "bwrap: unrelated", [{ fatalSignatures: [] }]) === undefined, "no signature = no evidence");
assert(classifyRunnerFailure(1, "bwrap: unrelated", [{ fatalSignatures: ["   "] }]) === undefined, "blank signature is not evidence");
assert(classifyRunnerFailure(2, "windows-acl-run: boom", RUNNER_FAILURE_RULES.winacl) === undefined, "exit-code gate rejects a non-reserved code");
assert(classifyRunnerFailure(WINACL_RUNNER_FAILURE_EXIT, "windows-acl-run: boom", RUNNER_FAILURE_RULES.winacl) === "windows-acl-run: boom", "exit-code gate admits the reserved code");
assert(
  classifyRunnerFailure(7, "launcher: partial enforcement (older Landlock ABI)\nlauncher: fatal", [
    { allowedExitCodes: [7], informationalLines: ["launcher: partial enforcement (older Landlock ABI)"], fatalSignatures: ["launcher: "] },
  ]) === "launcher: fatal",
  "informational line excluded by exact full-line equality",
);
assert(SANDBOX_UNAVAILABLE === "SANDBOX_UNAVAILABLE", "fail-closed code");
const failureText = sandboxRunnerFailureMessage("read-only", "bwrap: boom");
assert(failureText.includes("not a policy denial"), "runner-failure text denies being a denial");
assert(failureText.includes("bwrap: boom"), "runner-failure text carries the fatal line");
assert(sandboxWideningHint().includes("/sandbox"), "bash widening hint points at the user decision point");

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
