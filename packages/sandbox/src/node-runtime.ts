/**
 * pi-sandbox-dsh-sandbox · 为 winacl runner 解析一个可用的**系统 Node**。
 *
 * 为什么需要：pi 宿主是 Bun（不能加载 koffi），Win32 逻辑只能跑在 `node runner.ts` 子进程里。
 * 而扩展进程的 `PATH` 未必包含 node —— 典型情形：pi 由**早于 node 安装/变更时打开的终端**启动，
 * 进程仍持有陈旧 PATH（本次真机 bug 就是它：probe 失败 + 通知里却写着 bwrap）。
 *
 * 解析顺序（第一个验证通过者胜出）：
 * 1. `PI_SANDBOX_NODE`（显式覆盖；设置了但不可用 → 直接失败，不静默换别的）；
 * 2. `PATH` 里的 `node`；
 * 3. Windows：用户/系统注册表 `Path` 里的 `node.exe`（覆盖"陈旧进程 PATH"这一主因）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** 解析结果：可直接用于 spawn 的命令 + 来源（写进 probe 详情用）。 */
export interface NodeRuntime {
  command: string;
  source: "PI_SANDBOX_NODE" | "PATH" | "registry-path";
}

/** 解析失败的详情（进 `SandboxBackendInfo.detail` → 用户可见通知）。 */
export interface NodeRuntimeFailure {
  detail: string;
}

/**
 * 从 PATH 风格字符串里挑出候选 node 可执行文件路径（纯函数，便于单测）。
 * 空段忽略、重复段去重；Windows 用 `node.exe`，其余用 `node`。
 * @param pathValue - `;`（Windows）或 `:` 分隔的 PATH 串。
 * @param platform - `process.platform` 值（默认当前平台）。
 * @returns 候选可执行文件绝对路径（不保证存在）。
 */
export function nodeCandidatesFromPathList(pathValue: string, platform: string = process.platform): string[] {
  const separator = platform === "win32" ? ";" : ":";
  const joinSeparator = platform === "win32" ? "\\" : "/";
  const name = platform === "win32" ? "node.exe" : "node";
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of pathValue.split(separator)) {
    const entry = raw.trim().replace(/^"|"$/gu, "").replace(/[\\/]+$/u, "");
    if (entry === "") continue;
    // 按**目标平台**的拼接规则拼路径（宿主可能是另一个平台的 separator）。
    const candidate = `${entry}${joinSeparator}${name}`;
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

/** 跑 `--version` 验证一个候选能用（也覆盖 PATH 命中但不可执行的情况）。 */
function works(command: string): boolean {
  try {
    const r = spawnSync(command, ["--version"], { timeout: 10_000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 读取一个注册表值的字符串（取不到返回 undefined）。 */
function readRegistryPath(key: string): string | undefined {
  try {
    const r = spawnSync("reg", ["query", key, "/v", "Path"], { timeout: 10_000, encoding: "utf8", windowsHide: true });
    if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
    const line = r.stdout.split(/\r?\n/u).find((row) => row.includes("Path") && row.includes("REG_"));
    if (line === undefined) return undefined;
    const match = /REG_(?:EXPAND_)?SZ\s+(.*)$/u.exec(line.trim());
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** 展开 `%VAR%`（注册表 Path 常见 `REG_EXPAND_SZ`）。 */
function expandVariables(value: string): string {
  return value.replace(/%([^%]+)%/gu, (whole, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? whole);
}

let cached: NodeRuntime | NodeRuntimeFailure | undefined;

/**
 * 解析并缓存 runner 需要的 Node。
 * @returns 成功为 {@link NodeRuntime}；失败为 {@link NodeRuntimeFailure}（带用户可见详情）。
 */
export function resolveNodeRuntime(): NodeRuntime | NodeRuntimeFailure {
  if (cached !== undefined) return cached;

  const override = process.env.PI_SANDBOX_NODE;
  if (override !== undefined && override.trim() !== "") {
    const command = override.trim();
    cached = works(command)
      ? { command, source: "PI_SANDBOX_NODE" }
      : { detail: `PI_SANDBOX_NODE is set to "${command}" but that Node does not run (\`--version\` failed)` };
    return cached;
  }

  if (works("node")) {
    cached = { command: "node", source: "PATH" };
    return cached;
  }

  if (process.platform === "win32") {
    const registryKeys = [
      "HKCU\\Environment",
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    ];
    for (const key of registryKeys) {
      const value = readRegistryPath(key);
      if (value === undefined) continue;
      for (const candidate of nodeCandidatesFromPathList(expandVariables(value), "win32")) {
        if (!existsSync(candidate)) continue;
        if (works(candidate)) {
          cached = { command: candidate, source: "registry-path" };
          return cached;
        }
      }
    }
  }

  cached = {
    detail: "a system Node runtime is required for the winacl runner but was not found "
      + "(checked PATH"
      + (process.platform === "win32" ? ", the user/system registry Path" : "")
      + "); set PI_SANDBOX_NODE to an absolute node path to override",
  };
  return cached;
}
