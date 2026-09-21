/**
 * pi-sandbox-dsh-core · 全局档位状态（日志真源，appendEntry 折叠）。
 *
 * 对齐 dsh `sandbox-policy/session-mode.ts`：全局档只追加一条 `sandbox/mode` 事件，
 * `effective = 折叠态 ?? 部署默认`；存活靠重放，不建内存真源（不变量 6）。
 */
import type { SandboxMode } from "pi-sandbox-dsh-bridge";
import { DEFAULT_SANDBOX_MODE, isSandboxMode } from "pi-sandbox-dsh-bridge";

/** Pi appendEntry 事件条目（简化为我们关心的 shape）。 */
export interface AppendEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

export const SANDBOX_MODE_ENTRY = "sandbox-mode";

/** 纯折叠：从会话日志取最近一条 `sandbox/mode`，无则返回默认。 */
export function foldSandboxMode(entries: readonly AppendEntry[], defaultMode: SandboxMode): SandboxMode {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.customType !== SANDBOX_MODE_ENTRY) continue;
    const mode = (e.data as { mode?: unknown } | undefined)?.mode;
    if (isSandboxMode(mode)) return mode;
  }
  return defaultMode;
}

/** 运行时状态容器（core 内单一实例）。 */
export interface SandboxState {
  /** 部署默认档（fail-safe read-only）。 */
  defaultMode: SandboxMode;
  /** 当前会话生效档（折叠态 ?? 默认）。 */
  mode: SandboxMode;
  /** 当前 cwd（作为 workspace-write 的根）。 */
  workspaceRoot: string;
}

export function initState(defaultMode: SandboxMode, workspaceRoot: string): SandboxState {
  return { defaultMode, mode: defaultMode, workspaceRoot };
}
