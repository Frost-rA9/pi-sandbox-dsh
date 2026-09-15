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
export { winaclUsable, buildWinaclRunnerArgv, workspaceWriteSid, tempWriteSid, assertTempRootOutsideWorkspace, assertPrivateTempDisjoint } from "./win32/index.ts";
