/**
 * pi-sandbox-dsh-core · 「同类壳」收敛（不变量 4 的补洞）：**平台态摘表** + **门控兜底**。
 *
 * 背景：pi 默认活跃的壳工具名是 `bash`（`core/agent-session.js` 的 `defaultActiveTools = [read,bash,edit,write]`）。
 * - Linux：受限壳正好叫 `bash` → **同名覆盖**即完成收敛（内置 `powershell` 不在默认 active，且非 win32 调用即抛错）。
 * - Windows：受限壳只能是 `powershell`（受限令牌 × git-bash 不兼容，见 `docs/architecture.md`）→ 内置 `bash`
 *   （git-bash）既活跃又**无收敛能力**：模型可以直接用它绕过沙箱。
 *
 * 收敛按 dsh「one shell stack per host」做成**平台态**：win32 上把 `bash` 从**模型工具表**里摘掉
 * （`setActiveTools`），**不按档位还原** —— `danger-full-access` 只是"不约束"，不是"多一个壳"。
 * 该决策与档位无关（同 dsh：壳栈按平台定），故只在 `session_start` 做一次。
 *
 * `tool_call` 门控保留为**兜底**：别的扩展（用「记基线→还原」惯用法）/ `--tools` / `defaultTools`
 * 把名字塞回来时，confined 档仍在调用点拦下（门控读档位真源，不依赖"谁最后写工具表"）。
 * `danger-full-access` 是用户显式放宽 → 门控放行（裸跑由用户决策，对齐 dsh）。
 *
 * 机制 = pi 原生 `setActiveTools`（平台态、一次性）+ `tool_call` 门控（同回合窗口兜底）：
 * 不改工具注册状态、不注册第二个"拒绝壳"、不新增状态。
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
 * 本平台"不具收敛能力"的壳名字（平台常量，与档位无关）。
 * win32 = git-bash `bash`（MSYS2 运行时在受限令牌下起不来）；其余平台无需摘除：
 * 受限壳即 `bash`（同名覆盖），闲置的 `powershell` 默认就不在工具表里。
 * @param platform - 目标平台（默认当前进程；测试用注入）。
 */
export function unconfinableShellName(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === "win32" ? "bash" : undefined;
}

/**
 * 把本平台不具收敛能力的壳从**模型工具表**里摘掉（dsh「one shell stack per host」的 pi 形态）。
 * 幂等；只摘这一个名字，不动其他扩展（可能是懒加载加进来）的工具；非该平台为 no-op。
 * @param pi - 扩展 API（只需工具表两个方法）。
 * @param platform - 目标平台（默认当前进程；测试用注入）。
 * @returns 被摘掉的名字（本来就不在表里 → undefined）。
 */
export function dropUnconfinableShell(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const foreign = unconfinableShellName(platform);
  if (foreign === undefined) return undefined;
  const active = pi.getActiveTools();
  if (!active.includes(foreign)) return undefined;
  pi.setActiveTools(active.filter((name) => name !== foreign));
  return foreign;
}

/**
 * 注册「未接管的同类壳」门控：confined 档下一律拦下，避免绕过收敛面。
 * 兜底用途：平台态摘表（{@link dropUnconfinableShell}）之后仍可能被别的扩展/配置塞回工具表。
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
    if (mode === "danger-full-access") return; // 用户显式放宽 → 放行（裸跑由用户决策，与壳栈无关）

    return { block: true, reason: foreignShellBlockReason(toolName, confinedShell(), mode) };
  });
}
