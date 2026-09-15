/**
 * pi-sandbox-dsh-sandbox · winacl confinement runner（argv-prefix 包装器）。
 *
 * 单一源 = dsh `sandbox-windows-acl/src/runner.ts`，pi 侧适配：
 * - **standalone grant 流程**：pi 宿主是 Bun，不能加载 koffi → 无法自己物化 ACE，
 *   故宿主从不传 `--write-sid`/`--temp-write-sid`；runner 自行派生工作区 SID、在 `--temp`
 *   下建随机私有目录并派生其 SID、授予两项 ACE、子进程退出后撤销 temp ACE 并删目录
 *   （工作区 ACE 保留 = 跨会话复用缓存，对齐 dsh「standing ACE」语义）。seam-managed 分支
 *   保留以对齐 dsh argv 契约（pi 暂不使用）。
 * - **去掉 control-pipe 继承**（dsh `SUBPROCESS_CONTROL_*`）：pi 没有子进程控制面。
 * - **新增 `--probe`**：只做能力探针（koffi 绑定 + 受限令牌 + 默认 DACL + kill-on-close Job），
 *   不拉起子进程 —— 宿主在扩展装配时同步调用它做 fail-closed 判定。
 *
 * 稳定 argv 契约（宿主 `buildWinaclRunnerArgv` 构造）：
 *   [node, runner.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write>,
 *    ['--write-sid', <S-1-4-…>, '--temp-write-sid', <S-1-4-…>], '--', <argv...>]
 *   [node, runner.js, '--probe']
 *
 * 失败契约：runner 侧任何失败（参数、目录、令牌/grant/spawn 错误）向 stderr 打印
 * `windows-acl-run: <detail>` 并退出 127（宿主 RUNNER_FAILURE_RULES 匹配该签名），
 * 子进程**永不**以不受限方式拉起。
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { WINACL_RUNNER_FAILURE_EXIT, WINACL_RUNNER_FAILURE_SIGNATURE } from "pi-sandbox-dsh-bridge";
import { win32 } from "./ffi.ts";
import { AclSandbox, assertTempRootOutsideWorkspace } from "./index.ts";
import { probeRestrictedTokenJobSupport } from "./process.ts";
import { tempWriteSid, workspaceWriteSid } from "./workspace-sid.ts";

const RUNNER_SIGNATURE = WINACL_RUNNER_FAILURE_SIGNATURE.trimEnd();
const RUNNER_FAILURE_EXIT = WINACL_RUNNER_FAILURE_EXIT;

class RunnerFailure extends Error {}

/** 打印 runner 失败签名行并展开栈外错误。 */
function fail(detail: string): never {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`);
  throw new RunnerFailure(detail);
}

interface ParsedArgs {
  workspace: string;
  temp: string;
  mode: "read-only" | "workspace-write";
  writeSid: string | undefined;
  tempWriteSid: string | undefined;
  command: string;
  args: string[];
}

function parseArgs(raw: string[]): ParsedArgs {
  let workspace: string | undefined;
  let temp: string | undefined;
  let mode: string | undefined;
  let writeSid: string | undefined;
  let parsedTempWriteSid: string | undefined;
  let index = 0;
  for (; index < raw.length; index++) {
    const token = raw[index];
    if (token === "--") {
      index++;
      break;
    }
    index++;
    const value = raw[index];
    if (value === undefined) fail(`missing value after ${token}`);
    switch (token) {
      case "--workspace": workspace = value; break;
      case "--temp": temp = value; break;
      case "--mode": mode = value; break;
      case "--write-sid": writeSid = value; break;
      case "--temp-write-sid": parsedTempWriteSid = value; break;
      default: fail(`unknown argument: ${token}`);
    }
  }
  if (workspace === undefined) fail("missing --workspace");
  if (temp === undefined) fail("missing --temp");
  if (mode !== "read-only" && mode !== "workspace-write") fail(`unknown mode: ${String(mode)}`);
  const argv = raw.slice(index);
  const command = argv[0];
  if (command === undefined) fail("missing command after --");
  return { workspace, temp, mode, writeSid, tempWriteSid: parsedTempWriteSid, command, args: argv.slice(1) };
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`);
  }
}

