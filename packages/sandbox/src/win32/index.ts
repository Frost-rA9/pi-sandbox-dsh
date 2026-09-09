/**
 * pi-sandbox-dsh-sandbox · winacl（Windows 受限令牌 + NTFS ACE）win32 层。
 *
 * 单一源 = dsh `sandbox-windows-acl`。本层是 **Windows-only**（koffi FFI / 受限令牌 / ACE），
 * 本机（Linux/WSL2）**无法运行验证** —— `win32` 模块在非 win32 平台不应被真正加载 koffi。
 *
 * 导出：
 * - 纯函数：`workspaceWriteSid` / `tempWriteSid`（SID 派生，可测）、`assertTempRootOutsideWorkspace` /
 *   `assertPrivateTempDisjoint`（路径边界，可测）。
 * - 结构：`buildWinaclRunnerArgv`（runner argv 契约，可测）。
 *
 * 注：runner（`./runner.ts`）需 `AclSandbox`（`./index.ts`），后者依赖 token/acl/ffi/spawn，是
 * Windows-only 且未在本机验证 —— 接入前须在 Windows 真机 `probe`。
 */
import { workspaceWriteSid, tempWriteSid } from "./workspace-sid.ts";
import { assertTempRootOutsideWorkspace, assertPrivateTempDisjoint } from "./path-boundary.ts";

export { workspaceWriteSid, tempWriteSid };
export { assertTempRootOutsideWorkspace, assertPrivateTempDisjoint };

/** win32 是否可用（当前宿主为 Windows）。 */
export function winaclUsable(): boolean {
  return process.platform === "win32";
}

export interface WinaclRunnerSpec {
  workspace: string;
  temp: string;
  mode: "read-only" | "workspace-write";
  writeSid?: string;
  tempWriteSid?: string;
  runnerEntry: string;
}

/**
 * 构建 winacl runner argv（对齐 dsh `windows-acl` runner 契约）：
 * `[node, runner.js, '--workspace', ws, '--temp', tmp, '--mode', m,
 *   ['--write-sid', ..., '--temp-write-sid', ...], '--', <argv...>]`
 * `--write-sid`+`--temp-write-sid` 仅在 workspace-write 且由调用方物化 grant 时成对出现。
 */
export function buildWinaclRunnerArgv(spec: WinaclRunnerSpec): string[] {
  const argv = ["node", spec.runnerEntry, "--workspace", spec.workspace, "--temp", spec.temp, "--mode", spec.mode];
  if (spec.mode === "workspace-write") {
    if (spec.writeSid !== undefined) argv.push("--write-sid", spec.writeSid);
    if (spec.tempWriteSid !== undefined) argv.push("--temp-write-sid", spec.tempWriteSid);
  }
  return argv;
}
