/**
 * pi-sandbox-dsh-core · 后端不可用时的行为（fail-closed + 不假收敛），DESIGN 不变量 4/10。
 *
 * 手法：把 `PATH` 清空**并**把 `PI_SANDBOX_NODE` 指向不存在的可执行文件 → 后端必探测失败
 * （Windows 走 winacl/Node runner；Linux 走 bwrap），随即核对：
 * - **受限壳工具仍在**（平台对应：win32=`powershell`，其余=`bash`）——缝恒在位，不是"工具消失"；
 * - confined 档下**调用被拒**：抛 `SANDBOX_UNAVAILABLE`（带精确原因），**绝不裸跑**；
 * - `danger-full-access` 下同一工具**委托 pi 本地 shell 并真的执行**（用户显式决策的出口）；
 * - **未接管的同类壳**在该平台上被 `tool_call` 门控拦下（Windows 的 `bash`=git-bash 是真实绕过口）；
 * - 文件门控仍在，且拒绝文案标注"档位策略拒绝（无 OS 后端）"；
 * - `session_start` 发一条 error 通知 + 徽标带 `(no backend)`。
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
/** 可观测的模型工具表（对齐 pi 默认活跃集：read/bash/edit/write）。 */
const activeTools: string[] = ["read", "bash", "edit", "write"];
const pi = {
  registerTool: (t: unknown) => { tools.push(t as Record<string, unknown>); },
  registerCommand: (name: string, spec: unknown) => { commands[name] = spec; },
  registerFlag: () => {},
  on,
  sendMessage: () => {},
  appendEntry: () => {},
  setActiveTools: (names: string[]) => { activeTools.splice(0, activeTools.length, ...names); },
  getActiveTools: () => [...activeTools],
  getFlag: () => undefined,
} as never;

