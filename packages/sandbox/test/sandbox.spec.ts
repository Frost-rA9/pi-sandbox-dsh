/**
 * pi-sandbox-dsh-sandbox 测试：bwrap profile/命令/safeQuote/probe + containment 围栏。
 */
import {
  buildBwrapCommand,
  bwrapProfileArgs,
  safeQuote,
  probeBwrap,
  overrideBwrapDetect,
  isPathUnder,
  writableRoots,
} from "../src/index.ts";
import type { SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name}`); }
}

const ro: SandboxExecutionPolicy = { mode: "read-only", workspaceRoot: "/w" };
const ww: SandboxExecutionPolicy = { mode: "workspace-write", workspaceRoot: "/w" };

console.log("=== safeQuote ===");
assert(safeQuote("echo hi") === "'echo hi'", "plain quote");
assert(safeQuote("a'b") === `'a'\\''b'`, "inner single quote escaped");

console.log("=== bwrapProfileArgs ===");
const roArgs = bwrapProfileArgs(ro);
assert(roArgs.includes("--ro-bind") && roArgs.includes("/"), "read-only base ro-bind / /");
assert(!roArgs.includes("--bind"), "read-only has no bind");
assert(!roArgs.includes("--tmpfs"), "read-only no tmpfs");
assert(!roArgs.includes("--unshare-net"), "no network unshare");
assert(roArgs.includes("--unshare-pid"), "pid isolation");
const wwArgs = bwrapProfileArgs(ww);
assert(wwArgs.includes("--bind") && wwArgs.includes("/w"), "workspace-write binds workspace");
assert(wwArgs.includes("--tmpfs"), "workspace-write tmpfs /tmp");

console.log("=== buildBwrapCommand ===");
const cmd = buildBwrapCommand("echo hi", ro);
assert(cmd.startsWith("bwrap "), "starts with bwrap");
assert(cmd.includes("--ro-bind"), "has ro-bind");
assert(cmd.includes("--chdir"), "chdir present");
assert(cmd.includes("'echo hi'"), "command quoted");
const wwCmd = buildBwrapCommand("echo hi", ww);
assert(wwCmd.includes("--tmpfs"), "ww has tmpfs");
assert(wwCmd.includes("--bind"), "ww has bind");

console.log("=== probe ===");
overrideBwrapDetect(() => true);
assert(probeBwrap() === true, "override probe true");
overrideBwrapDetect(() => false);
assert(probeBwrap() === false, "override probe false");
overrideBwrapDetect(realProbe);

function realProbe() {
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    return spawnSync("bwrap", ["--version"], { timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
}

console.log("=== containment: isPathUnder ===");
const ws = mkdtempSync(join(tmpdir(), "dsh-fence-"));
const inner = join(ws, "a", "b.txt");
assert(isPathUnder(inner, ws) === true, "target under root (lexical)");
assert(isPathUnder(ws, ws) === true, "target === root");
const outside = join(tmpdir(), "other.txt");
assert(isPathUnder(outside, ws) === false, "outside root");
assert(isPathUnder(join(ws, "..", "outside.txt"), ws) === false, "lexical .. escape rejected");
assert(writableRoots({ mode: "workspace-write", workspaceRoot: ws }).length === 1, "workspace-write has 1 root");
assert(writableRoots({ mode: "read-only", workspaceRoot: ws }).length === 0, "read-only has 0 roots");
rmSync(ws, { recursive: true, force: true });

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
