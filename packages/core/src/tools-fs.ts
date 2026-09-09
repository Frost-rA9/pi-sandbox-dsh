/**
 * pi-sandbox-dsh-core · 文件工具（write/edit）写面围栏。
 *
 * 对齐 dsh `fs-sandbox` + `tool-fs`：文件编辑工具在进程内调 fs API（不 spawn 进程），
 * OS 沙箱包不到 → 用进程内 `isPathUnder` 围栏判可写。读不受限。
 *
 * - read-only：禁止一切写。
 * - workspace-write：仅允许目标位于工作区根内。
 * - danger-full-access：放行。
 * 违规 → block + denial 标记 + escalation hint（模型可凭此升级）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import { sandboxDenialMarker, escalationHintMarker } from "pi-sandbox-dsh-bridge";
import { isPathUnder, writableRoots } from "pi-sandbox-dsh-sandbox";
import type { SandboxState } from "./state.ts";

export const FS_TOOLS = ["write", "edit"] as const;

/** 一次文件写意图（write/edit 工具的 model 输入）。 */
export interface FileWriteIntent {
  toolName: string;
  /** 目标路径（write/edit 工具的 `path` 字段）。 */
  target: string | undefined;
}

export type FileWriteDecision = "allow" | "deny";

/** 纯判定：某档位下目标能否写；违规返回 denial reason。 */
export function classifyFileWrite(
  intent: FileWriteIntent,
  policy: SandboxExecutionPolicy,
): { decision: FileWriteDecision; reason?: string } {
  if (policy.mode === "danger-full-access") {
    return { decision: "allow" };
  }
  if (policy.mode === "read-only") {
    return { decision: "deny", reason: sandboxDenialMarker("read-only") };
  }
  // workspace-write：目标必须在可写根（工作区）内
  if (intent.target === undefined) {
    return { decision: "deny", reason: sandboxDenialMarker("workspace-write") };
  }
  const roots = writableRoots(policy);
  const under = roots.some((root) => isPathUnder(intent.target as string, root));
  if (!under) {
    return { decision: "deny", reason: `${sandboxDenialMarker("workspace-write")}（目标不在工作区内: ${intent.target}）` };
  }
  return { decision: "allow" };
}

/** 拼 block reason（denial + 可选 escalation hint）。 */
export function denyReason(decision: { reason?: string }, advertise: boolean): string {
  const base = decision.reason ?? "write denied by sandbox policy";
  return advertise ? `${base}\n${escalationHintMarker("operation")}` : base;
}

/** 注册 write/edit 工具写面门控（tool_call 钩子）。 */
export function registerFileToolGate(pi: ExtensionAPI, state: SandboxState, readState: (cwd: string) => SandboxExecutionPolicy, advertise: () => boolean): void {
  pi.on("tool_call", async (event) => {
    const e = event as { type?: string; toolName?: string; input?: { path?: string } };
    if (e?.type !== "tool_call") return;
    if (!e.toolName || !FS_TOOLS.includes(e.toolName as (typeof FS_TOOLS)[number])) return;
    const decision = classifyFileWrite({ toolName: e.toolName, target: e.input?.path }, readState(process.cwd()));
    if (decision.decision === "deny") {
      return { block: true, reason: denyReason(decision, advertise()) };
    }
    return;
  });
}
