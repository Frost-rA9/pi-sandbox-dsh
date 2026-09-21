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
 * 无 OS 沙箱平台上扩展固定运行的档（Windows）。
 * 该平台没有可用的写面沙箱（受限令牌 × Schannel/SSPI 不兼容，替代机制未验证；见 `docs/architecture.md` 已知取舍），
 * 故不宣称受限档、也不允许切换——`/sandbox` 只报告此档。
 */
export const UNSANDBOXED_MODE: SandboxMode = 'danger-full-access'

/** 全部档位（窄→宽，/sandbox 交互选择与错误提示共用单源）。 */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * 严格更宽阶梯：某档位可升级到的更宽档集合。执行时判定，绝不 baked 进 schema。
 * 对齐 dsh `escalation.ts` WIDER_MODES。
 * 同级不在集合内——dsh `ddefc45fbc` 起，同级由调用方按「免批准」处理，不再是错误（见 `assertStrictlyWider`）。
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

/** 目标档是否严格更宽于当前档（不升反降 / 同级 / 非法 → false）。同级为 false 属谓词语义，不等于同级是错误——参考源已改为同级免批准。 */
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

export type SandboxBackendKind = 'bwrap'
export type SandboxShellTool = 'bash'

/** 一次 capability call 的完整写面 policy（含本次调用实际生效的 mode 与根）。 */
export interface SandboxExecutionPolicy {
  mode: SandboxMode
  /** `workspace-write` 可写的绝对根目录。 */
  workspaceRoot: string
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

/**
 * 渲染当前档位给模型看（系统提示段）。对齐 dsh `renderPolicyContext`。
 * 预算：每档 ≤ ~100 tok（`bridge.spec.ts` 按词数钉住），且档位不变时字节不变（保前缀缓存）。
 * 平台分叉：confined 档只存在于 **Linux/WSL2**（bwrap）；Windows 由 core 追加"本平台无沙箱、档位固定"一句。
 */
export function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Confined operations cannot modify files. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write':
      return `Current DSH file policy: workspace-write. Confined operations may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
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
 *
 * **pi 侧当前无消费者，接线前不要使用**：pi 的 bash 无 `sandbox_permissions`/`justification`（pi 裁剪），
 * write/edit 门控的批准是当场布尔「允许本次」——把它挂到任一 pi 路径都会指引模型传一个不存在的参数。
 * 文件工具用 {@link sandboxFileDeniedHint}，壳用 {@link sandboxWideningHint}。
 * 保留本函数作为参考源词表单源（dsh 的 per-call 升级提示）。
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
 * 升级评审前执行校验：目标档必须严格更宽于当前档。非更宽 → 抛错（不弹窗）。
 * 纯函数（不碰审批通道），供 orchestrator 复用。
 *
 * **与参考源的分叉（接线前必须处理）**：dsh `ddefc45fbc`（`61c548e200`）起，`approveEscalation` 对
 * **重复当前生效档**改为「直接返回该档、免批准」，只对更窄/不支持目标失败；本函数仍是旧策略（同级一并抛错）。
 * 当前无运行时调用点（仅 `test/bridge.spec.ts`），故不改行为。若将来接线 per-call 升级：
 * `requestedMode === effectiveMode` → 免批准放行；仅「更窄或非法」才走本函数的失败路径。
 */
export function assertStrictlyWider(request: EscalationRequest): SandboxMode {
  const { requestedMode: mode, effectiveMode } = request
  if (!isStrictlyWider(effectiveMode, mode as SandboxMode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  return mode as SandboxMode
}

/* ------------------------------ 结果侧分类（对齐 dsh `sandbox/diagnostics.ts`） ------------------------------ */

/**
 * 后端声明的一条 runner 失败规则（对齐 dsh `RunnerFailureRule`）。
 * “runner 失败” = 沙箱设施自己没跑起来/中途死掉，**不是**命令被策略拒绝。
 */
export interface RunnerFailureRule {
  /** 仅这些非零退出码可命中本规则；省略 = 任意非零退出。 */
  allowedExitCodes?: readonly number[]
  /** 判定为致命的 stderr 子串（大小写不敏感；空/空白项不算证据）。 */
  fatalSignatures: readonly string[]
  /** 先按**整行精确**（大小写不敏感）排除的信息性行（如 Landlock 老 ABI 的部分强制告警）。 */
  informationalLines?: readonly string[]
}

/**
 * 各后端在写被拒时在 stderr 产生的（大小写不敏感）子串。
 * 消费方只用**本后端**的方言判定，不取跨后端并集（并集会声称某后端从不产生的 denial）。
 */
export const DENIAL_SIGNATURES: Record<SandboxBackendKind, readonly string[]> = {
  // bwrap 只读 bind 上的 EROFS 文本。
  bwrap: ['read-only file system'],
}

/** 各后端的 runner 失败规则（对齐 dsh `RUNNER_FAILURE_RULES`）。 */
export const RUNNER_FAILURE_RULES: Record<SandboxBackendKind, readonly RunnerFailureRule[]> = {
  // bwrap 自身诊断均以 `bwrap: ` 开头（含 PATH 缺失时的 `sh: 1: bwrap: not found`）。
  bwrap: [{ fatalSignatures: ['bwrap: '] }],
}

/**
 * 非零退出且输出命中任一签名（大小写不敏感）→ true。
 * `exitCode === null`（signal 死亡）不算——被信号杀掉不是 denial。
 * 对齐 dsh `matchesSignature`。
 */
export function matchesSignature(exitCode: number | null, output: string, signatures: readonly string[]): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lowered = output.toLowerCase()
  return signatures.some((sig) => lowered.includes(sig.toLowerCase()))
}

/** 写被拒探测：非零退出 + 本后端 denial 方言。对齐 dsh `classifyDenial`。 */
export function classifyDenial(exitCode: number | null, output: string, signatures: readonly string[]): boolean {
  return matchesSignature(exitCode, output, signatures)
}

/**
 * 按后端规则判定 runner 自身失败。
 * 每条规则需：非零退出（且命中 `allowedExitCodes`，若有）+ 排除信息性整行后命中一条致命子串。
 * @returns 命中的原始 fatal 行（给基础设施错误做 detail），未命中返回 undefined。
 * 对齐 dsh `classifyRunnerFailure`。
 */
export function classifyRunnerFailure(
  exitCode: number | null,
  output: string,
  rules: readonly RunnerFailureRule[],
): string | undefined {
  if (exitCode === null || exitCode === 0) return undefined
  const lines = output.split(/\r?\n/)
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informational = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()))
    const fatal = rule.fatalSignatures.filter((sig) => sig.trim().length > 0).map((sig) => sig.toLowerCase())
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (informational.has(lowered)) continue
      if (fatal.some((sig) => lowered.includes(sig))) return line
    }
  }
  return undefined
}

/* ------------------------------ fail-closed 文案 ------------------------------ */

/** confined 档请求但无可用后端时的错误码（对齐 dsh SANDBOX_UNAVAILABLE）。 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/**
 * runner 自身失败时的 fail-closed 文案：明确“这不是策略拒绝”且“不降级裸跑”。
 * 对齐 dsh `SandboxUnavailableError` 的“refusing to run unconfined”立场。
 * @param mode - 失败时实际生效的 confined 档。
 * @param detail - 命中的 fatal 原始行（可选）。
 */
export function sandboxRunnerFailureMessage(mode: SandboxMode, detail?: string): string {
  return `sandbox runner failed under "${mode}" mode — this is not a policy denial and the command did not run confined; refusing to retry it unconfined. Repair the sandbox backend or ask the user to switch mode explicitly.`
    + (detail === undefined ? '' : ` Runner failure: ${detail}`)
}

/**
 * bash 的切档提示（pi 裁剪）：pi 的 bash schema 无 `sandbox_permissions`/`justification`，
 * bash 升级恒为全局 `/sandbox`（见 `docs/architecture.md` 不变量 5）——故提示指向用户决策点。
 */
export function sandboxWideningHint(): string {
  return '[sandbox: if this write is required, ask the user to widen the mode (/sandbox <wider mode>) — this shell tool has no per-call escalation parameters]'
}

/**
 * 文件工具（write/edit）被拒且未获「允许本次」时的提示。
 *
 * pi 裁剪：write/edit 无 per-call 升级参数；批准由 `tool_call` 门控**当场**征求（布尔「允许本次」），
 * 不改档位、也不经模型参数。故被拒后模型只能请用户切档（全局 `/sandbox`），不能带参数重试——
 * 这里绝不能改用 {@link escalationHintMarker}（那会指引模型传不存在的 `sandbox_permissions`）。
 */
export function sandboxFileDeniedHint(): string {
  return '[sandbox: this write was denied and no one-off approval was granted — ask the user to widen the mode (/sandbox <wider mode>); the write/edit tools take no per-call escalation parameters]'
}

/* ------------------------------ 后端信息 ------------------------------ */

/** 后端信息：种类 + 可用性 + 沙箱 shell + 探测失败原因。 */
export interface SandboxBackendInfo {
  kind: SandboxBackendKind
  available: boolean
  shellTool: SandboxShellTool
  /** 探测失败的用户可见原因（fail-closed 通知用；成功时可省略）。 */
  detail?: string
}
