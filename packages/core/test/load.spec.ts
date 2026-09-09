/**
 * pi-sandbox-dsh-core · 扩展加载冒烟（mock pi API，Linux/bwrap 可用时）。
 *
 * 验证：实例化扩展不崩、注册了 bash 工具 + /sandbox 命令、session_start 折叠档位、
 * before_agent_start 返回档位提示段、tool_call 钩子存在。
 */
import sandboxExtension from "../src/index.ts";
import type { SandboxBackendInfo } from "pi-sandbox-dsh-bridge";
import { spawnSync } from "node:child_process";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name}`); }
}

const bwrap = spawnSync("bwrap", ["--version"], { timeout: 3000 }).status === 0;

// mock pi
const tools: Record<string, unknown>[] = [];
const commands: Record<string, unknown> = {};
const handlers: Record<string, (...a: unknown[]) => unknown> = {};
const messages: unknown[] = [];
const entries: unknown[] = [];

const pi = {
  registerTool: (t: unknown) => { tools.push(t as Record<string, unknown>); },
  registerCommand: (name: string, spec: unknown) => { commands[name] = spec; },
  registerFlag: () => {},
  on: (name: string, h: (...a: unknown[]) => unknown) => { handlers[name] = h; },
  sendMessage: (m: unknown) => { messages.push(m); },
  appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
  setActiveTools: () => {},
  getActiveTools: () => [] as string[],
  getFlag: () => undefined,
} as never;

console.log("=== 实例化扩展 ===");
try {
  sandboxExtension(pi);
  passed++;
  console.log("  ✅ 扩展实例化无异常");
} catch (e) {
  failed++;
  console.error(`  ✗ 实例化抛异常: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("=== 注册了 bash 工具? ===");
const bashTool = tools.find((t) => (t as { name?: string }).name === "bash");
assert(!!bashTool, "bash tool registered");
if (bwrap) assert(typeof (bashTool as { execute?: unknown }).execute === "function", "bash tool has execute");

console.log("=== 注册了 /sandbox 命令? ===");
assert(!!commands["sandbox"], "/sandbox command registered");

console.log("=== tool_call 钩子存在? ===");
assert(typeof handlers["tool_call"] === "function", "tool_call hook registered");

console.log("=== session_start 折叠档位 ===");
const sessionCtx = { cwd: "/tmp", sessionManager: { getEntries: () => [{ customType: "sandbox-mode", data: { mode: "workspace-write" } }] } };
try {
  handlers["session_start"]!({}, sessionCtx);
  passed++;
} catch (e) {
  failed++;
  console.error(`  ✗ session_start 异常: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("=== before_agent_start 返回档位提示段 ===");
try {
  const r = handlers["before_agent_start"]!({ systemPrompt: "base" }) as { systemPrompt: string };
  assert(typeof r.systemPrompt === "string" && r.systemPrompt.includes("workspace-write"), "systemPrompt contains policy");
  passed++;
} catch (e) {
  failed++;
  console.error(`  ✗ before_agent_start 异常: ${e instanceof Error ? e.message : String(e)}`);
}

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
