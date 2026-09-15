/**
 * pi-sandbox-dsh-sandbox · winacl 后端（Windows 受限令牌 + NTFS ACE）。
 *
 * 单一源 = dsh `sandbox-local` + `sandbox-windows-acl`：win32 用 WRITE_RESTRICTED 令牌 +
 * NTFS ACE 写白名单，shell=pwsh（受限令牌 × git-bash 不兼容）。
 * 因为 koffi 不能加载进 Bun 宿主 → 令牌/ACE 逻辑在独立 Node runner 子进程执行；本文件只
 * 通过 argv 契约驱动它（对齐 dsh「OS 沙箱 = 子进程」模式）。
 *
 * 宿主侧职责（全部无原生依赖）：
 * 1. `probe()`：同步 spawn `node runner.ts --probe`，非零 → 后端不可用（fail-closed）。
 * 2. `exec`：把 pwsh argv 交给 runner（`--` 之后），管道转发 stdout/stderr，透传退出码。
 *    runner 自行物化/撤销 grant（pi 宿主不能加载 koffi，见 `win32/runner.ts`）。
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BashOperations, BashToolOptions } from "@earendil-works/pi-coding-agent";
import { createLocalPowerShellOperations, getPowerShellConfig } from "@earendil-works/pi-coding-agent";
import type { RunnerFailureRule, SandboxBackendInfo } from "pi-sandbox-dsh-bridge";
import { RUNNER_FAILURE_RULES, SANDBOX_UNAVAILABLE } from "pi-sandbox-dsh-bridge";
import type { SandboxBackend, BackendContext } from "./backend.ts";
import { createConfinedOperations, resolveRunFacts } from "./classify.ts";
import { resolveNodeRuntime } from "./node-runtime.ts";
import { buildWinaclRunnerArgv, winaclUsable } from "./win32/runner-contract.ts";

const WINACL_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = resolve(WINACL_DIR, "win32", "runner.ts");

/**
 * pi 内置 powershell 工具给每条命令加的输出编码前缀（对齐 pi `UTF8_OUTPUT_PREFIX`）：
 * 换掉 operations 就换掉了这一层，必须自行补上，否则中文输出会按控制台代码页编码。
 */
const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/** runner 真机执行需要系统 Node（Bun 宿主不能加载 koffi）；Node 22+ 原生剥离 TS 类型。 */
const RUNNER_NODE_FLAGS = ["--experimental-strip-types"] as const;

/** danger 档（本后端不参与）时的回落执行器：pi 本地 pwsh。 */
const localPowerShellOperations: BashOperations = createLocalPowerShellOperations();

/**
 * probe（同步）：非 win32 / 无可用 Node / runner `--probe` 非零 → 不可用（fail-closed）。
 * 失败原因写进 `info.detail`（宿主拿它做用户可见通知——切勿再写死某个后端的原因）。
 */
