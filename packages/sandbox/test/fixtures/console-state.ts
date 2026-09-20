/**
 * pi-sandbox-dsh-sandbox · 受限子进程的控制台可见性载荷（Windows-only 真机验证）。
 *
 * 由 `probe.ts` 经 winacl runner 在**受限令牌下**启动，把本进程 console 窗口的存在性与可见性
 * 以单行 JSON 打到 stdout：
 * - `{ hasWindow: true, visible: false }` = 期望：窗口存在（继承或新建 console）但被
 *   `STARTF_USESHOWWINDOW | SW_HIDE` 隐藏——不弹窗、不闪窗，同时保留 console 继承。
 * - `{ hasWindow: true, visible: true }` = 回归：初始化时真的显示了控制台窗口。
 * - `{ hasWindow: false, visible: false }` = 本进程没有 console **窗口**（本机的 WSL interop /
 *   终端宿主都是这种：进程可能挂在无窗口的 console 上，同样"没有可见窗口"）。
 *
 * 字段名用 `hasWindow` 而非 `hasConsole`：`GetConsoleWindow()` 返回的是窗口句柄，为 NULL 只说明
 * 没有**窗口**，不说明没有 console。
 *
 * 非 Windows 平台输出 `{ unsupported: true }`，让同一份载荷在任何平台都有稳定契约。
 * 用 Node 而非 pwsh 作载荷：`read-only` 档下 pwsh 运行在 ConstrainedLanguage，`Add-Type` 会被拒。
 */
import { requireKoffi } from "../../src/win32/koffi.ts";

/** 本进程 console 窗口的存在性与可见性。 */
export interface ConsoleState {
  hasWindow: boolean;
  visible: boolean;
}

/**
 * 读本进程的 console 状态（`GetConsoleWindow` + `IsWindowVisible`）。
 * @returns console 窗口存在性与可见性；非 Windows 返回 `undefined`。
 */
function readConsoleState(): ConsoleState | undefined {
  if (process.platform !== "win32") return undefined;
  const koffi = requireKoffi();
  const PVOID = koffi.pointer("void");
  const kernel32 = koffi.load("kernel32.dll");
  const user32 = koffi.load("user32.dll");
  const getConsoleWindow = kernel32.func("__stdcall", "GetConsoleWindow", PVOID, []);
  const isWindowVisible = user32.func("__stdcall", "IsWindowVisible", "bool", [PVOID]);
  const handle: unknown = getConsoleWindow();
  if (handle === null || handle === undefined) return { hasWindow: false, visible: false };
  return { hasWindow: true, visible: isWindowVisible(handle) === true };
}

const state = readConsoleState();
console.log(JSON.stringify(state ?? { unsupported: true }));
