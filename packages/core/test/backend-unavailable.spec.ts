/**
 * pi-sandbox-dsh-core · 后端不可用（Linux fail-closed）与 Windows 无沙箱的行为。
 *
 * **Linux/WSL2**（不变量 4/10）：清空 `PATH` 强制 bwrap 探测失败，核对：
 * - **受限 `bash` 工具仍在**——缝恒在位，不是"工具消失"；
 * - confined 档下**调用被拒**：抛 `SANDBOX_UNAVAILABLE`（带精确原因），**绝不裸跑**；
 * - `danger-full-access` 下同一工具**委托 pi 本地 shell 并真的执行**（用户显式决策的出口）；
 * - 文件门控仍在，且拒绝文案标注"档位策略拒绝（无 OS 后端）"；
 * - `session_start` 发一条 error 通知 + 徽标带 `(no backend)`。
 *
 * **Windows**（2026-09-21 决策）：无 OS 沙箱 → 固定 `danger-full-access`、不注册壳覆盖/门控、
 * `/sandbox` 拒绝切换；徽标带 `(no sandbox)`。
 */
import sandboxExtension from "../src/index.ts";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown;
const tools: Record<string, unknown>[] = [];
const commands: Record<string, unknown> = {};
const handlers = new Map<string, Handler[]>();
const statuses: string[] = [];
const notices: { message: string; type: string | undefined }[] = [];
const on = (name: string, handler: Handler): void => {
  handlers.set(name, [...(handlers.get(name) ?? []), handler]);
};
const pi = {
  registerTool: (t: unknown) => { tools.push(t as Record<string, unknown>); },
  registerCommand: (name: string, spec: unknown) => { commands[name] = spec; },
  registerFlag: () => {},
  on,
  sendMessage: () => {},
  appendEntry: () => {},
  setActiveTools: () => {},
  getActiveTools: () => [],
  getFlag: () => undefined,
} as never;

const isWindows = process.platform === "win32";

/** 强制后端探测失败（Linux）：清空 PATH，并把 PI_SANDBOX_NODE 指向不存在的可执行文件。 */
const pathKeys = Object.keys(process.env).filter((key) => key.toLowerCase() === "path");
if (!pathKeys.includes("PATH")) pathKeys.push("PATH");
const savedPathValues = new Map(pathKeys.map((key) => [key, process.env[key]]));
const savedNodeOverride = process.env.PI_SANDBOX_NODE;
function restoreEnv(): void {
  for (const [key, value] of savedPathValues) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedNodeOverride === undefined) delete process.env.PI_SANDBOX_NODE;
  else process.env.PI_SANDBOX_NODE = savedNodeOverride;
}
if (!isWindows) {
  for (const key of pathKeys) process.env[key] = "";
  process.env.PI_SANDBOX_NODE = resolve(process.cwd(), "no-such-node-binary");
}

console.log("=== 实例化（Linux：后端不可用 / Windows：无后端）===");
try {
  sandboxExtension(pi);
  passed++;
} catch (error) {
  failed++;
  console.error(`  ✗ 实例化抛异常: ${error instanceof Error ? error.message : String(error)}`);
  restoreEnv();
}

const ui = {
  theme: { fg: (_color: string, text: string) => text },
  setStatus: (_key: string, value: string) => { statuses.push(value); },
  notify: (message: string, type?: string) => { notices.push({ message, type }); },
  select: async () => undefined,
};
const execCtx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "spec", getSessionFile: () => undefined } };

