/**
 * pi-sandbox-dsh-core · 后端不可用时的可见化（probe 失败路径）。
 *
 * 手法：把 `PATH` 清空后实例化扩展 → bwrap / node 都探测不到 → `probe()` 必失败。
 * 期望（fail-closed + 诚实告知）：
 * - 不注册受限 shell 工具（避免假收敛）；
 * - `/sandbox` 命令与 `tool_call` 文件门控仍在；
 * - `session_start` 发一条 error 级通知，说明"壳未收敛"，并给出修复方向；
 * - footer 徽标带 `(no backend)`，不宣称一个未生效的档位。
 */
import sandboxExtension from "../src/index.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const tools: Record<string, unknown>[] = [];
const commands: Record<string, unknown> = {};
const handlers: Record<string, (...a: unknown[]) => unknown> = {};
const statuses: string[] = [];
const notices: { message: string; type: string | undefined }[] = [];

const pi = {
  registerTool: (t: unknown) => { tools.push(t as Record<string, unknown>); },
  registerCommand: (name: string, spec: unknown) => { commands[name] = spec; },
  registerFlag: () => {},
  on: (name: string, h: (...a: unknown[]) => unknown) => { handlers[name] = h; },
  sendMessage: () => {},
  appendEntry: () => {},
  setActiveTools: () => {},
  getActiveTools: () => [] as string[],
  getFlag: () => undefined,
} as never;

console.log("=== PATH 清空后实例化（后端必探测失败） ===");
// Windows 上环境变量名可能是 `Path`；把大小写变体全部清空，确保 node/bwrap 都探测不到。
const pathKeys = Object.keys(process.env).filter((key) => key.toLowerCase() === "path");
if (!pathKeys.includes("PATH")) pathKeys.push("PATH");
const savedPathValues = new Map(pathKeys.map((key) => [key, process.env[key]]));
for (const key of pathKeys) process.env[key] = "";
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
}

console.log("=== 未注册受限 shell 工具（fail-closed，不假收敛） ===");
const shellTools = tools.filter((t) => ["bash", "powershell"].includes(String(t.name)));
assert(shellTools.length === 0, "不注册 bash/powershell 工具", shellTools.map((t) => String(t.name)).join(", "));

console.log("=== 文件门控与非 shell 能力仍在 ===");
assert(commands["sandbox"] !== undefined, "/sandbox 命令仍注册");
assert(typeof handlers["tool_call"] === "function", "tool_call 文件门控仍注册");

console.log("=== session_start：error 通知 + 诚实徽标 ===");
const ui = {
  theme: { fg: (_color: string, text: string) => text },
  setStatus: (_key: string, value: string) => { statuses.push(value); },
  notify: (message: string, type?: string) => { notices.push({ message, type }); },
  select: async () => undefined,
};
try {
  handlers["session_start"]!({}, { cwd: process.cwd(), sessionManager: { getEntries: () => [] }, ui });
  passed++;
} catch (error) {
  failed++;
  console.error(`  ✗ session_start 异常: ${error instanceof Error ? error.message : String(error)}`);
}
assert(notices.length === 1, "恰发一条通知", `实际 ${notices.length}`);
const notice = notices[0];
assert(notice?.type === "error", "通知级别为 error", String(notice?.type));
assert((notice?.message ?? "").includes("sandbox backend unavailable"), "通知说明后端不可用");
assert((notice?.message ?? "").includes("not OS-confined"), "通知明说壳未被收敛（不误导为策略拒绝）");
assert(/node|bwrap/u.test(notice?.message ?? ""), "通知给出修复方向（node / bwrap）");
assert(statuses.some((value) => value.includes("(no backend)")), "徽标带 (no backend)", statuses.join(" | "));

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
