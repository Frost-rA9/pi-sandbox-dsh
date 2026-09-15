/**
 * pi-sandbox-dsh-sandbox · 库入口（供 core import；非独立扩展）。
 */
export {
  buildBwrapCommand,
  bwrapProfileArgs,
  detectBwrap,
  overrideBwrapDetect,
  probeBwrap,
  safeQuote,
} from "./bwrap.ts";
export {
  createBwrapBackend,
  selectBackend,
  type SandboxBackend,
  type BackendContext,
} from "./backend.ts";
export {
  createConfinedOperations,
  resolveRunFacts,
  MAX_CLASSIFY_BYTES,
  type ConfinedRunFacts,
} from "./classify.ts";
export { isPathUnder, writableRoots } from "./containment.ts";
export { createWinaclBackend } from "./winacl.ts";
// 纯函数/契约（无原生依赖）与 winacl 库层分开导出：宿主侧不会因 public 入口而拉起 koffi 图。
export { buildWinaclRunnerArgv, winaclUsable, type WinaclRunnerSpec } from "./win32/runner-contract.ts";
export {
  AclSandbox,
  AclWriteGrant,
  assertPrivateTempDisjoint,
  assertTempRootOutsideWorkspace,
  tempWriteSid,
  workspaceWriteSid,
  type AclSandboxChild,
  type AclSandboxChildResult,
  type AclSandboxOptions,
  type AclSandboxSpawnOptions,
} from "./win32/index.ts";
