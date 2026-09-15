# pi-sandbox-dsh · Windows（winacl）移植与真机验证

> **现状**：winacl 强制层**已移植并在 Windows 真机验证通过**（Windows 11 build 26200 + Node v22.23.2 + pwsh）。
> 本文 = 文件地图 + 宿主/runner 契约 + 真机证据 + 已知边界 + 回归步骤。
> 单一源 = dsh `packages/sandbox/sandbox-windows-acl`（锚点 `0d1f50007f`）⊕ `packages/subprocess/win32-process`（基础绑定层，已内联）。

---

## 0. 目标机制（对齐 dsh）

Windows 用 **`WRITE_RESTRICTED` 受限令牌 + NTFS ACE 写白名单**，shell=`pwsh`（受限令牌 × git-bash 不兼容）。
- 令牌 restricting-SID 列表：read-only=`[logon SID, EVERYONE]`；workspace-write=加 `workspaceWriteSid` + `tempWriteSid`。
- 权限**两次检查**（普通 SID + restricting SID），只允许列表 SID 写。
- **读不受限**（网络同理，受限令牌不碰网络）。
- **enforcement = `partial`**（Everyone 保留 / NTFS 硬链接 / 同身份读限制）。
- koffi（原生 FFI）不能加载进 Bun 宿主 → 全部 Win32 逻辑在**独立 Node runner 子进程**执行。

---

## 1. 文件地图（`packages/sandbox/src/win32/`）

| 文件 | 内容 | 单一源 |
|---|---|---|
| `abi.ts` | 通用 Win32 进程/管道/Job 常量 | dsh `win32-process/abi.ts` |
| `errors.ts` | `Win32Error`（API 名 + 精确错误码） | dsh `win32-process/errors.ts` |
| `koffi.ts` | koffi 惰性加载（失败不缓存） | dsh `dsh-lazy-require`（内联） |
| `ffi.ts` | **合并后**的绑定表（通用进程 ⊕ 令牌/ACE）+ 指针/结构辅助 | dsh 两张 `ffi.ts` 合并，去掉 `extendWin32ProcessBindings` 分层 |
| `process.ts` | `CreateProcessAsUserW` 两种 stdio 形态、kill-on-close Job、管道排空、退出等待、能力探针 | dsh `win32-process/process.ts`（裁剪掉当前令牌 spawn 与 control-stdio） |
| `win32-abi.ts` | ACL/token 专用常量 | dsh `sandbox-windows-acl/win32-abi.ts` |
| `token.ts` | 受限令牌构建（logon SID / well-known SID / `CreateRestrictedToken` / 默认 DACL grant） | 同源逐项 |
| `acl.ts` | DACL 读写：`SetEntriesInAclW` + `SetNamedSecurityInfoW`，per-path `LockFileEx` 串行化，exact-ACE 跳过 | 同源逐项（锁目录名改 `pi-sandbox-dsh-acl-locks`） |
| `grant.ts` | `AclWriteGrant`（standing/revocable 区分） | 同源逐项 |
| `spawn.ts` | 受限令牌 spawn 适配 | 同源（去掉 control-pipe） |
| `acl-sandbox.ts` | `AclSandbox`（token + grant + spawn 组装，`manageDacls` 布尔） | dsh `sandbox-windows-acl/index.ts` |
| `runner.ts` | argv-prefix 包装器（**pi 侧新增 `--probe`**；去掉 control-pipe） | dsh `sandbox-windows-acl/runner.ts` |
| `runner-contract.ts` | `winaclUsable` + `buildWinaclRunnerArgv`（**纯函数，宿主专用**，避免宿主 import 到 FFI 图） | pi 侧结构契约 |
| `temp-sweep.ts` | 残留私有 temp 目录的清扫策略（**纯逻辑 + 注入式活体判定**，可跨平台单测） | pi 侧新增（宿主 kill 的补偿） |
| `temp-lock.ts` | 占用锁（`CreateFileW` 不共享 delete + `LockFileEx`）与私有目录创建（**先取锁再建目录**） | pi 侧新增（死主/活体判定） |
| `path-boundary.ts` / `workspace-sid.ts` | 路径边界 / SID 派生（原有，未改） | 同源逐项 |
| `../probe.ts` | `npm run probe` 真机探针（**pi 侧新增**） | pi 侧 |

