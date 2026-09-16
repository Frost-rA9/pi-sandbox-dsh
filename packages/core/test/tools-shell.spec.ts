/**
 * pi-sandbox-dsh-core · 「同类壳」门控单测（纯逻辑 + mock pi，任意平台可跑）。
 *
 * 覆盖不变量 4 的补洞：pi 默认活跃的壳名是 `bash`，而 Windows 的受限壳只能是 `powershell`
 * → 未接管的那个名字（Windows 的 git-bash `bash`）必须在 confined 档被拦下，danger 档放行。
 */
import type { SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import { SHELL_TOOL_NAMES, foreignShellBlockReason, registerForeignShellGate } from "../src/tools-shell.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

console.log("=== 理由文案 ===");
const reason = foreignShellBlockReason("bash", "powershell", "read-only");
assert(reason.includes('the "bash" shell is not confinement-capable'), "点名被拦的壳与档位", reason.slice(0, 120));
assert(reason.includes('under read-only mode'), "含档位");
assert(reason.includes('use the "powershell" tool'), "指向受限壳");
assert(reason.includes("/sandbox"), "带切档出口（壳无 per-call 升级参数）");
assert(SHELL_TOOL_NAMES.includes("bash") && SHELL_TOOL_NAMES.includes("powershell"), "壳名字集合 = pi 的两个壳");

console.log("=== 门控行为（mock pi）===");
type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers: Handler[] = [];
const pi = { on: (name: string, handler: Handler) => { if (name === "tool_call") handlers.push(handler); } } as never;

let mode: SandboxExecutionPolicy["mode"] = "read-only";
const readState = (): SandboxExecutionPolicy => ({ mode, workspaceRoot: "/w" });
registerForeignShellGate(pi, readState, () => "powershell");
assert(handlers.length === 1, "注册了一条 tool_call 门控", String(handlers.length));

const fire = async (toolName: string | undefined): Promise<unknown> => handlers[0]!({ type: "tool_call", toolName, input: {} }, {});

assert((await fire("bash")) !== undefined && ((await fire("bash")) as { block?: boolean }).block === true, "confined 档：未接管的 bash 被拦");
assert((await fire("powershell")) === undefined, "confined 档：我们接管的 powershell 不在此处判（交给后端）");
assert((await fire("edit")) === undefined, "非壳工具不受本门控影响");
assert((await fire(undefined)) === undefined, "无 toolName 的事件不判");
assert((await fire("read")) === undefined, "读工具不受影响");

mode = "danger-full-access";
assert((await fire("bash")) === undefined, "danger 档：放行（用户显式放宽）");
mode = "workspace-write";
const blocked = (await fire("bash")) as { block?: boolean; reason?: string } | undefined;
assert(blocked?.block === true && (blocked.reason ?? "").includes("workspace-write"), "workspace-write 档同样拦下并标注档位");

console.log("=== Linux 方向（受限壳=bash）===");
const handlersLinux: Handler[] = [];
const piLinux = { on: (name: string, handler: Handler) => { if (name === "tool_call") handlersLinux.push(handler); } } as never;
registerForeignShellGate(piLinux, readState, () => "bash");
mode = "read-only";
const linuxBlock = (await handlersLinux[0]!({ type: "tool_call", toolName: "powershell", input: {} }, {})) as { block?: boolean } | undefined;
assert(linuxBlock?.block === true, "Linux：未接管的 powershell 也被拦（闲置即可，语义一致）");
assert((await handlersLinux[0]!({ type: "tool_call", toolName: "bash", input: {} }, {})) === undefined, "Linux：受限壳 bash 放行给后端");

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
