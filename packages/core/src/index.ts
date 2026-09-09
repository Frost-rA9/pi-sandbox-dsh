/**
 * pi-sandbox-dsh-core · pi 扩展宿主。
 *
 * 单一参考源 = dsh：连续 agent + 全局沙箱档 + 门控驱动（用户决策点）。
 * 装配：运行时 store（全局档折叠）→ 后端（bwrap/winacl）bash 工具（spawnHook 收敛，不 fork）
 * → 文件工具门控（write/edit，被拒即征求批准）→ `/sandbox` 命令（更宽档需确认）→ 档位提示段。
 */
import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import {
  DEFAULT_SANDBOX_MODE,
  renderPolicyContext,
  isSandboxMode,
  isStrictlyWider,
  SANDBOX_MODE_DESCRIPTIONS,
} from "pi-sandbox-dsh-bridge";
import { selectBackend, type SandboxBackend } from "pi-sandbox-dsh-sandbox";
import { initState, foldSandboxMode, SANDBOX_MODE_ENTRY, type SandboxState } from "./state.ts";
import { registerFileToolGate } from "./tools-fs.ts";

export default function sandboxExtension(pi: ExtensionAPI): void {
  const store: SandboxState = initState(DEFAULT_SANDBOX_MODE, process.cwd());

  pi.on("session_start", (_event, ctx) => {
    store.workspaceRoot = ctx.cwd;
    const entries = (ctx.sessionManager?.getEntries?.() ?? []) as readonly unknown[];
    store.mode = foldSandboxMode(entries as never, store.defaultMode);
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
      // createBashTool 直接注册：bash 工具保持 pi 原样，仅多加 spawnHook 收敛
      pi.registerTool(createBashTool(store.workspaceRoot, toolOptions) as never);
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
      if (input === "") {
        ctx.ui.notify(`当前沙箱档: ${store.mode}\n描述: ${SANDBOX_MODE_DESCRIPTIONS[store.mode]}\n切换: /sandbox <mode>`, "info");
        return;
      }
      if (!isSandboxMode(input)) {
        ctx.ui.notify(`无效档位: ${input}。可选: read-only / workspace-write / danger-full-access`, "error");
        return;
      }
      if (input === store.mode) return;
      // 更宽档（read-only → workspace-write/danger，或 workspace-write → danger）需用户确认
      if (isStrictlyWider(store.mode, input)) {
        const choice = await ctx.ui.select(`切换到更宽沙箱档 ${input}？（之前: ${store.mode}）`, ["切换", "取消"]);
        if (choice !== "切换") return;
      }
      const prev = store.mode;
      store.mode = input;
      pi.appendEntry(SANDBOX_MODE_ENTRY, { mode: input });
      pi.sendMessage(
        { customType: `${SANDBOX_MODE_ENTRY}:notice`, content: `沙箱档位已切换: ${prev} → ${input}`, display: true },
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
