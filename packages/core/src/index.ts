/**
 * pi-sandbox-dsh-core · pi 扩展宿主。
 *
 * 单一参考源 = dsh：连续 agent + 全局沙箱档 + 门控驱动（用户决策点）。
 * 平台分叉（2026-09-21 决策，见 `docs/architecture.md`）：
 * - **Linux/WSL2**：bwrap 后端 + 受限 `bash`（**恒注册**；后端不可用则在调用点 fail-closed）
 *   + write/edit 门控（被拒即征求「允许本次」）+ `/sandbox` 切档 + 档位提示段。
 * - **Windows**：**无可用 OS 写面沙箱**（受限令牌 × Schannel/SSPI 平台级不兼容，替代机制未验证）
 *   → 固定 `danger-full-access`，不注册壳覆盖/门控；`/sandbox` 保留可见性但**拒绝切换**。
 *   这是 fail-open，但**不假收敛**：不宣称一个不存在的沙箱。
 */
import {
  createBashTool,
  createLocalBashOperations,
  type BashOperations,
  type BashToolOptions,
  type ExtensionAPI,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { SandboxExecutionPolicy, SandboxMode } from "pi-sandbox-dsh-bridge";
import {
  DEFAULT_SANDBOX_MODE,
  SANDBOX_UNAVAILABLE,
  UNSANDBOXED_MODE,
  renderPolicyContext,
  isSandboxMode,
  SANDBOX_MODE_DESCRIPTIONS,
  SANDBOX_MODES,
} from "pi-sandbox-dsh-bridge";
import { selectBackend, type SandboxBackend } from "pi-sandbox-dsh-sandbox";
import { initState, foldSandboxMode, SANDBOX_MODE_ENTRY, type SandboxState } from "./state.ts";
import { registerFileToolGate } from "./tools-fs.ts";

/** 本平台是否有 OS 写面沙箱。Windows 没有（见模块头）。 */
const UNSANDBOXED_PLATFORM = process.platform === "win32";

/** 徽标状态：正常 / 后端不可用（Linux fail-closed）/ 本平台无沙箱（Windows）。 */
type BadgeStatus = "ok" | "no-backend" | "unsandboxed";

/**
 * 徽标文案 `[<mode>]`：只读=橙(256色208，pi 主题无橙)、工作区可写=蓝(accent)、全权=红(error)。
 * 后端不可用或本平台无沙箱时追加后缀，避免徽标宣告一个并未生效的档位。
 */
function sandboxBadgeText(theme: Theme, mode: SandboxMode, status: BadgeStatus): string {
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
  if (status === "no-backend") return `${base} (no backend)`;
  if (status === "unsandboxed") return `${base} (no sandbox)`;
  return base;
}

/**
 * Linux 后端不可用时的通知文案（英文，对齐通知机制约定）：受限 `bash` 仍在，但会拒绝执行。
 */
function backendUnavailableNotice(detail: string): string {
  return `pi-sandbox-dsh: sandbox backend unavailable — the confined "bash" shell will REFUSE commands until this is fixed `
    + '(it never runs them unconfined), and write/edit stay gated by the current mode. '
    + `Reason: ${detail} `
    + 'Fix the backend (Linux/WSL2: bwrap) or switch to danger-full-access explicitly.';
}

/** Windows 无沙箱的启动通知（英文，对齐通知机制约定）。 */
function unsandboxedPlatformNotice(): string {
  return 'pi-sandbox-dsh: this platform has no OS write sandbox (Windows). '
    + `Running unconfined with a fixed ${UNSANDBOXED_MODE} mode — the sandbox tier cannot be switched here. `
    + 'See docs/architecture.md for why (restricted tokens are incompatible with Schannel/SSPI).';
}

/** fail-closed 错误（带 `SANDBOX_UNAVAILABLE` 错误码，与结果侧分类同一词汇）。 */
function sandboxUnavailable(detail: string): Error {
  const error = new Error(
    `sandbox backend unavailable: ${detail}. The command did not run; this extension never runs commands unconfined — `
    + 'fix the backend or switch to danger-full-access explicitly.',
  );
  (error as { code?: string }).code = SANDBOX_UNAVAILABLE;
  return error;
}

/**
 * 后端构造失败时的"拒绝壳"：工具面保持存在（不变量 4），非 `danger-full-access` 一律拒绝，
 * 只有用户显式放开才交回 pi 本地 shell。
 * @param detail - 失败原因（写进错误文案）。
 * @param readState - 按 cwd 解析 policy。
 */
function refusingShellOperations(
  detail: string,
  readState: (cwd: string) => SandboxExecutionPolicy,
): BashOperations {
  const local = createLocalBashOperations();
  return {
    exec: async (command, cwd, options) => {
      if (readState(cwd).mode === "danger-full-access") return local.exec(command, cwd, options);
      throw sandboxUnavailable(detail);
    },
  };
}

export default function sandboxExtension(pi: ExtensionAPI): void {
  const store: SandboxState = initState(UNSANDBOXED_PLATFORM ? UNSANDBOXED_MODE : DEFAULT_SANDBOX_MODE, process.cwd());

  // footer 徽标（方案 A）：setStatus 写入 pi footer 状态槽（不替换、永不丢信息、不随 pi 升级漂移）
  const updateSandboxBadge = (ui: ExtensionUIContext | undefined, backendError: string | undefined): void => {
    if (!ui) return;
    const status: BadgeStatus = UNSANDBOXED_PLATFORM
      ? "unsandboxed"
      : backendError === undefined ? "ok" : "no-backend";
    ui.setStatus('pi-sandbox-dsh', sandboxBadgeText(ui.theme, store.mode, status));
  };

  // 读取当前执行 policy（spawnHook 用）
  const readState = (_cwd: string): SandboxExecutionPolicy => ({
    mode: store.mode,
    workspaceRoot: store.workspaceRoot,
  });

  // ---- 平台分叉：Windows 无后端，固定全权；Linux 走 bwrap（恒注册受限壳，不可用即拒）----
  let backendError: string | undefined;

  if (UNSANDBOXED_PLATFORM) {
    // 无 OS 沙箱：不选后端、不注册壳覆盖、不注册任何门控。档位恒 UNSANDBOXED_MODE。
    pi.on("session_start", (_event, ctx) => {
      store.workspaceRoot = ctx.cwd;
      store.mode = UNSANDBOXED_MODE;
      updateSandboxBadge(ctx.ui, undefined);
      ctx.ui?.notify(unsandboxedPlatformNotice(), "warning");
    });
  } else {
    // 后端装配：probe **只出"可见性"**（通知/徽标），不再是"有没有壳"的判据；受限壳恒注册（不变量 4）。
    let backend: SandboxBackend | undefined;
    let shellToolOptions: BashToolOptions | undefined;
    try {
      backend = selectBackend();
      if (backend === undefined) {
        backendError = "no sandbox backend is available on this platform";
      } else {
        if (!backend.probe()) {
          // 后端自己声明失败原因（bwrap 缺依赖…），不要写死某一后端。
          backendError = backend.info.detail ?? `${backend.kind} backend probe failed`;
        }
        shellToolOptions = backend.createToolOptions({ workspaceRoot: store.workspaceRoot, readState });
      }
    } catch (e) {
      backendError = e instanceof Error ? e.message : String(e);
      backend = undefined;
      shellToolOptions = undefined;
    }

    // 壳工具恒注册：不可用时其 operations 在调用点拒绝；构造失败则退化为"拒绝壳"。
    const shellOptions: BashToolOptions = shellToolOptions ?? {
      operations: refusingShellOperations(backendError ?? "sandbox backend construction failed", readState),
    };
    pi.registerTool(createBashTool(store.workspaceRoot, shellOptions) as never);

    // 文件工具（write/edit）门控：被拒即征求用户批准（per-call 升级）
    registerFileToolGate(pi, store, readState, () => store.mode !== "danger-full-access", () => backendError !== undefined);

    pi.on("session_start", (_event, ctx) => {
      store.workspaceRoot = ctx.cwd;
      const entries = (ctx.sessionManager?.getEntries?.() ?? []) as readonly unknown[];
      store.mode = foldSandboxMode(entries as never, store.defaultMode);
      updateSandboxBadge(ctx.ui, backendError);
      // fail-closed 的"可见化"：后端不可用时壳工具仍在（拒绝执行）——
      // 必须显式告知用户，不能让徽标宣称一个没生效的档位。
      if (backendError !== undefined) {
        ctx.ui?.notify(backendUnavailableNotice(backendError), "error");
      }
    });
  }

  // `/sandbox` 命令：显示/切换全局档；更宽档需用户确认（门控/命令驱动、用户决策点）。
  // Windows 无沙箱：保留可见性，但只报告固定档、拒绝任何切换。
  pi.registerCommand("sandbox", {
    description: "显示/切换全局沙箱档位（read-only | workspace-write | danger-full-access）。",
    handler: async (args, ctx) => {
      if (UNSANDBOXED_PLATFORM) {
        ctx.ui.notify(
          `本平台（Windows）没有可用的 OS 写面沙箱 → 档位固定为 ${store.mode}，不可切换。`
            + '（原因见 docs/architecture.md「已知取舍」）',
          "warning",
        );
        return;
      }

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
      updateSandboxBadge(ctx.ui, backendError);
      pi.appendEntry(SANDBOX_MODE_ENTRY, { mode });
      pi.sendMessage(
        { customType: `${SANDBOX_MODE_ENTRY}:notice`, content: `The user switched the sandbox mode: ${prev} → ${mode}`, display: true },
        { deliverAs: "steer" },
      );
    },
  });

  // 系统提示段：当前档位 + 门控说明（Windows 追加"本平台无沙箱、档位固定"）
  pi.on("before_agent_start", (event) => {
    let content = renderPolicyContext(readState(process.cwd()));
    if (UNSANDBOXED_PLATFORM) {
      content += ' This platform has no OS write sandbox: the mode is fixed at danger-full-access and cannot be switched.';
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + content };
  });
}
