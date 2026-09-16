/**
 * pi-sandbox-dsh-core · 「同类壳」名字门控（不变量 4 的补洞）。
 *
 * 背景：pi 默认活跃的壳工具名是 `bash`（`core/agent-session.js` 的 `defaultActiveTools = [read,bash,edit,write]`）。
 * - Linux：受限壳正好叫 `bash` → **同名覆盖**即完成收敛（内置 `powershell` 不在默认 active，且非 win32 调用即抛错）。
 * - Windows：受限壳只能是 `powershell`（受限令牌 × git-bash 不兼容）→ 内置 `bash`（git-bash）仍活跃且**无约束**：
 *   模型可以直接用 `bash` 绕过沙箱。故 confined 档必须把「本后端未接管的那个壳名字」拦下。
 *
 * 机制 = pi 原生 `tool_call` 门控（与文件门控同一条缝）：不改工具目录（不用 `setActiveTools`）、
 * 不注册第二个"拒绝壳"、不新增状态。`danger-full-access` 是用户显式放宽 → 放行（裸跑由用户决策，对齐 dsh）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SandboxExecutionPolicy, SandboxMode } from "pi-sandbox-dsh-bridge";
import { sandboxWideningHint } from "pi-sandbox-dsh-bridge";

/** pi 的壳类工具名（本扩展只会接管其中一个）。 */
export const SHELL_TOOL_NAMES = ["bash", "powershell"] as const;

/**
 * 封壳理由（模型可见，英文）。
 * 第一行说明"这不是内核拒绝、而是该壳在本档下不具收敛能力"；第二行复用切档提示（壳没有 per-call 升级参数）。
 * @param toolName - 被拦下的壳名字。
 * @param confinedShell - 本后端实际收敛的壳名字（建议模型改用它）。
 * @param mode - 调用时的档位。
 */
export function foreignShellBlockReason(toolName: string, confinedShell: string, mode: SandboxMode): string {
  return `[sandbox: the "${toolName}" shell is not confinement-capable under ${mode} mode on this host — use the "${confinedShell}" tool for confined commands]\n`
    + sandboxWideningHint();
}

/**
 * 注册「未接管的同类壳」门控：confined 档下一律拦下，避免绕过收敛面。
 * @param pi - 扩展 API。
 * @param readState - 按 cwd 解析当前 policy（档位真源）。
 * @param confinedShell - 返回本后端接管的壳工具名（`bash` / `powershell`）。
 */
export function registerForeignShellGate(
  pi: ExtensionAPI,
  readState: (cwd: string) => SandboxExecutionPolicy,
  confinedShell: () => string,
): void {
  pi.on("tool_call", async (event) => {
    const e = event as { type?: string; toolName?: string };
    if (e?.type !== "tool_call") return;
    const toolName = e.toolName;
    if (toolName === undefined || !(SHELL_TOOL_NAMES as readonly string[]).includes(toolName)) return;
    // 我们接管的那一个：由后端自己的 operations 在调用点 fail-closed（不在这里重复判定）。
    if (toolName === confinedShell()) return;

    const mode = readState(process.cwd()).mode;
    if (mode === "danger-full-access") return; // 用户显式放宽 → 放行

    return { block: true, reason: foreignShellBlockReason(toolName, confinedShell(), mode) };
  });
}
