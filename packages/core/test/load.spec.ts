/**
 * pi-sandbox-dsh-core · 扩展加载冒烟（mock pi API）。
 *
 * 平台分叉（2026-09-21 决策）：
 * - **Linux/WSL2**：注册受限 `bash`（bwrap）+ write/edit 门控 + `/sandbox`；
 *   `session_start` 折叠档位；`before_agent_start` 注入档位提示段；结果侧分类端到端（bwrap 可用时）。
 * - **Windows**：无 OS 沙箱 → 固定 `danger-full-access`、不注册壳覆盖/门控；`/sandbox` 拒绝切换。
 */
import sandboxExtension from "../src/index.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name}`); }
}

const bwrap = spawnSync("bwrap", ["--version"], { timeout: 3000 }).status === 0;
const isWindows = process.platform === "win32";

/** 端到端用的工作目录（Linux 用 /tmp 保持原断言；Windows 无 e2e）。 */
const e2eRoot = isWindows ? mkdtempSync(join(tmpdir(), "pi-sandbox-dsh-load-")) : "/tmp";
const e2eWorkspace = isWindows ? join(e2eRoot, "ws") : "/tmp";
if (isWindows) mkdirSync(e2eWorkspace, { recursive: true });

// mock pi
const tools: Record<string, unknown>[] = [];
const commands: Record<string, unknown> = {};
const handlers = new Map<string, ((...a: unknown[]) => unknown)[]>();
const onHandler = (name: string, handler: (...a: unknown[]) => unknown): void => {
  handlers.set(name, [...(handlers.get(name) ?? []), handler]);
};
const firstHandler = (name: string): ((...a: unknown[]) => unknown) | undefined => handlers.get(name)?.[0];
const sent: { message: unknown; options: unknown }[] = [];
const entries: unknown[] = [];
/** 可观测的模型工具表（对齐 pi 默认活跃集：read/bash/edit/write）。 */
const activeTools: string[] = ["read", "bash", "edit", "write"];

