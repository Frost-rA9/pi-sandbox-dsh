/**
 * pi-sandbox-dsh-sandbox · 真机 probe（`npm run probe`）。
 *
 * 结构测试（`npm test`）只验证纯函数与 argv 契约；本文件在**真机**验证后端能不能真正约束写面：
 * - Linux/WSL2：bwrap 可用性（完整 e2e 在 `test/bwrap-e2e.spec.ts`）。
 * - Windows：winacl runner 能力探针 + 受限令牌往返 —— read-only 写被拒 / 读全开；
 *   workspace-write 写工作区成功、写工作区外被拒；工作区 ACE 幂等保留（standing reuse cache），
 *   runner 退出后自建的私有 temp 目录不残留；Schannel TLS 的机制级已知边界（下面「HTTPS」节）。
 *
 * 退出码 0 = 全部通过；1 = 有失败（fail-closed：探针失败即视为后端不可用）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPowerShellConfig } from "@earendil-works/pi-coding-agent";
import { probeBwrap } from "./bwrap.ts";
import { buildWinaclRunnerArgv, winaclUsable } from "./win32/runner-contract.ts";
import { win32Sync } from "./win32/ffi.ts";
import { createPrivateTempDir } from "./win32/temp-lock.ts";
import { isPrivateTempDirName, STALE_WITHOUT_LOCK_MS, TEMP_DIR_PREFIX } from "./win32/temp-sweep.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "win32", "runner.ts");
const NODE_FLAGS = ["--experimental-strip-types"] as const;

/** 跑一次 runner（与宿主同一条 argv 契约），返回退出码与合并输出。 */
function runRunner(args: readonly string[]): { status: number | null; output: string } {
  const r = spawnSync("node", [...NODE_FLAGS, RUNNER, ...args], { timeout: 120_000, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 用 pwsh 执行一段脚本（**不包 try/catch**：受限令牌下 PowerShell 运行在 ConstrainedLanguage，
 *  catch 里的 [Console]::Error.WriteLine / $_.Exception.GetType() 这类方法调用会被 CLM 拒掉，
 *  反而掩盖真实错误；让 cmdlet 自己报错就能拿到 `Access to the path … is denied.` 原文）。 */
function pwshCommand(body: string): string[] {
  const shell = getPowerShellConfig();
  return [shell.shell, ...shell.args, body];
}

/** 系统 curl（Win10 1803+ 自带，Schannel 客户端）：验证受限子进程能不能建成 TLS 凭据。 */
const SYSTEM_CURL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe");

/** Schannel 凭据失败签名：英文前缀与错误码是稳定锚点（系统文案本地化不影响）。 */
const CREDENTIAL_FAILURE = /schannel|SEC_E_NO_CREDENTIALS|0x8009030e/iu;

/** 同步问内核要一个空闲的 loopback 端口（子进程自己 close，端口随后交给下面的监听）。 */
function freeLoopbackPort(): number | undefined {
  const result = spawnSync(process.execPath, ["-e",
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
  ], { encoding: "utf8", timeout: 20_000 });
  const port = Number((result.stdout ?? "").trim());
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * 起一个本机明文 TCP 汇（sink），让「Schannel 凭据失败」的判定**不依赖外网/代理/对端是否真在说 TLS**。
 *
 * 必要性（实测）：curl 只在 **TCP 连上之后**才去取 Schannel 凭据 —— 直连被拒时它 exit 7
 * （curl: (7) Failed to connect）压根到不了 TLS 那一步，凭据失败就观测不到；走 HTTP 代理时
 * CONNECT 隧道一建成它就立刻报凭据错。所以用本机监听把「连得上」这个前提固定下来：
 * 受限令牌下必报凭据错；将来若被修好，错误签名会变成握手层（断言随之翻转）。
 * @returns 端口与终止函数（undefined = 监听没起来，调用方改为仅报告）。
 */
function startLoopbackTlsSink(): { port: number; stop: () => void } | undefined {
  const port = freeLoopbackPort();
  if (port === undefined) return undefined;
  // 汇自戕（20s 后自己退出）：即使探针崩溃也不会留下长期监听的孤儿进程。
  const sink = spawn(process.execPath, ["-e",
    `const s=require('node:net').createServer(c=>c.on('error',()=>{}));s.on('error',()=>process.exit(1))`
    + `.listen(${String(port)},'127.0.0.1',()=>setTimeout(()=>process.exit(0),20000))`,
  ], { stdio: "ignore" });
  for (let attempt = 0; attempt < 20; attempt++) {
    const ready = spawnSync(process.execPath, ["-e",
      `require('node:net').connect(${String(port)},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`,
    ], { timeout: 10_000 });
    if (ready.status === 0) return { port, stop: () => { sink.kill(); } };
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},100)"], { timeout: 10_000 });
  }
  sink.kill();
  return undefined;
}

/** 工作区 DACL 里 capability SID ACE 的条数（icacls 对无法解析的 SID 打印 `S-1-4-…`）。 */
function countCapabilityAces(workspace: string): number {
  const r = spawnSync("icacls", [workspace], { encoding: "utf8" });
  const matches = (r.stdout ?? "").match(/S-1-4-\d+-\d+(-\d+)?/g) ?? [];
  return matches.length;
}

function probeLinux(): void {
  console.log("=== Linux/WSL2 · bwrap ===");
  const available = probeBwrap();
  assert(available, "bwrap 可用（probe 通过）", "bwrap --version 未通过 → 后端不可用（fail-closed）");
  if (available) {
    console.log("  完整写面 e2e 见 `npm test`（test/bwrap-e2e.spec.ts）");
  }
}

function probeWindows(): void {
  const scratch = mkdtempSync(join(tmpdir(), "pi-sandbox-dsh-probe-"));
  const workspace = join(scratch, "ws");
  const tempRoot = join(scratch, "tmp");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  const outsidePath = join(scratch, "outside.txt");
  writeFileSync(outsidePath, "outside\n", "utf8");
  const insidePath = join(workspace, "inside.txt");

  try {
    console.log("=== winacl · runner 能力探针 ===");
    const probe = spawnSync("node", [...NODE_FLAGS, RUNNER, "--probe"], { timeout: 120_000, encoding: "utf8" });
    assert(probe.status === 0, "runner --probe 返回 0（koffi/令牌/DACL/Job 能力齐备）",
      `${probe.status}: ${(probe.stderr ?? "").trim()}`);

    console.log("=== winacl · 残留私有 temp 目录的清扫（占用锁活体判定） ===");
    // 三种样本：死主残留（无锁 + 老 mtime）、太新无锁（不该动）、活体（真取锁并持有）。
    const staleDir = join(tempRoot, `${TEMP_DIR_PREFIX}stale-probe`);
    mkdirSync(staleDir, { recursive: true });
    const oldTime = new Date(Date.now() - STALE_WITHOUT_LOCK_MS - 60_000);
    utimesSync(staleDir, oldTime, oldTime);
    const freshDir = join(tempRoot, `${TEMP_DIR_PREFIX}fresh-probe`);
    mkdirSync(freshDir, { recursive: true });
    const liveTemp = createPrivateTempDir(win32Sync(), tempRoot);
    const sweepRun = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "read-only", "--",
      ...pwshCommand("$null = 1"),
    ]);
    assert(sweepRun.status === 0, "触发清扫的 confined 命令成功", `${sweepRun.status}: ${sweepRun.output.trim().slice(0, 200)}`);
    assert(existsSync(staleDir) === false, "死主残留（无锁 + 老 mtime）被清扫");
    assert(existsSync(freshDir), "无锁但新建的目录被保留（年龄门槛）");
    assert(existsSync(liveTemp.dir), "活体 runner 的私有目录被保留（锁被持有）");
    liveTemp.remove();
    rmSync(freshDir, { recursive: true, force: true });
    assert(existsSync(liveTemp.dir) === false, "收尾：活体样本已自行清理");

    console.log("=== winacl · read-only 往返 ===");
    const roWrite = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "read-only", "--",
      ...pwshCommand(`Set-Content -LiteralPath '${insidePath}' -Value ro -ErrorAction Stop`),
    ]);
    assert(roWrite.status !== 0, "read-only：写工作区被拒（非零退出）", `status=${String(roWrite.status)}`);
    assert(existsSync(insidePath) === false, "read-only：工作区文件确实未被创建");
    assert(/access to the path|access is denied|permission denied|operation not permitted/i.test(roWrite.output),
      "read-only：stderr 命中本后端 denial 方言", roWrite.output.trim().slice(0, 200));

    const roRead = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "read-only", "--",
      ...pwshCommand(`Get-Content -LiteralPath '${outsidePath}' -ErrorAction Stop | Out-Null`),
    ]);
    assert(roRead.status === 0, "read-only：读工作区外文件成功（读不受限）", roRead.output.trim().slice(0, 200));

    console.log("=== winacl · workspace-write 往返 ===");
    const wwScript = `Set-Content -LiteralPath '${insidePath}' -Value ww -ErrorAction Stop`;
    const wwWrite = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "workspace-write", "--",
      ...pwshCommand(wwScript),
    ]);
    assert(wwWrite.status === 0, "workspace-write：写工作区成功", `${wwWrite.status}: ${wwWrite.output.trim().slice(0, 200)}`);
    assert(existsSync(insidePath), "workspace-write：工作区文件确实落盘");

    const wwOutside = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "workspace-write", "--",
      ...pwshCommand(`Set-Content -LiteralPath '${outsidePath}' -Value escaped -ErrorAction Stop`),
    ]);
    assert(wwOutside.status !== 0, "workspace-write：写工作区外被拒（非零退出）", `status=${String(wwOutside.status)}`);

    console.log("=== winacl · 受限令牌下的 HTTPS（Schannel 机制级边界）===");
    if (!existsSync(SYSTEM_CURL)) {
      console.log(`  · 未找到 ${SYSTEM_CURL} → 跳过 TLS 断言`);
    } else {
      // 机制级已知边界（2026-09-20 真机实测）：WRITE_RESTRICTED 标志**本身**就让 Schannel 的
      // AcquireCredentialsHandle 报 SEC_E_NO_CREDENTIALS。拆解证据（同一脚本逐个改 CreateRestrictedToken 入参）：
      //   flags=0x5（DISABLE_MAX_PRIVILEGE|LUA，不带 WRITE_RESTRICTED）→ TLS 正常；
      //   flags=0xD + [logon SID, Everyone] → 凭据失败；
      //   flags=0xD + [logon SID, Everyone, **用户自己的 SID**] → 仍失败。
      // 即把「用户能写的都算能写」也救不回来 → 不是缺写 ACE，补文件/注册表白名单修不了
      // （实测旁证：给 CNG 密钥目录 %APPDATA%\Microsoft\Crypto\Keys（Schannel 落密钥容器的地方）
      //  按会话授予 create-only ACE 后，TLS 依旧失败；该改动用不上，已回退）。
      const sink = startLoopbackTlsSink();
      if (sink === undefined) {
        console.log("  · 本机汇监听未起来 → 跳过 Schannel 断言");
      } else {
        try {
          for (const mode of ["workspace-write", "read-only"] as const) {
            const tls = runRunner([
              "--workspace", workspace, "--temp", tempRoot, "--mode", mode, "--",
              SYSTEM_CURL, "-sS", "--noproxy", "*", "--max-time", "8", "-o", "NUL", "-w", "code=%{http_code}",
              `https://127.0.0.1:${String(sink.port)}/`,
            ]);
            assert(CREDENTIAL_FAILURE.test(tls.output),
              `${mode}：Schannel 不可用（机制级边界：WRITE_RESTRICTED 自身所致，非缺写授权）`,
              tls.output.trim().split(/\r?\n/u)[0]);
          }
        } finally {
          sink.stop();
        }
      }

      // 正向对照：自带 TLS 实现的栈（node/OpenSSL）在受限子进程内不受影响 —— 网络面确实未被约束。
      // 这一步需要外网；无外网/无代理时只报告，不判失败。
      const nodeTls = runRunner([
        "--workspace", workspace, "--temp", tempRoot, "--mode", "workspace-write", "--",
        process.execPath, "-e",
        "require('node:https').get('https://api.github.com/',r=>{console.log('NODE-TLS-OK',r.statusCode);process.exit(0)})"
          + ".on('error',e=>{console.log('NODE-TLS-ERR',e.code||e.message);process.exit(0)})",
      ]);
      const nodeCode = /NODE-TLS-OK (\d{3})/u.exec(nodeTls.output)?.[1];
      if (nodeCode === undefined) {
        console.log(`  · 非 Schannel 对照未取到结果（无外网/无代理）→ 仅报告：${nodeTls.output.trim().split(/\r?\n/u)[0]}`);
      } else {
        assert(/^[1-5]\d\d$/u.test(nodeCode),
          "workspace-write：非 Schannel 栈（node/OpenSSL）在受限子进程内可完成 HTTPS", `code=${nodeCode}`);
      }
    }

    console.log("=== winacl · 受限令牌下的 PowerShell 语言模式（已知边界，仅报告）===");
    const languageMode = runRunner([
      "--workspace", workspace, "--temp", tempRoot, "--mode", "read-only", "--",
      ...pwshCommand("$ExecutionContext.SessionState.LanguageMode"),
    ]);
    console.log(`  · pwsh LanguageMode = ${languageMode.output.trim()}（受限令牌下为 ConstrainedLanguage：.NET 方法调用被禁，纯 cmdlet/外部命令不受影响）`);

    console.log("=== winacl · grant 生命周期 ===");
    const acesAfter = countCapabilityAces(workspace);
    assert(acesAfter === 1, "工作区 standing ACE 幂等：两次 grant 后仅 1 条 capability ACE", `实际 ${acesAfter} 条`);
    const leftovers = readdirSync(tempRoot).filter((name) => isPrivateTempDirName(name));
    assert(leftovers.length === 0, "无残留私有 temp 目录（占用锁目录属设计内产物，不计）", leftovers.join(", "));

    console.log("=== winacl · read-only 不携带写能力 ===");
    const workspaceViaRo = countCapabilityAces(workspace);
    assert(workspaceViaRo === 1, "read-only 运行后工作区 ACE 保留但不生效（standing 缓存）", `实际 ${workspaceViaRo} 条`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(`=== pi-sandbox-dsh probe（platform=${process.platform}）===`);
if (winaclUsable()) {
  // winaclUsable 只判平台；argv 契约本身也顺带校验一次。
  const argv = buildWinaclRunnerArgv({ workspace: "C:\\ws", temp: "C:\\tmp", mode: "read-only", runnerEntry: RUNNER });
  assert(argv.length === 8 && argv[0] === "node", "runner argv 契约（read-only 8 段）", argv.join(" "));
  probeWindows();
} else {
  probeLinux();
}
console.log(`\n结果是: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
