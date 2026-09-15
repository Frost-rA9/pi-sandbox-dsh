/**
 * pi-sandbox-dsh-core · 后端不可用时的可见化（probe 失败路径）。
 *
 * 手法：把 `PATH` 清空**并**把 `PI_SANDBOX_NODE` 指向不存在的可执行文件 → 解析不到可用 Node
 * （Windows 走 winacl/Node runner；Linux 走 bwrap），probe 必失败。
 * 期望（fail-closed + 诚实告知）：
 * - 不注册受限 shell 工具（避免假收敛）；
 * - `/sandbox` 命令与 `tool_call` 文件门控仍在；
 * - `session_start` 发一条 error 级通知，说明"壳未收敛"+**后端自声明的真实原因**（不再写死 bwrap 文案），
 *   并给出修复方向；
 * - footer 徽标带 `(no backend)`，不宣称一个未生效的档位。
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
// 原因必须来自后端自声明，而不是写死的单一后端文案：
// win32 → winacl（缺 Node / runner probe 失败）；其他平台 → bwrap。
if (process.platform === "win32") {
  assert((notice?.message ?? "").includes("PI_SANDBOX_NODE"), "winacl 失败原因含显式覆盖项（不再是写死的 bwrap 文案）",
    (notice?.message ?? "").slice(0, 200));
} else {
  assert((notice?.message ?? "").includes("bwrap"), "bwrap 失败原因由 bwrap 后端自声明", (notice?.message ?? "").slice(0, 200));
}
assert(statuses.some((value) => value.includes("(no backend)")), "徽标带 (no backend)", statuses.join(" | "));

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
