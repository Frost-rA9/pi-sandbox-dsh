/**
 * pi-sandbox-dsh-bridge · 共享契约 + 纯函数。
 *
 * 单一参考源 = dsh。这里是"连续 agent + 全局沙箱档 + 逐级批准"的**核心词表**：
 * 档位阶梯、严格更宽、per-call policy 解析、denial/hint 标记、fail-closed 词汇。
 * 全部为纯函数（无副作用），供 core（宿主）与 sandbox（后端）共享。
 *
 * 对齐 dsh：`sandbox/src/index.ts` + `sandbox/escalation.ts` + `sandbox-policy/src/index.ts`，
 * 但按 pi 哲学裁剪（核心小、最小暴露面、读全开、网络不掺和、无 plan/verify 档）。
 */

/* ------------------------------ 档位阶梯（SandboxMode） ------------------------------ */

/** 全局档位：写面边界策略。dsh 三档，语义一致。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 会被 OS 沙箱限住的档（exclude danger-flight-full-access）。 */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

/** 档位是否属于会被沙箱限住的 confined 档。 */
export function isConfinedMode(mode: SandboxMode): mode is ConfinedSandboxMode {
  return mode === 'read-only' || mode === 'workspace-write'
}

/** 默认档（fail-safe）：dsh 部署默认即 read-only。 */
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'read-only'

/**
 * 严格更宽阶梯：某档位可升级到的更宽档集合。执行时判定，绝不 baked 进 schema。
 * 对齐 dsh `escalation.ts` WIDER_MODES。
 */
export const WIDER_MODES: Record<SandboxMode, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': [],
}

/**
 * 闭合的升级目标词表——为模型 schema 广告的最小集合：只列出比默认档更宽的档。
 * 对齐 dsh `ESCALATION_TARGETS`。
 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

/** 目标档是否严格更宽于当前档（不升反降 / 同级 / 非法 → false）。 */
export function isStrictlyWider(effectiveMode: SandboxMode, targetMode: SandboxMode): boolean {
  return (WIDER_MODES[effectiveMode] ?? []).includes(targetMode)
}

/** 每档位的模型可读描述（/sandbox 目录 + 系统提示共用单源）。 */
export const SANDBOX_MODE_DESCRIPTIONS: Record<SandboxMode, string> = {
  'read-only': '只读：读全开，禁止写（仅必要 sink）',
  'workspace-write': '工作区可写：只允许在工作区（+ 临时区）内写，其余只读',
  'danger-full-access': '全权：绕过沙箱（需批准）',
}

/** 是否为 dsh 档位词表内的合法值。 */
export function isSandboxMode(v: unknown): v is SandboxMode {
  return v === 'read-only' || v === 'workspace-write' || v === 'danger-full-access'
}

/* ------------------------------ SandboxExecutionPolicy ------------------------------ */

export type SandboxBackendKind = 'bwrap' | 'winacl'
export type SandboxShellTool = 'bash' | 'powershell'

/** 一次 capability call 的完整写面 policy（含本次调用实际生效的 mode 与根）。 */
export interface SandboxExecutionPolicy {
  mode: SandboxMode
  /** `workspace-write` 可写的绝对根目录。 */
  workspaceRoot: string
  /** 会话身份（后端按会话键临时状态，如 winacl 的随机 temp 目录）。 */
  sessionId?: string
}

/** policy 解析输入（对齐 dsh `SandboxPolicyRequest`）。 */
export interface SandboxPolicyRequest {
  /** 会话最近一次 `sandbox/mode` 覆盖，无则 undefined。 */
  sessionOverride?: SandboxMode
  /** 本次调用显式批准的 mode（升级结果），最高优先级。 */
  approvedMode?: SandboxMode
  /** 部署默认档（fallback）。 */
  defaultMode: SandboxMode
  /** 会话 cwd（作为 workspace-write 的根）。 */
  sessionCwd?: string
  /** 无会话时的 fallback 根。 */
  fallbackRoot?: string
}

/**
 * 解析一次调用的完整 policy：approvedMode > sessionOverride > defaultMode；
 * workspaceRoot = sessionCwd > fallbackRoot。
 * 对齐 dsh `sandbox-policy` `resolve()`。
 */
export function resolveSandboxPolicy(req: SandboxPolicyRequest): SandboxExecutionPolicy {
  const mode = req.approvedMode ?? req.sessionOverride ?? req.defaultMode
  return {
    mode,
    workspaceRoot: req.sessionCwd ?? req.fallbackRoot ?? process.cwd(),
  }
}

/** 渲染当前档位给模型看（系统提示段）。对齐 dsh `renderPolicyContext`。 */
export function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write':
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

/* ------------------------------ 升级 / 拒绝（escalation vocabulary） ------------------------------ */

/**
 * 模型侧 denial 标记——无论 bash 还是文件系统被内核拒绝，模型看到同一标记。
 * 对齐 dsh `sandboxDenialMarker`。
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/**
 * 同一回合升级提示，跟在 denial 后（当组合广告了升级字段时）。
 * 对齐 dsh `escalationHintMarker`。
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/**
 * 升级参数配对校验：`sandbox_permissions` 与 `justification` 必须同带，且 justification 非空句。
 * 对齐 dsh `validateEscalationArgs`。
 */
export function validateEscalationArgs(sandboxPermissions: string | undefined, justification: string | undefined): void {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

/** 升级结果词表（对齐 dsh `EscalationOutcome`）。 */
export type EscalationOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 一次升级评审的输入。 */
export interface EscalationRequest {
  /** 模型请求的目标档（schema-pinned 到 ESCALATION_TARGETS）。 */
  requestedMode: string
  /** 模型的一句理由（原样展示给用户）。 */
  justification: string
  /** 本次调用实际生效的档。 */
  effectiveMode: SandboxMode
  /** 被升级动作的用户面名词（bash = 'command'）。 */
  subject: string
}

/**
 * 升级评审前执行校验：目标档必须严格更宽于当前档。非更宽 → 拒绝（不弹窗）。
 * 纯函数（不碰审批通道），供 orchestrator 复用。
 */
export function assertStrictlyWider(request: EscalationRequest): SandboxMode {
  const { requestedMode: mode, effectiveMode } = request
  if (!isStrictlyWider(effectiveMode, mode as SandboxMode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  return mode as SandboxMode
}

/* ------------------------------ 后端 denial 方言 ------------------------------ */

/** 各后端在写被拒时在 stderr 产生的（大小写不敏感）子串；消费方据此探测 denial。 */
export const DENIAL_SIGNATURES: Record<SandboxBackendKind, readonly string[]> = {
  bwrap: ['read-only file system'],
  winacl: ['access is denied', 'access to the path', 'permission denied'],
}

/** 探测一次执行结果（合并 stdout/stderr 文本）是否命中某后端的 denial 方言。 */
export function looksLikeDenial(backend: SandboxBackendKind, output: string): boolean {
  const lowered = output.toLowerCase()
  return DENIAL_SIGNATURES[backend].some((sig) => lowered.includes(sig.toLowerCase()))
}

/* ------------------------------ fail-closed ------------------------------ */

/** confined 档请求但无可用后端时的错误码（对齐 dsh SANDBOX_UNAVAILABLE）。 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/** 后端信息：种类 + 可用性 + 沙箱 shell。 */
export interface SandboxBackendInfo {
  kind: SandboxBackendKind
  available: boolean
  shellTool: SandboxShellTool
}