/**
 * 能力探针：koffi 绑定 → 当前令牌 → 受限令牌（read-only 列表）→ 默认 DACL → kill-on-close Job。
 * 不拉起子进程（宿主在扩展装配时同步调用，需快且 fail-closed）。
 */
async function runProbe(): Promise<number> {
  const api = await win32();
  probeRestrictedTokenJobSupport(api);
  const sandbox = new AclSandbox({ writableDirs: [], tempDir: null, mode: "read-only", manageDacls: false });
  try {
    await sandbox.init();
  } finally {
    sandbox.dispose();
  }
  process.stdout.write(`${RUNNER_SIGNATURE} probe ok\n`);
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--probe")) return runProbe();

  const parsed = parseArgs(process.argv.slice(2));
  // 两种模式都校验：provider 传了错根目录必须在 runner 边界立刻失败，而不是到子进程中途。
  requireDirectory("--workspace", parsed.workspace);
  requireDirectory("--temp", parsed.temp);

  const seamManaged = parsed.writeSid !== undefined || parsed.tempWriteSid !== undefined;
  if (parsed.mode === "read-only" && seamManaged) {
    fail("read-only does not accept --write-sid or --temp-write-sid");
  }
  if (parsed.mode === "workspace-write" && (parsed.writeSid === undefined) !== (parsed.tempWriteSid === undefined)) {
    fail("workspace-write requires --write-sid and --temp-write-sid together");
  }
  if (parsed.mode === "workspace-write") {
    assertTempRootOutsideWorkspace(parsed.workspace, parsed.temp);
  }

  const api = await win32();
  // 忽略 runner 自身的 CTRL+C：受限子进程（同一控制台）自己处理；runner 必须活到撤销 grant
  // 并把子进程退出码透传出去。
  if (api.setConsoleCtrlHandler(null, 1) === 0) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`);
  }

  let ownedTempDir: string | undefined;
  let sandbox: AclSandbox | undefined;
  let initialized = false;
  try {
    let privateTempDir: string | null = null;
    let writeSid: string | undefined;
    let privateTempSid: string | undefined;
    if (parsed.mode === "workspace-write") {
      writeSid = workspaceWriteSid(parsed.workspace);
      if (seamManaged) {
        if (parsed.writeSid !== writeSid) fail("--write-sid does not match --workspace");
        privateTempDir = parsed.temp;
        privateTempSid = tempWriteSid(privateTempDir);
        if (parsed.tempWriteSid !== privateTempSid) fail("--temp-write-sid does not match --temp");
      } else {
        ownedTempDir = mkdtempSync(join(parsed.temp, "pi-sandbox-dsh-"));
        privateTempDir = ownedTempDir;
        privateTempSid = tempWriteSid(privateTempDir);
      }
    }
    sandbox = new AclSandbox({
      writableDirs: parsed.mode === "workspace-write" ? [parsed.workspace] : [],
      tempDir: privateTempDir,
      mode: parsed.mode,
      ...writeSid === undefined ? {} : { writeSid },
      ...privateTempSid === undefined ? {} : { tempWriteSid: privateTempSid },
      manageDacls: !seamManaged,
    });
    await sandbox.init();
    initialized = true;

    if (privateTempDir !== null) {
      if (api.setEnvironmentVariableW("TMP", privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TMP failed (Win32 ${api.getLastError()})`);
      }
      if (api.setEnvironmentVariableW("TEMP", privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TEMP failed (Win32 ${api.getLastError()})`);
      }
    }

    const child = sandbox.spawn({ command: parsed.command, args: parsed.args, stdio: "inherit" });
    const result = await child.wait();
    return result.exitCode;
  } finally {
    // 清理失败不能掩盖子进程退出码：报告后继续。
    if (initialized) {
      try {
        sandbox?.dispose();
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (ownedTempDir !== undefined) {
      try {
        rmSync(ownedTempDir, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
}

main().then(
  (exitCode) => {
    // 退出码全宽透传（Windows 上 GetExitCodeProcess 读回 uint32；Node 允许 exitCode 为该值）。
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(`${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = RUNNER_FAILURE_EXIT;
  },
);
