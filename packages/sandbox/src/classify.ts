/**
 * pi-sandbox-dsh-sandbox · 结果侧分类包装（沙箱设施失败 vs 策略拒绝）。
 *
 * 单一参考源 = dsh `sandbox/diagnostics.ts` + `shell/bash-sandbox/src/index.ts`：
 * 命令跑完后，用**本后端声明的**事实判定两种失败，二者的处置完全不同：
 * - **runner 失败**（沙箱设施自己没起来/中途死掉）→ 抛 `SANDBOX_UNAVAILABLE`，
 *   绝不把 "命令没跑起来" 误报成 "策略拒绝"，也绝不降级裸跑（fail-closed）。
 * - **denial**（命令跑了、但写被内核拒）→ 在模型可见输出尾部追 denial 标记 + 切档提示。
 *
 * pi 裁剪（DESIGN §七）：分类窗口只保留输出尾部 `MAX_CLASSIFY_BYTES`；denial 只认非零退出；
 * danger 档没有后端事实 → 不做任何判定。本包装在 `operations.exec` 缝上工作
 * （pi 的 `spawnHook` 只改 argv，拿不到退出码与输出）。
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { ConfinedSandboxMode, RunnerFailureRule, SandboxBackendKind, SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import {
  DENIAL_SIGNATURES,
  RUNNER_FAILURE_RULES,
  SANDBOX_UNAVAILABLE,
  classifyDenial,
  classifyRunnerFailure,
  isConfinedMode,
  sandboxDenialMarker,
  sandboxRunnerFailureMessage,
  sandboxWideningHint,
} from "pi-sandbox-dsh-bridge";

/** 一次 confined 执行的结果侧事实（由后端声明）。 */
export interface ConfinedRunFacts {
  /** 本次调用实际生效的 confined 档。 */
  mode: ConfinedSandboxMode;
  /** 本后端的 denial 方言（只用它，不取跨后端并集）。 */
  denialSignatures: readonly string[];
  /** 本后端的 runner 失败规则。 */
  runnerFailureRules: readonly RunnerFailureRule[];
}

/**
 * 分类窗口（字节）：只保留输出尾部这么多用于判定。
 * dsh 自己持有完整 stderr；pi 只给 `onData` 流，故窗口有界（见 DESIGN §七）。
 */
export const MAX_CLASSIFY_BYTES = 64 * 1024;

/** 抛出的 fail-closed 错误带结构化错误码（对齐 dsh `SANDBOX_UNAVAILABLE`）。 */
function runnerFailureError(mode: ConfinedSandboxMode, detail: string): Error {
  const error = new Error(sandboxRunnerFailureMessage(mode, detail));
  (error as { code?: string }).code = SANDBOX_UNAVAILABLE;
  return error;
}

/**
 * 组装某次调用的结果侧事实；`danger-full-access` 无沙箱 → 无事实（不判定）。
 * `resolveFacts(cwd)` 在每次 exec 时求值，故同一条工具定义能跟随全局档位切换。
 * @param ctx - 宿主上下文（只用其 `readState`，不依赖后端模块，避开循环 import）。
 * @param kind - 后端种类（决定用哪套 denial 方言 / runner 失败规则）。
 */
export function resolveRunFacts(
  ctx: { readState: (cwd: string) => SandboxExecutionPolicy },
  kind: SandboxBackendKind,
): (cwd: string) => ConfinedRunFacts | undefined {
  return (cwd) => {
    const mode = ctx.readState(cwd).mode;
    if (!isConfinedMode(mode)) return undefined;
    return {
      mode,
      denialSignatures: DENIAL_SIGNATURES[kind],
      runnerFailureRules: RUNNER_FAILURE_RULES[kind],
    };
  };
}

/**
 * 把一个基础 `BashOperations` 包成"执行后按后端事实分类"的 operations。
 * @param base - 真正执行命令的 operations（pi 的本地 shell，或 winacl 的 runner 驱动）。
 * @param resolveFacts - 按调用时的 cwd 解析后端事实；`danger-full-access` 无事实 → 返回 undefined（不判定）。
 * @returns 供 `BashToolOptions.operations` 使用的包装（不 fork pi 工具）。
 */
export function createConfinedOperations(
  base: BashOperations,
  resolveFacts: (cwd: string) => ConfinedRunFacts | undefined,
): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const facts = resolveFacts(cwd);
      if (facts === undefined) return base.exec(command, cwd, options);

      let tail = "";
      const result = await base.exec(command, cwd, {
        ...options,
        onData: (data) => {
          const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          tail = (tail + text).slice(-MAX_CLASSIFY_BYTES);
          options.onData(data);
        },
      });

      // runner 失败优先于 denial：命令没跑起来，就不该把失败归给策略。
      const runnerFailure = classifyRunnerFailure(result.exitCode, tail, facts.runnerFailureRules);
      if (runnerFailure !== undefined) throw runnerFailureError(facts.mode, runnerFailure);

      if (classifyDenial(result.exitCode, tail, facts.denialSignatures)) {
        options.onData(Buffer.from(`\n${sandboxDenialMarker(facts.mode)}\n${sandboxWideningHint()}\n`));
      }
      return result;
    },
  };
}