console.log("=== 强制后端不可用后实例化 ===");
// Windows 上环境变量名可能是 `Path`；把大小写变体全部清空，确保 node/bwrap 都探测不到。
const pathKeys = Object.keys(process.env).filter((key) => key.toLowerCase() === "path");
if (!pathKeys.includes("PATH")) pathKeys.push("PATH");
const savedPathValues = new Map(pathKeys.map((key) => [key, process.env[key]]));
const savedNodeOverride = process.env.PI_SANDBOX_NODE;
for (const key of pathKeys) process.env[key] = "";
// 显式覆盖指向不存在的 Node：保证确定性失败（否则 Windows 会从注册表 Path 里找到 node）。
process.env.PI_SANDBOX_NODE = resolve(process.cwd(), "no-such-node-binary.exe");
try {
  sandboxExtension(pi);
  passed++;
} catch (error) {
  failed++;
  console.error(`  ✗ 实例化抛异常: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const [key, value] of savedPathValues) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedNodeOverride === undefined) delete process.env.PI_SANDBOX_NODE;
  else process.env.PI_SANDBOX_NODE = savedNodeOverride;
}

const shellName = process.platform === "win32" ? "powershell" : "bash";
const foreignShellName = process.platform === "win32" ? "bash" : "powershell";

console.log("=== 缝恒在位：受限壳工具仍注册 ===");
const shellTool = tools.find((t) => String(t.name) === shellName) as
  | { execute: (id: string, args: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> }
  | undefined;
assert(shellTool !== undefined, `${shellName} 受限壳仍注册`, tools.map((t) => String(t.name)).join(", "));
assert(commands["sandbox"] !== undefined, "/sandbox 命令仍注册");
assert((handlers.get("tool_call") ?? []).length >= 2, "两条 tool_call 门控都在（文件 + 同类壳）");

console.log("=== session_start：error 通知 + 诚实徽标 ===");
const ui = {
  theme: { fg: (_color: string, text: string) => text },
  setStatus: (_key: string, value: string) => { statuses.push(value); },
  notify: (message: string, type?: string) => { notices.push({ message, type }); },
  select: async () => undefined,
};
const readOnlySession = { cwd: process.cwd(), sessionManager: { getEntries: () => [] }, ui };
for (const handler of handlers.get("session_start") ?? []) await handler({}, readOnlySession);
assert(notices.length === 1, "恰发一条通知", `实际 ${notices.length}`);
const notice = notices[0];
assert(notice?.type === "error", "通知级别为 error", String(notice?.type));
assert((notice?.message ?? "").includes("will REFUSE commands"), "通知说明受限壳会拒绝执行（而非'工具没注册'）", (notice?.message ?? "").slice(0, 160));
// 未接管的壳：win32 是平台态摘表（工具表里没有 git-bash），Linux 是门控拦下闲置的 powershell。
const otherShellClause = process.platform === "win32"
  ? "git-bash (`bash`) is not offered on this host"
  : "the other shell tool (`powershell`) is gated off";
assert((notice?.message ?? "").includes(otherShellClause), `通知说明另一个壳的去向（${otherShellClause}）`, (notice?.message ?? "").slice(0, 220));
if (process.platform === "win32") {
  assert(!activeTools.includes("bash"), `win32：后端不可用也不让 git-bash 回到工具表（现有: ${activeTools.join(",")}）`);
}
if (process.platform === "win32") {
  assert((notice?.message ?? "").includes("PI_SANDBOX_NODE"), "失败原因来自 winacl 后端自声明", (notice?.message ?? "").slice(0, 200));
} else {
  assert((notice?.message ?? "").includes("bwrap"), "失败原因来自 bwrap 后端自声明", (notice?.message ?? "").slice(0, 200));
}
assert(statuses.some((value) => value.includes("(no backend)")), "徽标带 (no backend)", statuses.join(" | "));

console.log("=== confined 档：调用被拒（fail-closed，绝不裸跑）===");
const execCtx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "spec", getSessionFile: () => undefined } };
let refusal: unknown;
try {
  await shellTool!.execute("tool-call", { command: "echo should-not-run" }, undefined, undefined, execCtx);
} catch (error) {
  refusal = error;
}
assert(refusal instanceof Error, "read-only 档下调用抛错");
assert((refusal as { code?: string } | undefined)?.code === "SANDBOX_UNAVAILABLE", "错误码为 SANDBOX_UNAVAILABLE", String((refusal as { code?: string } | undefined)?.code));
assert(/unconfined/u.test((refusal as Error | undefined)?.message ?? ""), "错误文案声明绝不裸跑", (refusal as Error | undefined)?.message?.slice(0, 160));

console.log("=== danger-full-access：委托 pi 本地 shell 并真的执行 ===");
/** 折档：执行 session_start 把 store 折到指定档（与真实 pi 的日志折叠同路径）。 */
async function setMode(mode: string): Promise<void> {
  const entries = [{ customType: "sandbox-mode", data: { mode } }];
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, { cwd: process.cwd(), sessionManager: { getEntries: () => entries }, ui });
  }
}
await setMode("danger-full-access");
let dangerOutput = "";
try {
  const result = (await shellTool!.execute(
    "tool-call",
    { command: process.platform === "win32" ? "Write-Output danger-ok" : "echo danger-ok" },
    undefined,
    (data: unknown) => { dangerOutput += String(data); },
    execCtx,
  )) as { content?: { text?: string }[] } | undefined;
  dangerOutput += JSON.stringify(result ?? {});
} catch (error) {
  dangerOutput = `THREW ${error instanceof Error ? error.message : String(error)}`;
}
assert(dangerOutput.includes("danger-ok"), "danger 档真的执行了本地 shell", dangerOutput.slice(0, 160));

console.log("=== 未接管的同类壳：confined 档被门控，danger 档放行 ===");
const gateResultsFor = async (toolName: string): Promise<(unknown)[]> => {
  const results: (unknown)[] = [];
  for (const handler of handlers.get("tool_call") ?? []) {
    results.push(await handler({ type: "tool_call", toolName, input: {} }, {}));
  }
  return results;
};
// danger 档：放行（用户显式放宽）
assert((await gateResultsFor(foreignShellName)).every((r) => r === undefined), "danger 档下同类壳未被拦（用户显式放宽）");
// confined 档：拦下
await setMode("read-only");
const blocked = (await gateResultsFor(foreignShellName)).find(
  (r) => (r as { block?: boolean } | undefined)?.block === true,
) as { reason?: string } | undefined;
assert(blocked !== undefined, `confined 档下 ${foreignShellName} 被拦下`);
assert((blocked?.reason ?? "").includes("not confinement-capable"), "封壳理由说明非收敛能力", (blocked?.reason ?? "").slice(0, 160));
assert((blocked?.reason ?? "").includes(`use the "${shellName}" tool`), "封壳理由指向受限壳");
assert((blocked?.reason ?? "").includes("/sandbox"), "封壳理由带上切档出口");
const ours = (await gateResultsFor(shellName)).filter((r) => r !== undefined);
assert(ours.length === 0, "我们不重复判自己接管的那一个（交给后端 fail-closed）");
console.log("=== 文件门控：拒绝文案标注'档位策略拒绝（无 OS 后端）' ===");
let fileBlock: { block?: boolean; reason?: string } | undefined;
for (const handler of handlers.get("tool_call") ?? []) {
  const result = (await handler({ type: "tool_call", toolName: "edit", input: { path: resolve(process.cwd(), "x.txt") } }, {})) as
    | { block?: boolean; reason?: string }
    | undefined;
  if (result?.block === true) fileBlock = result;
}
assert(fileBlock !== undefined, "文件门控仍拦下 edit（read-only）");
assert((fileBlock?.reason ?? "").includes("policy denial — no OS sandbox backend"), "拒绝文案标注档位策略拒绝（非内核拒绝）", (fileBlock?.reason ?? "").slice(0, 200));

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
