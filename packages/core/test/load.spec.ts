/**
 * pi-sandbox-dsh-core · 扩展加载冒烟（mock pi API）。
 *
 * 验证：实例化扩展不崩、注册了本平台 shell 工具（Linux=bash/bwrap；Windows=powershell/winacl）
 * + /sandbox 命令、session_start 折叠档位、before_agent_start 返回档位提示段、tool_call 钩子存在、
 * 以及**结果侧分类端到端**（后端可用时真跑一条 confined 命令，拿到 denial 标记）。
 */
import sandboxExtension from "../src/index.ts";
import type { SandboxBackendInfo } from "pi-sandbox-dsh-bridge";
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

/** 端到端用的工作目录（Windows 需要真实存在的路径；Linux 用 /tmp，保持原断言）。 */
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
const messages: unknown[] = [];
const sent: { message: unknown; options: unknown }[] = [];
const entries: unknown[] = [];

const pi = {
  registerTool: (t: unknown) => { tools.push(t as Record<string, unknown>); },
  registerCommand: (name: string, spec: unknown) => { commands[name] = spec; },
  registerFlag: () => {},
  on: onHandler,
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

console.log(`=== 注册了 ${isWindows ? "powershell" : "bash"} 工具? ===`);
const shellToolName = isWindows ? "powershell" : "bash";
const bashTool = tools.find((t) => (t as { name?: string }).name === shellToolName);
assert(!!bashTool, `${shellToolName} tool registered`);
if (bashTool) assert(typeof (bashTool as { execute?: unknown }).execute === "function", `${shellToolName} tool has execute`);

console.log("=== 注册了 /sandbox 命令? ===");
assert(!!commands["sandbox"], "/sandbox command registered");

console.log("=== tool_call 钩子存在? ===");
assert(typeof firstHandler("tool_call") === "function", "tool_call hook registered");
// 两条门控：文件（write/edit）+ 未接管的同类壳（不变量 4 的绕过口）
assert((handlers.get("tool_call") ?? []).length >= 2, "文件门控与同类壳门控都已注册");

console.log("=== session_start 折叠档位 ===");
const sessionCtx = { cwd: e2eWorkspace, sessionManager: { getEntries: () => [{ customType: "sandbox-mode", data: { mode: "workspace-write" } }] } };
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
  assert(typeof r.systemPrompt === "string" && r.systemPrompt.includes("workspace-write"), "systemPrompt contains policy");
  passed++;
} catch (e) {
  failed++;
  console.error(`  ✗ before_agent_start 异常: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("=== 结果侧分类：注册的 shell 工具端到端 ===");
// 此时折叠档为 workspace-write：写工作区允许；写工作区外被内核/令牌拒 → 应拿到 denial 标记。
type ExecTool = {
  execute: (id: string, args: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
};
if (bashTool === undefined) {
  console.log("  (后端不可用：未注册 shell 工具，跳过分类端到端)");
} else if (isWindows) {
  const tool = bashTool as unknown as ExecTool;
  const execCtx = { cwd: e2eWorkspace, sessionManager: { getSessionId: () => "load-spec", getSessionFile: () => undefined } };
  const insidePath = join(e2eWorkspace, "inside.txt");
  const outsidePath = join(e2eRoot, "outside.txt");
  try {
    await tool.execute("tool-call", { command: `Set-Content -LiteralPath '${insidePath}' -Value hi` }, undefined, undefined, execCtx);
    assert(existsSync(insidePath), "winacl workspace-write：工作区内写入成功");
  } catch (error) {
    assert(false, `winacl workspace-write 写入抛异常: ${error instanceof Error ? error.message : String(error)}`);
  }
  let message = "";
  try {
    await tool.execute("tool-call", { command: `Set-Content -LiteralPath '${outsidePath}' -Value hi` }, undefined, undefined, execCtx);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("[sandbox: file access denied under workspace-write mode]"), "winacl 工具抛出 denial 标记");
  assert(message.includes("/sandbox"), "winacl 工具抛出切档提示");
  assert(/access to the path|access is denied/i.test(message), "denial 骑在真实 winacl 拒写文案上");
  rmSync(e2eRoot, { recursive: true, force: true });
} else if (bwrap) {
  const tool = bashTool as unknown as ExecTool;
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

console.log("=== 同类壳门控（后端可用时也生效）===");
// 不变量 4 的绕过口：Windows 的受限壳是 powershell，而默认活跃的 git-bash `bash` 不具收敛能力。
const confinedShell = isWindows ? "powershell" : "bash";
const foreignShell = isWindows ? "bash" : "powershell";
const fireToolCall = async (toolName: string): Promise<unknown[]> => {
  const results: unknown[] = [];
  for (const handler of handlers.get("tool_call") ?? []) {
    results.push(await handler({ type: "tool_call", toolName, input: {} }, {}));
  }
  return results;
};
// 当前折叠档 = workspace-write（session_start 已跑）→ 未接管的同类壳必须被拦下
const blockedForeign = (await fireToolCall(foreignShell)).find(
  (r) => (r as { block?: boolean } | undefined)?.block === true,
) as { reason?: string } | undefined;
assert(blockedForeign !== undefined, `workspace-write 下 ${foreignShell} 被门控拦下`);
assert((blockedForeign?.reason ?? "").includes(`use the "${confinedShell}" tool`), "封壳理由指向受限壳");
assert((await fireToolCall(confinedShell)).every((r) => r === undefined), "接管的受限壳不被此门控拦（交给后端）");
assert((await fireToolCall("read")).every((r) => r === undefined), "读工具不受同类壳门控影响");

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
