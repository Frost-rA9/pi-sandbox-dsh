/**
 * pi-sandbox-dsh-sandbox · 后端抽象 + 选择器。
 *
 * 对齐 dsh `sandbox-local`：按平台选后端。**只有 Linux/WSL2 有后端（bwrap）**；
 * Windows 无可用写面沙箱（受限令牌 × Schannel/SSPI 不兼容，替代机制未验证）→ `selectBackend` 返回 undefined，
 * 由 core 固定为 `danger-full-access`（见 `docs/architecture.md`）。后端 = 库，被 core import
 * （pi `BashSpawnHook` 同步约束 → 沙箱不能做成独立扩展）。
 */
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { RunnerFailureRule, SandboxBackendInfo, SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import { RUNNER_FAILURE_RULES } from "pi-sandbox-dsh-bridge";
import { createConfinedOperations, resolveRunFacts } from "./classify.ts";
import { buildBwrapCommand, probeBwrap } from "./bwrap.ts";

/**
 * 传给沙箱子进程的非机密环境变量白名单。
 * 既让工具运行（PATH/HOME/代理）恢复正常，又不泄漏 TOKEN/密钥类变量。
 * `PI_*` 是 pi 的**会话元数据**（非机密）：pi 在 `spawnHook` 之前注入到入参 `env`
 * （`exposeSessionEnvironment`，默认开）——`process.env` 里没有它们，故必须从入参 `env` 读。
 * 对齐设计不变量：凭据靠“写面 + 网络出口”约束，而非靠藏环境；但也不把机密环境变量暴露给模型 shell。
 */
const SANDBOX_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERM',
  'http_proxy', 'https_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  // pi 会话元数据（非机密；由 pi 注入到 spawnHook 入参 env，不在 process.env 里）。
  'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL',
] as const;

/** 从 `source`（默认 process.env；spawnHook 传 pi 注入后的 env）提取白名单内的非机密变量。 */
function sandboxEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 后端构建时的宿主上下文（core 组装，随扩展开销一次）。 */
export interface BackendContext {
  workspaceRoot: string;
  readState: (cwd: string) => SandboxExecutionPolicy;
}

export interface SandboxBackend {
  readonly info: SandboxBackendInfo;
  readonly kind: "bwrap";
  readonly shellTool: "bash";
  /** 本后端的 runner 失败规则（结果侧分类用；danger 档不适用）。 */
  readonly runnerFailureRules: readonly RunnerFailureRule[];
  probe(): boolean;
  createToolOptions(ctx: BackendContext): BashToolOptions;
}

class BwrapBackend implements SandboxBackend {
  readonly kind = "bwrap" as const;
  readonly shellTool = "bash" as const;
  readonly runnerFailureRules = RUNNER_FAILURE_RULES.bwrap;
  readonly info: SandboxBackendInfo = { kind: "bwrap", available: false, shellTool: "bash" };

  probe(): boolean {
    this.info.available = probeBwrap();
    if (!this.info.available) {
      this.info.detail = "bwrap is not usable on this host (bwrap --version failed — install bubblewrap or fix PATH)";
    }
    return this.info.available;
  }

  createToolOptions(ctx: BackendContext): BashToolOptions {
    return {
      // argv 收敛：把命令包成 `bwrap … sh -c '<cmd>'`（由 pi 在 exec 前应用）。
      spawnHook: ({ command, cwd, env }) => {
        const policy = ctx.readState(cwd);
        // 从 pi 注入后的入参 env 过滤（保留 PATH/HOME/代理/PI_*，不泄漏密钥）。
        const filtered = sandboxEnv(env);
        if (policy.mode === "danger-full-access") {
          return { command, cwd, env: filtered };
        }
        const wrapped = buildBwrapCommand(command, policy);
        return { command: wrapped, cwd, env: filtered };
      },
      // 结果侧分类：runner 失败 → fail-closed；denial → 追模型可见标记。
      operations: createConfinedOperations(createLocalBashOperations(), resolveRunFacts(ctx, "bwrap")),
    };
  }
}

/**
 * 按平台选后端。Windows 无可用写面沙箱 → undefined（**无后端 ≠ 后端不可用**：
 * core 据此固定 `danger-full-access`，而不是 fail-closed 拒绝）。
 */
export function selectBackend(platform: string = process.platform): SandboxBackend | undefined {
  if (platform === "win32") return undefined;
  return new BwrapBackend();
}

export function createBwrapBackend(): SandboxBackend {
  return new BwrapBackend();
}