if (isWindows) {
  console.log("=== Windows：无沙箱（固定 danger-full-access）===");
  assert(tools.length === 0, "不注册任何工具（无壳覆盖）");
  assert((handlers.get("tool_call") ?? []).length === 0, "不注册 tool_call 门控");
  assert(commands["sandbox"] !== undefined, "/sandbox 仍注册（可见性）");
  for (const handler of handlers.get("session_start") ?? []) await handler({}, { cwd: process.cwd(), sessionManager: { getEntries: () => [{ customType: "sandbox-mode", data: { mode: "read-only" } }] }, ui });
  assert(statuses.some((value) => value.includes("[danger-full-access]") && value.includes("(no sandbox)")), "徽标固定 danger-full-access 且带 (no sandbox)", statuses.join(" | "));
  assert(notices.some((n) => n.type === "warning" && n.message.includes("no OS write sandbox")), "session_start 发一条 warning 说明本平台无沙箱", JSON.stringify(notices).slice(0, 200));
  // /sandbox 拒绝切换
  const handler = (commands["sandbox"] as { handler: (args: string, ctx: unknown) => Promise<void> }).handler;
  const before = notices.length;
  await handler("workspace-write", { ui });
  assert(notices.length === before + 1 && /不可切换|fixed/.test(notices.at(-1)!.message), "/sandbox 拒绝切换并说明原因", notices.at(-1)?.message?.slice(0, 160));
} else {
  console.log("=== Linux：缝恒在位：受限 bash 工具仍注册 ===");
  const shellTool = tools.find((t) => String(t.name) === "bash") as
    | { execute: (id: string, args: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> }
    | undefined;
  assert(shellTool !== undefined, "bash 受限壳仍注册", tools.map((t) => String(t.name)).join(", "));
  assert(commands["sandbox"] !== undefined, "/sandbox 命令仍注册");
  assert((handlers.get("tool_call") ?? []).length >= 1, "文件门控仍在");

  console.log("=== session_start：error 通知 + 诚实徽标 ===");
  for (const handler of handlers.get("session_start") ?? []) await handler({}, { cwd: process.cwd(), sessionManager: { getEntries: () => [] }, ui });
  assert(notices.length === 1, "恰发一条通知", `实际 ${notices.length}`);
  const notice = notices[0];
  assert(notice?.type === "error", "通知级别为 error", String(notice?.type));
  assert((notice?.message ?? "").includes("will REFUSE commands"), "通知说明受限壳会拒绝执行（而非'工具没注册'）", (notice?.message ?? "").slice(0, 160));
  assert((notice?.message ?? "").includes("bwrap"), "失败原因来自 bwrap 后端自声明", (notice?.message ?? "").slice(0, 200));
  assert(statuses.some((value) => value.includes("(no backend)")), "徽标带 (no backend)", statuses.join(" | "));

  console.log("=== confined 档：调用被拒（fail-closed，绝不裸跑）===");
  let refusal: unknown;
  try {
    await shellTool!.execute("tool-call", { command: "echo should-not-run" }, undefined, undefined, execCtx);
  } catch (error) {
    refusal = error;
  }
  assert(refusal instanceof Error, "read-only 档下调用抛错");
  assert((refusal as { code?: string } | undefined)?.code === "SANDBOX_UNAVAILABLE", "错误码为 SANDBOX_UNAVAILABLE", String((refusal as { code?: string } | undefined)?.code));
  assert(/unconfined/u.test((refusal as Error | undefined)?.message ?? ""), "错误文案声明绝不裸跑", (refusal as Error | undefined)?.message?.slice(0, 160));

  restoreEnv();

  console.log("=== danger-full-access：委托 pi 本地 shell 并真的执行 ===");
  async function setMode(mode: string): Promise<void> {
    const entries = [{ customType: "sandbox-mode", data: { mode } }];
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, { cwd: process.cwd(), sessionManager: { getEntries: () => entries }, ui });
    }
  }
  await setMode("danger-full-access");
  let dangerOutput = "";
  try {
    const result = (await shellTool!.execute("tool-call", { command: "echo danger-ok" }, undefined, (data: unknown) => { dangerOutput += String(data); }, execCtx)) as
      | { content?: { text?: string }[] }
      | undefined;
    dangerOutput += JSON.stringify(result ?? {});
  } catch (error) {
    dangerOutput = `THREW ${error instanceof Error ? error.message : String(error)}`;
  }
  assert(dangerOutput.includes("danger-ok"), "danger 档真的执行了本地 shell", dangerOutput.slice(0, 160));

  console.log("=== 文件门控：拒绝文案标注'档位策略拒绝（无 OS 后端）' ===");
  await setMode("read-only");
  let fileBlock: { block?: boolean; reason?: string } | undefined;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = (await handler({ type: "tool_call", toolName: "edit", input: { path: resolve(process.cwd(), "x.txt") } }, {})) as
      | { block?: boolean; reason?: string }
      | undefined;
    if (result?.block === true) fileBlock = result;
  }
  assert(fileBlock !== undefined, "文件门控仍拦下 edit（read-only）");
  assert((fileBlock?.reason ?? "").includes("policy denial — no OS sandbox backend"), "拒绝文案标注档位策略拒绝（非内核拒绝）", (fileBlock?.reason ?? "").slice(0, 200));
}

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
