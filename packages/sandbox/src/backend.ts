/**
 * pi-sandbox-dsh-sandbox · 后端抽象 + 选择器。
 *
 * 对齐 dsh `sandbox-local`：按平台选后端（linux→bwrap；win32→winacl）。后端 = 库，
 * 被 core import（pi `BashSpawnHook` 同步约束 → 沙箱不能做成独立扩展）。
 */
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import type { SandboxBackendInfo, SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import { buildBwrapCommand, probeBwrap } from "./bwrap.ts";
import { createWinaclBackend } from "./winacl.ts";

/**
 * 传给沙箱子进程的非机密环境变量白名单。
 * 既让工具运行（PATH/HOME/代理）恢复正常，又不泄漏 TOKEN/密钥类变量。
 * 对齐设计不变量：凭据靠“写面 + 网络出口”约束，而非靠藏环境；但也不把机密环境变量暴露给模型 shell。
 */
const SANDBOX_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERM',
  'http_proxy', 'https_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
] as const;

/** 从 process.env 提取白名单内的非机密变量（工具运行必需，不含密钥）。 */
function sandboxEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = process.env[key];
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
  readonly kind: "bwrap" | "winacl";
  readonly shellTool: "bash" | "powershell";
  probe(): boolean;
  createToolOptions(ctx: BackendContext): BashToolOptions;
}

class BwrapBackend implements SandboxBackend {
  readonly kind = "bwrap" as const;
  readonly shellTool = "bash" as const;
  readonly info: SandboxBackendInfo = { kind: "bwrap", available: false, shellTool: "bash" };

  probe(): boolean {
    this.info.available = probeBwrap();
    return this.info.available;
  }

  createToolOptions(ctx: BackendContext): BashToolOptions {
    return {
      spawnHook: ({ command, cwd }) => {
        const policy = ctx.readState(cwd);
        const env = sandboxEnv(); // 保留 PATH/HOME/代理等，工具可用且不泄漏密钥
        if (policy.mode === "danger-full-access") {
          return { command, cwd, env };
        }
        const wrapped = buildBwrapCommand(command, policy);
        return { command: wrapped, cwd, env };
      },
    };
  }
}

export function selectBackend(platform: string = process.platform): SandboxBackend {
  if (platform === "win32") {
    return createWinaclBackend();
  }
  return new BwrapBackend();
}

export function createBwrapBackend(): SandboxBackend {
  return new BwrapBackend();
}
