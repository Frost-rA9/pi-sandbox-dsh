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
const sent: { message: unknown; options: unknown }[] = [];
const entries: unknown[] = [];

const pi = {
  registerTool: (t: unknown) => { tools.push(t as Record<string, unknown>); },
  registerCommand: (name: string, spec: unknown) => { commands[name] = spec; },
  registerFlag: () => {},
  on: (name: string, h: (...a: unknown[]) => unknown) => { handlers[name] = h; },
  sendMessage: (m: unknown, o?: unknown) => { messages.push(m); sent.push({ message: m, options: o }); },
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

console.log("=== 结果侧分类：注册的 bash 工具端到端 ===");
// 此时折叠档为 workspace-write；写工作区（/tmp）成功，写根目录被只读基座拒 → 应拿到 denial 标记。
if (bwrap) {
  const tool = bashTool as unknown as {
    execute: (id: string, args: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
  };
  const execCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "load-spec", getSessionFile: () => undefined } };
  const target = `/dsh-load-spec-${process.pid}.txt`;
  let message = "";
  try {
    await tool.execute("tool-call", { command: `echo hi > ${target}` }, undefined, undefined, execCtx);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("[sandbox: file access denied under workspace-write mode]"), "registered bash tool surfaces the denial marker");
  assert(message.includes("/sandbox"), "registered bash tool surfaces the widening hint");
  assert(message.includes("Read-only file system"), "marker rides a real EROFS failure");
} else {
  console.log("  (bwrap 不可用：跳过分类端到端)");
}

console.log("=== 切档 notice：英文文案 + steer 通道 + display ===");
try {
  const ui = {
    theme: { fg: (_c: string, t: string) => t },
    setStatus: () => {},
    select: async () => "切换",
  };
  const handler = (commands["sandbox"] as { handler: (args: string, ctx: unknown) => Promise<void> }).handler;
  const before = sent.length;
  await handler("danger-full-access", { ui }); // 当前折叠档为 workspace-write → 发生切换
  const notices = sent
    .slice(before)
    .filter((x) => (x.message as { customType?: string }).customType === "sandbox-mode:notice");
  assert(notices.length === 1, "切档 → 恰发一条 sandbox-mode:notice");
  const notice = notices[0]!;
  assert(
    (notice.message as { content?: string }).content === "The user switched the sandbox mode: workspace-write → danger-full-access",
    "notice 为英文且带上一次/本次档位",
  );
  assert((notice.message as { display?: boolean }).display === true, "notice display: true");
  assert((notice.options as { deliverAs?: string } | undefined)?.deliverAs === "steer", "notice 走 steer 通道");
  assert(
    entries.some((e) => (e as { type?: string; data?: { mode?: string } }).type === "sandbox-mode" && (e as { data?: { mode?: string } }).data?.mode === "danger-full-access"),
    "切档同时写 sandbox-mode 日志",
  );
} catch (e) {
  failed++;
  console.error(`  ✗ 切档 notice 异常: ${e instanceof Error ? e.message : String(e)}`);
}

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