const pi = {
  registerTool: (t: unknown) => {
    tools.push(t as Record<string, unknown>);
    const name = (t as { name?: string }).name;
    if (name !== undefined && !activeTools.includes(name)) activeTools.push(name);
  },
  registerCommand: (name: string, spec: unknown) => { commands[name] = spec; },
  registerFlag: () => {},
  on: onHandler,
  sendMessage: (m: unknown, o?: unknown) => { sent.push({ message: m, options: o }); },
  appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
  setActiveTools: (names: string[]) => { activeTools.splice(0, activeTools.length, ...names); },
  getActiveTools: () => [...activeTools],
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

console.log("=== 注册面（平台分叉）===");
if (isWindows) {
  assert(tools.length === 0, "win32：不注册任何工具（无壳覆盖）");
  assert((handlers.get("tool_call") ?? []).length === 0, "win32：不注册 tool_call 门控");
} else {
  const bashTool = tools.find((t) => (t as { name?: string }).name === "bash");
  assert(!!bashTool, "linux：受限 bash 工具已注册");
  if (bashTool) assert(typeof (bashTool as { execute?: unknown }).execute === "function", "linux：bash 工具有 execute");
  assert((handlers.get("tool_call") ?? []).length >= 1, "linux：文件门控（write/edit）已注册");
}

console.log("=== 注册了 /sandbox 命令? ===");
assert(!!commands["sandbox"], "/sandbox command registered（两平台都保留可见性）");

console.log("=== session_start ===");
const sessionCtx = {
  cwd: e2eWorkspace,
  sessionManager: { getEntries: () => [{ customType: "sandbox-mode", data: { mode: "workspace-write" } }] },
  ui: undefined,
};
try {
  firstHandler("session_start")!({}, sessionCtx);
  passed++;
} catch (e) {
  failed++;
  console.error(`  ✗ session_start 异常: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("=== before_agent_start 返回档位提示段 ===");
try {
  const r = firstHandler("before_agent_start")!({ systemPrompt: "base" }) as { systemPrompt: string };
  if (isWindows) {
    assert(r.systemPrompt.includes("danger-full-access"), "win32：提示段为固定 danger-full-access");
    assert(/no OS write sandbox/.test(r.systemPrompt), "win32：提示段声明本平台无沙箱");
  } else {
    assert(r.systemPrompt.includes("workspace-write"), "linux：提示段含折叠档 workspace-write");
  }
} catch (e) {
  failed++;
  console.error(`  ✗ before_agent_start 异常: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("=== /sandbox 行为（平台分叉）===");
try {
  const handler = (commands["sandbox"] as { handler: (args: string, ctx: unknown) => Promise<void> }).handler;
  const notices: { message: string; level: string }[] = [];
  const ui = {
    theme: { fg: (_c: string, t: string) => t },
    setStatus: () => {},
    select: async () => "切换",
    notify: (message: string, level: string) => { notices.push({ message, level }); },
  };
  if (isWindows) {
    await handler("workspace-write", { ui });
    assert(notices.length === 1 && /不可切换|fixed/.test(notices[0]!.message), "win32：/sandbox 拒绝切换并说明原因");
    assert(entries.length === 0, "win32：拒绝切换时不写 sandbox-mode entry");
  } else {
    const before = sent.length;
    await handler("danger-full-access", { ui }); // 折叠档为 workspace-write → 发生切换
    const switched = sent
      .slice(before)
      .filter((x) => (x.message as { customType?: string }).customType === "sandbox-mode:notice");
    assert(switched.length === 1, "linux：切档 → 恰发一条 sandbox-mode:notice");
    assert(
      (switched[0]!.message as { content?: string }).content === "The user switched the sandbox mode: workspace-write → danger-full-access",
      "linux：notice 为英文且带上一次/本次档位",
    );
    assert((switched[0]!.options as { deliverAs?: string } | undefined)?.deliverAs === "steer", "linux：notice 走 steer 通道");
    assert(
      entries.some((e) => (e as { type?: string; data?: { mode?: string } }).type === "sandbox-mode" && (e as { data?: { mode?: string } }).data?.mode === "danger-full-access"),
      "linux：切档同时写 sandbox-mode 日志",
    );
  }
} catch (e) {
  failed++;
  console.error(`  ✗ /sandbox 行为异常: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("=== 文件门控（linux）===");
if (!isWindows) {
  const fireToolCall = async (toolName: string, input: unknown): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get("tool_call") ?? []) {
      results.push(await handler({ type: "tool_call", toolName, input }, {}));
    }
    return results;
  };
  // 上一节把档切到了 danger-full-access → 文件门控放行；这里不再断言拒绝（档位已变），
  // 只断言门控存在且读工具不被拦。
  assert((await fireToolCall("read", {})).every((r) => r === undefined), "linux：读工具不被文件门控拦");
}

console.log("=== 结果侧分类：受限 bash 端到端（bwrap）===");
type ExecTool = {
  execute: (id: string, args: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
};
if (!isWindows && bwrap) {
  // 重新折叠回 workspace-write（上一节把档切成了 danger-full-access）
  firstHandler("session_start")!({}, sessionCtx);
  const bashTool = tools.find((t) => (t as { name?: string }).name === "bash") as unknown as ExecTool;
  const execCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "load-spec", getSessionFile: () => undefined } };
  const target = `/dsh-load-spec-${process.pid}.txt`;
  let message = "";
  try {
    await bashTool.execute("tool-call", { command: `echo hi > ${target}` }, undefined, undefined, execCtx);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("[sandbox: file access denied under workspace-write mode]"), "registered bash tool surfaces the denial marker");
  assert(message.includes("/sandbox"), "registered bash tool surfaces the widening hint");
  assert(message.includes("Read-only file system"), "marker rides a real EROFS failure");
} else {
  console.log(isWindows ? "  (win32：无沙箱，跳过分类端到端)" : "  (bwrap 不可用：跳过分类端到端)");
}

if (isWindows) rmSync(e2eRoot, { recursive: true, force: true });

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
