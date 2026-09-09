/**
 * pi-sandbox-dsh-sandbox · winacl 后端（Windows 受限令牌 + NTFS ACE）。
 *
 * 单一源 = dsh `sandbox-local` + `sandbox-windows-acl`：win32 用 WRITE_RESTRICTED 令牌 +
 * NTFS ACE 写白名单，shell=pwsh（受限令牌 × git-bash 不兼容）。
 * 因为 koffi 不能加载进 Bun 宿主 → 令牌/ACE 逻辑在独立 Node runner 子进程执行；本文件只
 * 通过 argv 契约驱动它（对齐 dsh"OS 沙箱 = 子进程"模式）。
 *
 * ⚠️ Windows-only：令牌/ACE/FFI（`./win32/runner.ts` + token/acl/ffi）在本机（Linux）无法运行
 * 验证，须在 Windows 真机 `probe`。本文件提供**可测的结构**（probe / runner argv / 分支）。
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import type { SandboxBackendInfo } from "pi-sandbox-dsh-bridge";
import type { SandboxBackend, BackendContext } from "./backend.ts";
import { buildWinaclRunnerArgv, winaclUsable } from "./win32/index.ts";

const WINACL_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = resolve(WINACL_DIR, "win32", "runner.ts");

/** probe（同步）：非 win32 或 runner `--probe` 非零 → 不可用（fail-closed）。 */
function runProbe(): boolean {
  if (!winaclUsable()) return false;
  try {
    const r = spawnSync("node", ["--experimental-strip-types", RUNNER_PATH, "--probe"], { timeout: 60_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

class WinaclBackend implements SandboxBackend {
  readonly kind = "winacl" as const;
  readonly shellTool = "powershell" as const;
  info: SandboxBackendInfo = { kind: "winacl", available: false, shellTool: "powershell" };

  probe(): boolean {
    this.info.available = runProbe();
    return this.info.available;
  }

  createToolOptions(ctx: BackendContext): BashToolOptions {
    // winacl：用 createPowerShellTool + operations.exec，把命令交给 Node runner（受限令牌执行）。
    return {
      operations: {
        exec: async (command, cwd) => {
          if (!winaclUsable()) {
            throw new Error(`sandbox mode "${ctx.readState(cwd).mode}" is requested but winacl backend is unusable on this host; refusing to run unconfined`);
          }
          // 构造 runner 调用（Windows-only 真机执行）；本机仅结构校验。
          const mode = ctx.readState(cwd).mode;
          const wrapped = buildWinaclRunnerArgv({
            workspace: ctx.workspaceRoot,
            temp: process.env.TEMP ?? process.env.TMP ?? "",
            mode: mode === "workspace-write" ? "workspace-write" : "read-only",
            runnerEntry: RUNNER_PATH,
          });
          return invokeRunner(wrapped, command, cwd);
        },
      },
    };
  }
}

/** 实际调用 runner（Windows-only）：本机为占位，Windows 上经 node runner spawn 子进程。 */
async function invokeRunner(argv: string[], command: string, cwd: string): Promise<{ exitCode: number | null }> {
  // TODO(win32): 经 runner 子进程执行受限令牌命令（需 Windows 真机验证）。
  throw new Error(`winacl runner not yet wired for local execution (Windows-only): ${argv.join(" ")}; command=${command}; cwd=${cwd}`);
}

export function createWinaclBackend(): SandboxBackend {
  return new WinaclBackend();
}
