/**
 * pi-sandbox-dsh-core · pi 扩展宿主。
 *
 * 单一参考源 = dsh：连续 agent + 全局沙箱档 + 门控驱动（用户决策点）。
 * 装配：运行时 store（全局档折叠）→ 后端（bwrap/winacl）bash 工具（spawnHook 收敛，不 fork）
 * → 文件工具门控（write/edit，被拒即征求批准）→ `/sandbox` 命令（更宽档需确认）→ 档位提示段。
 */
import { createBashTool, createPowerShellTool, type ExtensionAPI, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { SandboxExecutionPolicy, SandboxMode } from "pi-sandbox-dsh-bridge";
import {
  DEFAULT_SANDBOX_MODE,
  renderPolicyContext,
  isSandboxMode,
  SANDBOX_MODE_DESCRIPTIONS,
  SANDBOX_MODES,
} from "pi-sandbox-dsh-bridge";
import { selectBackend, type SandboxBackend } from "pi-sandbox-dsh-sandbox";
import { initState, foldSandboxMode, SANDBOX_MODE_ENTRY, type SandboxState } from "./state.ts";
import { registerFileToolGate } from "./tools-fs.ts";

/**
 * 徽标文案 `[<mode>]`：只读=橙(256色208，pi 主题无橙)、工作区可写=蓝(accent)、全权=红(error)。
 * 后端不可用时追加 ` (no backend)`；否则徽标会宣告一个并未生效的档位（写入面没有被 OS 约束）。
 */
function sandboxBadgeText(theme: Theme, mode: SandboxMode, backendAvailable: boolean): string {
  const base = (() => {
    switch (mode) {
      case 'read-only':
        return '\x1B[38;5;208m[read-only]\x1B[0m';
      case 'workspace-write':
        return theme.fg('accent', '[workspace-write]');
      case 'danger-full-access':
        return theme.fg('error', '[danger-full-access]');
      default:
        return '[sandbox]';
    }
  })();
  return backendAvailable ? base : `${base} (no backend)`;
}

/** 后端不可用时的通知文案（英文，对齐通知机制约定）：说明"壳未被收敛"而不是假装档位生效。 */
function backendUnavailableNotice(detail: string): string {
  return 'pi-sandbox-dsh: sandbox backend unavailable — the confined shell tool was NOT registered, so shell commands are not OS-confined '
    + '(write/edit stay gated by the current mode). '
    + `Reason: ${detail} `
    + 'Fix the backend (Windows: a system `node` on PATH + `koffi`; Linux/WSL2: bwrap) or switch to danger-full-access explicitly.';
}

export default function sandboxExtension(pi: ExtensionAPI): void {
  const store: SandboxState = initState(DEFAULT_SANDBOX_MODE, process.cwd());

  // footer 徽标（方案 A）：setStatus 写入 pi footer 状态槽（不替换、永不丢信息、不随 pi 升级漂移）
  const updateSandboxBadge = (ui: ExtensionUIContext | undefined): void => {
    if (!ui) return;
    ui.setStatus('pi-sandbox-dsh', sandboxBadgeText(ui.theme, store.mode, backendError === undefined));
  };

  pi.on("session_start", (_event, ctx) => {
    store.workspaceRoot = ctx.cwd;
    const entries = (ctx.sessionManager?.getEntries?.() ?? []) as readonly unknown[];
    store.mode = foldSandboxMode(entries as never, store.defaultMode);
    updateSandboxBadge(ctx.ui);
    // fail-closed 的“可见化”：后端不可用时壳工具根本没注册（pi 内置 shell 仍在，即未被收敛）——
    // 必须显式告知用户，不能让徽标宣称一个没生效的档位。
    if (backendError !== undefined) {
      ctx.ui?.notify(backendUnavailableNotice(backendError), "error");
    }
  });

  // 读取当前执行 policy（spawnHook 用）
  const readState = (_cwd: string): SandboxExecutionPolicy => ({
    mode: store.mode,
    workspaceRoot: store.workspaceRoot,
    ...(store.sessionId !== undefined ? { sessionId: store.sessionId } : {}),
  });

  // 后端装配：bash 工具经 spawnHook 收敛到全局档（不重注册，不 fork）
  let backend: SandboxBackend | undefined;
  let backendError: string | undefined;
  try {
    backend = selectBackend();
    if (backend.probe()) {
      const toolOptions = backend.createToolOptions({ workspaceRoot: store.workspaceRoot, readState });
      // winacl → powershell（受限令牌 × git-bash 不兼容）；bwrap → bash。均不加升级字段（不 fork）。
      const shellTool =
        backend.shellTool === "powershell"
          ? createPowerShellTool(store.workspaceRoot, toolOptions as never)
          : createBashTool(store.workspaceRoot, toolOptions);
      pi.registerTool(shellTool as never);
    } else {
      backendError = "沙箱后端探测失败（bwrap --version 未通过）；bash 未加收敛";
    }
  } catch (e) {
    backendError = e instanceof Error ? e.message : String(e);
    backend = undefined;
  }

  // 文件工具（write/edit）门控：被拒即征求用户批准（per-call 升级）
  registerFileToolGate(pi, store, readState, () => store.mode !== "danger-full-access");

  // `/sandbox` 命令：显示/切换全局档；更宽档需用户确认（门控/命令驱动、用户决策点）
  pi.registerCommand("sandbox", {
    description: "显示/切换全局沙箱档位（read-only | workspace-write | danger-full-access）。",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();

      // 交互选档位：空参数或非法参数时弹 picker（对齐 /model，避免手输打错）。
      // 显式合法档仍走字符参数（脚本/精确切换）。无交互 UI 时退回提示。
      let mode: SandboxMode;
      if (isSandboxMode(input)) {
        mode = input;
      } else if (ctx.ui?.select) {
        const picked = await ctx.ui.select(`选择沙箱档位。（当前: ${store.mode}）`, [...SANDBOX_MODES]);
        if (!picked) return; // 取消/超时
        mode = picked as SandboxMode;
        ctx.ui.notify(`已选择: ${mode} — ${SANDBOX_MODE_DESCRIPTIONS[mode]}`, "info");
      } else {
        ctx.ui.notify(
          input === ""
            ? `当前沙箱档: ${store.mode}\n描述: ${SANDBOX_MODE_DESCRIPTIONS[store.mode]}\n切换: /sandbox <mode>`
            : `无效档位: ${input}。可选: ${SANDBOX_MODES.join(" / ")}`,
          input === "" ? "info" : "error",
        );
        return;
      }

      if (mode === store.mode) return;
      // 高危操作：任何档位切换（宽/窄、picker/字符参数一视同仁）都强制二次确认
      const choice = await ctx.ui.select(`确认切换到沙箱档位 ${mode}？（之前: ${store.mode}）`, ["切换", "取消"]);
      if (choice !== "切换") return;
      const prev = store.mode;
      store.mode = mode;
      updateSandboxBadge(ctx.ui);
      pi.appendEntry(SANDBOX_MODE_ENTRY, { mode });
      pi.sendMessage(
        { customType: `${SANDBOX_MODE_ENTRY}:notice`, content: `The user switched the sandbox mode: ${prev} → ${mode}`, display: true },
        { deliverAs: "steer" },
      );
    },
  });

  // 系统提示段：当前档位 + 门控说明
  pi.on("before_agent_start", (event) => {
    const content = renderPolicyContext(readState(process.cwd()));
    return { systemPrompt: event.systemPrompt + "\n\n" + content };
  });
}
