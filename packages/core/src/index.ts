/**
 * pi-sandbox-dsh-core · pi 扩展宿主。
 *
 * 单一参考源 = dsh：连续 agent + 全局沙箱档 + 逐级批准。无 plan/build 双模式。
 * 装配：运行时 store（全局档折叠）→ 后端（bwrap/winacl）→ bash 工具（升级+denial）
 * → `/sandbox` 命令 → `before_agent_start` 档位提示段。
 */
import { createBashTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxExecutionPolicy } from "pi-sandbox-dsh-bridge";
import { DEFAULT_SANDBOX_MODE, renderPolicyContext, isSandboxMode, SANDBOX_MODE_DESCRIPTIONS } from "pi-sandbox-dsh-bridge";
import { selectBackend, type SandboxBackend } from "pi-sandbox-dsh-sandbox";
import { initState, foldSandboxMode, SANDBOX_MODE_ENTRY, type SandboxState } from "./state.ts";
import { registerBashTool } from "./tools.ts";

export default function sandboxExtension(pi: ExtensionAPI): void {
  const store: SandboxState = initState(DEFAULT_SANDBOX_MODE, process.cwd());

  pi.on("session_start", (_event, ctx) => {
    store.workspaceRoot = ctx.cwd;
    const entries = (ctx.sessionManager?.getEntries?.() ?? []) as readonly unknown[];
    const folded = foldSandboxMode(entries as never, store.defaultMode);
    store.mode = folded;
  });

  // 读取当前执行 policy（bash 工具 execute / spawnHook 用）
  const readState = (_cwd: string): SandboxExecutionPolicy => ({
    mode: store.mode,
    workspaceRoot: store.workspaceRoot,
    ...(store.sessionId !== undefined ? { sessionId: store.sessionId } : {}),
  });

  // 后端装配 + bash 工具注册
  let backend: SandboxBackend | undefined;
  let backendError: string | undefined;
  try {
    backend = selectBackend();
    if (backend.probe()) {
      const toolOptions = backend.createToolOptions({ workspaceRoot: store.workspaceRoot, readState });
      const baseTool = createBashTool(store.workspaceRoot, toolOptions);
      registerBashTool(
        { pi, state: store, backend, workspaceRoot: store.workspaceRoot, readState, getEntries: () => [], getSessionId: () => store.sessionId },
        baseTool as never,
      );
    } else {
      backendError = "沙箱后端探测失败（bwrap --version 未通过）";
    }
  } catch (e) {
    backendError = e instanceof Error ? e.message : String(e);
    backend = undefined;
  }

  // `/sandbox <mode>` 命令：切换全局档（appendEntry 日志真源）
  pi.registerCommand("sandbox", {
    description: "显示/切换全局沙箱档位（read-only | workspace-write | danger-full-access）。",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      if (input === "") {
        ctx.ui.notify(
          `当前沙箱档: ${store.mode}\n描述: ${SANDBOX_MODE_DESCRIPTIONS[store.mode]}\n切换: /sandbox <mode>`,
          "info",
        );
        return;
      }
      if (!isSandboxMode(input)) {
        ctx.ui.notify(`无效档位: ${input}。可选: read-only / workspace-write / danger-full-access`, "error");
        return;
      }
      if (input === store.mode) {
        return;
      }
      const prev = store.mode;
      store.mode = input;
      pi.appendEntry(SANDBOX_MODE_ENTRY, { mode: input });
      pi.sendMessage({ customType: `${SANDBOX_MODE_ENTRY}:notice`, content: `沙箱档位已切换: ${prev} → ${input}`, display: true }, { deliverAs: "steer" });
    },
  });

  // 系统提示段：当前档位
  pi.on("before_agent_start", (event) => {
    const content = renderPolicyContext(readState(process.cwd()));
    return { systemPrompt: event.systemPrompt + "\n\n" + content };
  });
}