function runProbe(): { available: boolean; detail?: string } {
  if (!winaclUsable()) {
    return { available: false, detail: `the winacl backend is Windows-only (host platform: ${process.platform})` };
  }
  const node = resolveNodeRuntime();
  if (!("command" in node)) return { available: false, detail: node.detail };
  let result;
  try {
    result = spawnSync(node.command, [...RUNNER_NODE_FLAGS, RUNNER_PATH, "--probe"], { timeout: 60_000, encoding: "utf8" });
  } catch (error) {
    return { available: false, detail: `could not spawn the winacl runner probe: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (result.status === 0) return { available: true };
  const stderrTail = typeof result.stderr === "string" ? result.stderr.trim().split(/\r?\n/u).slice(-3).join(" | ") : "";
  const cause = result.error !== undefined && result.error !== null
    ? result.error.message
    : `exit ${String(result.status ?? "null")}`;
  return {
    available: false,
    detail: `the winacl runner probe failed via ${node.source} node (${cause})${stderrTail === "" ? "" : `: ${stderrTail}`}`,
  };
}

/** 构造 runner 失败错误（带 `SANDBOX_UNAVAILABLE` 错误码，fail-closed 且不裸跑重试）。 */
function runnerUnavailable(detail: string): Error {
  const error = new Error(
    `windows-acl runner could not run the command under the restricted token: ${detail}. `
    + "The command did not run confined; refusing to retry it unconfined.",
  );
  (error as { code?: string }).code = SANDBOX_UNAVAILABLE;
  return error;
}

/** 一次 confined 执行的流式回调（与 pi `BashOperations.exec` 的 options 对齐）。 */
interface RunOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * 把一次命令交给 winacl runner：`node runner.ts <argv> -- <pwsh argv>`。
 *
 * - stdout/stderr 管道直通 → `options.onData`（denial 判定依赖它）。
 * - 超时/abort：杀掉 runner；受限子进程挂在 runner 的 kill-on-close Job 上，随之终止。
 * - 退出码：全宽透传（runner 已按 dsh 契约镜像子进程退出码）。
 * @param argv - `buildWinaclRunnerArgv` 产出的 argv（`[node, runnerEntry, ...]`）。
 * @param command - 模型给的 PowerShell 命令原文。
 * @param cwd - 工作目录（子进程 cwd）。
 * @param options - pi 的流式回调/超时/中止信号。
 * @returns `{ exitCode }`（null = 被信号杀死）。
 */
function invokeRunner(
  argv: readonly string[],
  command: string,
  cwd: string,
  options: RunOptions,
): Promise<{ exitCode: number | null }> {
  const [, runnerEntry, ...runnerArgs] = argv;
  if (runnerEntry === undefined) throw runnerUnavailable("empty runner argv");

  // pwsh 解析失败（未安装）必须是 runner 失败，而不是伪装成命令失败。
  let shellCommand: string[];
  try {
    const shell = getPowerShellConfig();
    shellCommand = [shell.shell, ...shell.args, UTF8_OUTPUT_PREFIX + command];
  } catch (error) {
    throw runnerUnavailable(error instanceof Error ? error.message : String(error));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const node = resolveNodeRuntime();
    if (!("command" in node)) {
      rejectPromise(runnerUnavailable(node.detail));
      return;
    }
    const child = spawn(node.command, [...RUNNER_NODE_FLAGS, runnerEntry, ...runnerArgs, "--", ...shellCommand], {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timeoutMs = options.timeout === undefined ? undefined : options.timeout * 1000;
    let timedOut = false;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const killTree = (): void => {
      child.kill();
    };
    const onAbort = (): void => {
      killTree();
    };

    const cleanup = (): void => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(runnerUnavailable(error.message));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.signal?.aborted === true) {
        rejectPromise(new Error("aborted"));
        return;
      }
      if (timedOut) {
        rejectPromise(new Error(`timeout:${options.timeout ?? 0}`));
        return;
      }
      resolvePromise({ exitCode: code });
    });

    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

class WinaclBackend implements SandboxBackend {
  readonly kind = "winacl" as const;
  readonly shellTool = "powershell" as const;
  readonly runnerFailureRules: readonly RunnerFailureRule[] = RUNNER_FAILURE_RULES.winacl;
  info: SandboxBackendInfo = { kind: "winacl", available: false, shellTool: "powershell" };

  probe(): boolean {
    const result = runProbe();
    this.info.available = result.available;
    if (result.detail !== undefined) this.info.detail = result.detail;
    return result.available;
  }

  createToolOptions(ctx: BackendContext): BashToolOptions {
    // winacl：命令交给 Node runner（受限令牌执行）；结果侧分类（runner 失败 / denial）包在同一缝上。
    const base: BashOperations = {
      exec: async (command, cwd, options) => {
        // 用**当次调用**的 policy（含 session_start 之后的最新 workspaceRoot）；
        // 不要用 createToolOptions 时快照的 ctx.workspaceRoot：扩展装配发生在 session_start 之前，
        // 那份 workspaceRoot 是 process.cwd() 的陈旧快照 —— 会把 ACE 授到错误的目录。
        const policy = ctx.readState(cwd);
        const mode = policy.mode;
        // danger-full-access：本后端不参与（对齐 dsh「provider 不被咨询」）→ 交回 pi 本地 pwsh。
        if (mode === "danger-full-access") {
          return localPowerShellOperations.exec(command, cwd, options);
        }
        if (!winaclUsable()) {
          throw runnerUnavailable(`winacl backend is unusable on this host (platform ${process.platform})`);
        }
        const wrapped = buildWinaclRunnerArgv({
          workspace: policy.workspaceRoot,
          temp: process.env.TEMP ?? process.env.TMP ?? "",
          mode: mode === "workspace-write" ? "workspace-write" : "read-only",
          runnerEntry: RUNNER_PATH,
        });
        return invokeRunner(wrapped, command, cwd, options);
      },
    };
    return { operations: createConfinedOperations(base, resolveRunFacts(ctx, "winacl")) };
  }
}

export function createWinaclBackend(): SandboxBackend {
  return new WinaclBackend();
}