**宿主（Bun）与原生层彻底隔离**：宿主只 import `runner-contract.ts`（纯函数）与 `winacl.ts`（spawn 驱动），FFI 图只在 Node runner 子进程里被真正执行。

---

## 2. 宿主 ↔ runner 契约

```
[node, runner.ts, '--workspace', <dir>, '--temp', <dir>, '--mode', <read-only|workspace-write>,
 ['--write-sid', <S-1-4-…>, '--temp-write-sid', <S-1-4-…>], '--', <argv...>]
[node, runner.ts, '--probe']
```

- **grant 归属**：pi 宿主不能物化 ACE（Bun 不能加载 koffi）→ 宿主**从不**传 `--write-sid`/`--temp-write-sid`，
  runner 走 **standalone 流程**：自行派生工作区 SID → 在 `--temp` 下建随机私有目录并派生 temp SID →
  授予两项 ACE（工作区 grant 幂等，exact-ACE 命中即跳过整树重传播）→ 子进程退出后撤销 temp ACE 并删目录
  （工作区 ACE 保留 = dsh 的 standing reuse cache）。seam-managed 分支保留以对齐 dsh 契约（pi 暂不使用）。
- **失败契约**：runner 侧任何失败打印 `windows-acl-run: <detail>` 并退出 `127`（`WINACL_RUNNER_FAILURE_EXIT`），
  宿主 `RUNNER_FAILURE_RULES.winacl` 据此判 runner 失败 → `SANDBOX_UNAVAILABLE`，**绝不**降级裸跑。
- **残留清扫**：每次 runner 调用开头先扫 `--temp` 下的 `pi-sandbox-dsh-*`：有锁文件 → 非阻塞取锁（拿得到=死主→删；
  `ERROR_LOCK_VIOLATION`=活体→留）；无锁文件 → 仅当 mtime 早于 5 min 才删。锁目录 `pi-sandbox-dsh-locks/` 常驻。
  清扫只告警，不算 runner 失败（退出码仍为子进程退出码）。
- **probe**：宿主扩展装配时同步 `spawnSync('node', [...runner, '--probe'])`，非零 → 后端不可用（fail-closed，不注册 shell 工具）。
  `--probe` 只做能力探针（koffi 绑定 / 当前令牌 / 受限令牌 / 默认 DACL / kill-on-close Job），不拉起子进程（装配期要快）。

---

## 3. 真机验证结果（本机 Windows 11 26200 / Node v22.23.2）

```powershell
npm run typecheck   # strict，三 workspace 全过
npm test            # 52 / 10 / 17 / 23 / 15 / 20 passed，0 failed（bwrap e2e 在 Windows 跳过）
npm run probe       # 12 passed, 0 failed
```

`npm run probe` 覆盖并实测通过：

| 检查 | 结果 |
|---|---|
| runner `--probe`（koffi/令牌/DACL/Job 能力齐备） | 返回 0 |
| read-only：写工作区 | 被拒（非零退出 + stderr 命中 `access to the path` 方言），文件确实未创建 |
| read-only：读工作区外 | 成功（读不受限） |
| workspace-write：写工作区 | 成功落盘 |
| workspace-write：写工作区外 | 被拒 |
| grant 生命周期 | 两次 grant 后工作区仅 **1 条** capability ACE（幂等）；runner 私有 temp 无残留（锁目录不计）|
| 残留清扫 | 无锁+老 mtime 的目录被删；无锁但新建的保留；**真持锁**的活体目录保留（跨进程锁判定）|
| read-only 不带写能力 | 工作区 standing ACE 保留但不生效 |

`packages/core/test/load.spec.ts` 另有**结果侧分类端到端**：用 mock pi 装配扩展 → 注册的 powershell 工具真跑一条
confined 命令 → workspace-write 内写成功、外写拿到 `[sandbox: file access denied under workspace-write mode]` +
切档提示（denial 骑在真实 `.NET` 拒写文案上）。**17 passed, 0 failed**。

**开销实测**（同一台机器，`Write-Output hi` 往返）：

| 路径 | 耗时 |
|---|---|
| 裸 pwsh（`-NoProfile -NonInteractive -Command`） | ~0.25 s |
| confined read-only（含 Node runner 启动 + 令牌 + 默认 DACL + Job） | ~0.34 s |
| confined workspace-write（+ 私有 temp 目录 + temp grant/revoke） | ~0.33 s |
| runner `--probe`（装配期一次性） | ~0.10 s |

