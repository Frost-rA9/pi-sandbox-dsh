/**
 * pi-sandbox-dsh-sandbox · 后端抽象 + 选择器。
 *
 * 对齐 dsh `sandbox-local`：按平台选后端（linux→bwrap；win32→winacl）。后端 = 库，
 * 被 core import（pi `BashSpawnHook` 同步约束 → 沙箱不能做成独立扩展）。
 */
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import type { SandboxBackendInfo, SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import { buildBwrapCommand, probeBwrap } from "./bwrap.ts";

/** 后端构建时的宿主上下文（core 组装，随扩展开销一次）。 */
export interface BackendContext {
  workspaceRoot: string;
  readState: (cwd: string) => SandboxExecutionPolicy;
}

export interface SandboxBackend {
  readonly info: SandboxBackendInfo;
  probe(): boolean;
  createToolOptions(ctx: BackendContext): BashToolOptions;
}

class BwrapBackend implements SandboxBackend {
  readonly info: SandboxBackendInfo = { kind: "bwrap", available: false, shellTool: "bash" };

  probe(): boolean {
    this.info.available = probeBwrap();
    return this.info.available;
  }

  createToolOptions(ctx: BackendContext): BashToolOptions {
    return {
      spawnHook: ({ command, cwd }) => {
        const policy = ctx.readState(cwd);
        if (policy.mode === "danger-full-access") {
          return { command, cwd, env: {} };
        }
        const wrapped = buildBwrapCommand(command, policy);
        return { command: wrapped, cwd, env: {} };
      },
    };
  }
}

export function selectBackend(platform: string = process.platform): SandboxBackend {
  if (platform === "win32") {
    // winacl 后端后续接入（受限令牌 + NTFS ACE + Node runner）。
    throw new Error("pi-sandbox-dsh: winacl 后端尚未接入（Windows）；本版仅 bwrap（Linux/WSL2）");
  }
  return new BwrapBackend();
}

export function createBwrapBackend(): SandboxBackend {
  return new BwrapBackend();
}
