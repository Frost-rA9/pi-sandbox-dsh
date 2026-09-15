/**
 * pi-sandbox-dsh-sandbox · 宿主 ↔ runner 的 argv 契约（**纯函数，无原生依赖**）。
 *
 * 单独成文件的原因（最小暴露面）：pi 宿主是 Bun，不能加载 koffi；把这两件事放在
 * `win32/index.ts`（AclSandbox 入口，会拉起 token/acl/ffi 整张图）之外，宿主 import 路径
 * 就完全不含原生模块。runner 侧仍按同一契约解析（见 `runner.ts`）。
 */

/** win32 是否可用（当前宿主为 Windows）。真可用性由 runner `--probe` 判定。 */
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
 * `--write-sid`+`--temp-write-sid` 仅在 workspace-write 且由调用方物化 grant 时成对出现；
 * pi 宿主无法物化 ACE（Bun 不能加载 koffi），故走 runner 自管 DACL 的 standalone 流程
 * （runner 自行派生工作区 SID、创建私有 temp、授予并在退出时撤销 temp grant）。
 */
export function buildWinaclRunnerArgv(spec: WinaclRunnerSpec): string[] {
  const argv = ["node", spec.runnerEntry, "--workspace", spec.workspace, "--temp", spec.temp, "--mode", spec.mode];
  if (spec.mode === "workspace-write") {
    if (spec.writeSid !== undefined) argv.push("--write-sid", spec.writeSid);
    if (spec.tempWriteSid !== undefined) argv.push("--temp-write-sid", spec.tempWriteSid);
  }
  return argv;
}