→ 每命令净开销 ≈ **80–100 ms**（Node 启动 + 令牌构建 + ACE 操作）。

---

## 4. 已知边界（真机观察 + dsh 文档化，接受）

- **只在写面**：读 / 网络 / 进程可见性**不**受令牌限制（`WRITE_RESTRICTED` 只交写）。
- **enforcement = partial**：Everyone 保留 / NTFS 硬链接可别名 / 同身份读限制（dsh 文档化差异）。
- **pwsh 运行在 ConstrainedLanguage**（受限令牌下 PowerShell 的既定行为，真机实测 `LanguageMode = ConstrainedLanguage`）：
  .NET 方法调用（`[Console]::…`、`$obj.GetType()` 等）被禁，纯 cmdlet 与外部命令不受影响。
  → 模型在 Windows 沙箱档下的 PowerShell 表达力弱于 unconfined，属于机制固有代价（已在本文件与 DESIGN 记录）。
- **console isolation 不可用**：受限令牌下 `CREATE_NO_WINDOW`/`CREATE_NEW_CONSOLE` 子进程 `STATUS_DLL_INIT_FAILED`，子进程共享宿主控制台。
- **可写目录须 caller 拥有**（owner-implicit `WRITE_DAC`）。
- **Authenticated Users / INTERACTIVE / LOCAL 从两个列表剔除**（关 CIM/`C:\` 根树提权/Public 树写逃逸）；
  `whoami`/token 检查 cmdlet 在受限令牌下部分不可用。
- **每命令一个 runner 子进程**：宿主不能持有 grant 生命周期（Bun 不能加载 koffi），故 temp grant 的物化/撤销是按次
  进行的；工作区 ACE 因幂等跳过而无重复成本。代价是 ~80–100 ms 固定开销，换来宿主零原生依赖。
- **超时/中止会绕过清理，由下次调用补偿**：宿主 kill runner 时其 `finally` 不执行，会在 `%TEMP%` 留下一个
  `pi-sandbox-dsh-*` 目录及其 ACE（工作区 ACE 本就 standing，不受影响）；下一次任一档位的 runner 调用会清扫它
  （占用锁判定死主/活体；无锁残留需 5 min 年龄门槛）。`%TEMP%/pi-sandbox-dsh-locks/` 是常驻锁目录。
- **前置**：需要 PATH 里的系统 `node`（Bun 宿主不能跑 runner）；`koffi` 为 optionalDependency，随 `npm install` 落地，缺失时 `--probe` 非零 → 后端不可用。
- **装配期探测失败现在会显式告知**（不再是静默降级）：不注册受限 shell 工具 + `session_start` 发一条 error 通知
  （英文，说明“壳未收敛”与修复方向）+ 徽标追加 `(no backend)`（对齐 DESIGN 不变量 10）。

---

## 5. 回归（Windows）

```powershell
npm run typecheck
npm test            # 结构 + 分类 + 清扫策略 + mock pi 装配端到端 + 后端不可用可见化
npm run probe       # 真机：runner capability + 残留清扫 + read-only/workspace-write 往返 + grant 生命周期
```

失败排查顺序：`node --experimental-strip-types packages/sandbox/src/win32/runner.ts --probe`（原生能力）
→ 直接跑一次 runner 写工作区（ACE/令牌）→ `icacls <dir>` 看 capability ACE 是否落地（`S-1-4-…` 形式）。

> 清理误授 ACE：`icacls` 的 `/remove:g` 对这类 capability SID 不生效（实测），
> 用 `revokeWrite()`（`win32/acl.ts`）或 `icacls <dir> /reset`（仅当该目录无其它显式 ACE 时）。

---

## 6. 与 Linux 侧对齐

- Linux=`bwrap`（`--ro-bind / /` + 按档 `--bind` 工作区 / `--tmpfs /tmp`），无 `--unshare-net`、无凭据掩码。
- Windows=`winacl`（受限令牌 + NTFS ACE），读/网络同样不受限。
- **两条正交轴**：平台轴（bwrap / winacl）× 能力轴（shell 走 OS 沙箱 / write-edit 走 `isPathUnder` 围栏）。读两种平台都全开。
