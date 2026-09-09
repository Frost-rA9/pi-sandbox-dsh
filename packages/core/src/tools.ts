/**
 * pi-sandbox-dsh-core · bash 工具再注册：追加升级字段 + 覆写 execute（升级→批准；denial→标记）。
 *
 * 对齐 dsh `tool-bash` + `bash-sandbox`：写被拒后模型带 `sandbox_permissions + justification`
 * 重试 → 严格更宽校验 → `ctx.ui.select` 批准 → 仅本次以更宽档执行；结果命中 denial 方言 →
 * 追加 `[sandbox: file access denied under X mode]` + escalation hint。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { SandboxExecutionPolicy, SandboxMode } from "pi-sandbox-dsh-bridge";
import {
  ESCALATION_TARGETS,
  WIDER_MODES,
  looksLikeDenial,
  sandboxDenialMarker,
  escalationHintMarker,
  validateEscalationArgs,
  assertStrictlyWider,
} from "pi-sandbox-dsh-bridge";
import type { SandboxBackend } from "pi-sandbox-dsh-sandbox";
import type { SandboxState } from "./state.ts";

type UiSelect = (title: string, options: string[]) => Promise<string | undefined>;

/** 把结果 content 拼成单一文本（用于 denial 方言探测）。 */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("\n");
}

/** 追加 `[sandbox: …]` 标记（denial + 可选 escalation hint）到结果 content 末尾。 */
export function appendSandboxMarkers(result: AgentToolResultShape, mode: SandboxMode, advertise: boolean): AgentToolResultShape {
  const markers = [sandboxDenialMarker(mode)];
  if (advertise) markers.push(escalationHintMarker("command"));
  return { ...result, content: [...(result.content ?? []), { type: "text", text: markers.join("\n") }] };
}

/** AgentToolResult 的宽松形状（pi 返回 content[] 数组）。 */
export interface AgentToolResultShape {
  content?: { type: string; text: string }[];
  details?: unknown;
}

/* ------------------------------ 纯逻辑（可测） ------------------------------ */

/** 探测一次 bash 结果是否命中当前后端 denial 方言。 */
export function detectDenial(result: AgentToolResultShape, backend: "bwrap" | "winacl"): boolean {
  return looksLikeDenial(backend, resultText(result.content));
}

/** 是否广告升级字段（沙箱后端可用 + 当前档不是 danger）。 */
export function shouldAdvertiseEscalation(state: Pick<SandboxState, "mode">): boolean {
  return state.mode !== "danger-full-access";
}

/** 当前档可升级的目标集合（严格更宽，按 WIDER_MODES[mode]）。 */
export function escalationTargets(mode: SandboxMode): readonly SandboxMode[] {
  return WIDER_MODES[mode];
}

/** 生成 bash 工具描述（含升级指引，对齐 dsh `bashDescription` 的 escalation 段）。 */
export function bashDescription(advertise: boolean): string {
  const base =
    "Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell. " +
    "Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a command bug; do not retry another way. ";
  if (!advertise) return base;
  return (
    base +
    "When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. The approval prompt raised by that retry is how the user consents. Never escalate speculatively; a rejected escalation is final for that command."
  );
}

/* ------------------------------ orchestration ------------------------------ */

/**
 * 处理一次升级：校验、走 ui.select 批准，返回批准目标档（allowed-once），否则抛错。
 * 对齐 dsh `approveEscalation`（approver → ctx.ui.select）。
 */
export async function approveEscalation(
  requestedMode: string,
  justification: string,
  effectiveMode: SandboxMode,
  subject: string,
  uiSelect: UiSelect,
): Promise<SandboxMode> {
  const mode = assertStrictlyWider({ requestedMode, justification, effectiveMode, subject });
  const choice = await uiSelect(
    `escalate sandbox to ${mode}: ${justification}（允许一次？）`,
    ["允许一次", "拒绝"],
  );
  if (!choice || choice !== "允许一次") {
    throw new Error(`the user rejected escalating this ${subject} to "${mode}"`);
  }
  return mode;
}

export interface RegisterToolArgs {
  pi: ExtensionAPI;
  state: SandboxState;
  backend: SandboxBackend;
  workspaceRoot: string;
  readState: (cwd: string) => SandboxExecutionPolicy;
  getEntries: () => readonly unknown[];
  getSessionId: () => string | undefined;
}

/** 复用 pi 的 bash 工具：扩展 parameters + 覆写 execute（升级→ctx.ui.select 批准；denial→标记）。 */
export function registerBashTool(args: RegisterToolArgs, baseTool: { execute: (...a: unknown[]) => Promise<unknown>; parameters?: TSchema; name?: string; description?: string }): void {
  const { pi, state, backend } = args;
  const advertise = shouldAdvertiseEscalation(state);

  // 描述：基础 + 升级指引
  const description = bashDescription(advertise);

  pi.registerTool({
    ...(baseTool as object),
    name: (baseTool as { name?: string }).name ?? "bash",
    label: (baseTool as { label?: string; name?: string }).label ?? "bash",
    description,
    parameters: baseTool.parameters as TSchema,
    execute: async (id, params, signal, onUpdate, ctx) => {
      const p = params as { command?: string; sandbox_permissions?: string; justification?: string } & Record<string, unknown>;
      validateEscalationArgs(p.sandbox_permissions, p.justification);
      const policy = args.readState(process.cwd());

      let mode: SandboxMode = policy.mode;
      if (p.sandbox_permissions !== undefined && p.justification !== undefined) {
        // 使用 pi 工具执行上下文的 ui.select 作为批准通道
        const ui = (ctx as { ui?: { select: UiSelect } }).ui;
        if (!ui) {
          throw new Error("sandbox escalation requires an interactive approval channel");
        }
        mode = await approveEscalation(p.sandbox_permissions, p.justification, policy.mode, "command", (msg, opts) => ui.select(msg, opts));
      }

      // 以批准后的档位运行（本次调用）；后端 spawnHook 用 readState 读到的 mode 已含批准
      const result = (await (baseTool.execute as (...a: unknown[]) => Promise<unknown>)(id, params, signal, onUpdate)) as AgentToolResultShape | string;
      const resultObj: AgentToolResultShape = typeof result === "string" ? { content: [{ type: "text", text: result }] } : result;
      if (mode !== "danger-full-access" && detectDenial(resultObj, backend.info.kind)) {
        return appendSandboxMarkers(resultObj, mode, advertise) as never;
      }
      return resultObj as never;
    },
  });
}
