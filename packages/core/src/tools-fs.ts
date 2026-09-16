/**
 * pi-sandbox-dsh-core · 文件工具（write/edit）写面门控（被拒即征求用户批准）。
 *
 * 对齐 dsh `tool-fs` 的"批准升级"语义，但触发点在 `tool_call` 门控（用户决策点），
 * 不 fork pi 的 write/edit 工具。文件工具在进程内调 fs API（不 spawn 进程）→
 * 用 `isPathUnder` 围栏判可写。读不受限。
 *
 * - read-only：禁写；被拒后征求"允许本次"（per-call 升级）。
 * - workspace-write：仅允许目标位于工作区根内；被拒后同样征求。
 * - danger-full-access：放行。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/** 拼 block reason（denial + 可选 escalation hint）。无 OS 后端时标注“这是档位策略拒绝”。 */
export function denyReason(
  decision: { reason?: string },
  advertise: boolean,
  backendUnavailable = false,
): string {
  const base = decision.reason ?? "write denied by sandbox policy";
  const qualified = backendUnavailable
    ? `${base} (policy denial — no OS sandbox backend is available on this host; nothing was kernel-enforced)`
    : base;
  return advertise ? `${qualified}\n${escalationHintMarker("operation")}` : qualified;
}

/**
 * 注册 write/edit 工具写面门控（tool_call 钩子）：被拒即征求用户批准（per-call 升级）。
 * @param backendUnavailable - 后端不可用时，拒绝文案标注“档位策略拒绝”（避免说成内核拒绝）。
 */
export function registerFileToolGate(
  pi: ExtensionAPI,
  _state: SandboxState,
  readState: (cwd: string) => SandboxExecutionPolicy,
  advertise: () => boolean,
  backendUnavailable: () => boolean = () => false,
): void {
  pi.on("tool_call", async (event, ctx) => {
    const e = event as { type?: string; toolName?: string; input?: { path?: string } };
    if (e?.type !== "tool_call") return;
    if (!e.toolName || !FS_TOOLS.includes(e.toolName as (typeof FS_TOOLS)[number])) return;

    const decision = classifyFileWrite({ toolName: e.toolName, target: e.input?.path }, readState(process.cwd()));
    if (decision.decision === "allow") return;

    // 被拒：征求用户批准（用户决策点）；允许本次 → 放行（per-call 更宽）
    if (advertise()) {
      const ui = (ctx as ExtensionContext).ui;
      if (ui?.select) {
        const kind = backendUnavailable() ? "档位策略" : "沙箱";
        const choice = await ui.select(
          `${kind}拒绝写入《${e.input?.path ?? "?"}》（${decision.reason ?? "policy denial"}${backendUnavailable() ? "；本机无 OS 沙箱后端" : ""}）。允许本次吗？`,
          ["允许本次", "拒绝"],
        );
        if (choice === "允许本次") return;
      }
    }
    return { block: true, reason: denyReason(decision, advertise(), backendUnavailable()) };
  });
}
