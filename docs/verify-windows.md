# pi-sandbox-dsh · Windows（winacl）状态与验证指南

> **重要现状**：pi-sandbox-dsh 的 winacl 目前**只有结构**（`selectBackend("win32")→WinaclBackend`、`probe` 调 node runner、`buildWinaclRunnerArgv`、`workspaceWriteSid`/`tempWriteSid`、路径边界），**核心强制执行层尚未移植**：
> `winacl.ts` 的 `invokeRunner(...)` 目前抛 `"winacl runner not yet wired for local execution"`；
> `win32/runner.ts` / `token.ts` / `acl.ts` / `ffi.ts` / `grant.ts` / `spawn.ts` / `win32-abi.ts` / `AclSandbox` 均**未写入**。
> 因此本文件是"**移植清单 + 移植后 Windows 真机验证步骤**"，**不是**"已可用"的说明。

---

## 0. 目标机制（对齐 dsh）

Windows 用 **`WRITE_RESTRICTED` 受限令牌 + NTFS ACE 写白名单**，shell=`pwsh`（受限令牌 × git-bash 不兼容）。
- 令牌 restricting-SID 列表：read-only=`[logon SID, EVERYONE]`；workspace-write=加 `workspaceWriteSid` + `tempWriteSid`。
- 权限**两次检查**（普通 SID + restricting SID），只允许列表 SID 写。
- **读不受限**（网络同理，受限令牌不碰网络）。
- **enforcement = `partial`**（Everyone 保留 / NTFS 硬链接 / 同身份读限制）。
- koffi（原生 FFI）不能加载进 Bun 宿主 → 全部 Win32 逻辑在**独立 Node runner 子进程**执行。

---

## 1. 移植清单（Windows 强制层，单一源=dsh）

将 `~/projects/deepseek-harness/packages/sandbox/sandbox-windows-acl/src/` 的关键文件移植到 `pi-sandbox-dsh/packages/sandbox/src/win32/`：

| 文件 | 内容 | 备注 |
|---|---|---|
| `win32-abi.ts` | Win32 常量（token 权限 / SID / EXPLICIT_ACCESS / GRANT_MASK…） | 已有 dsh 源 |
| `ffi.ts` | koffi 绑定（CreateRestrictedToken / SetEntriesInAclW / SetNamedSecurityInfoW / ConvertStringSidToSidW / CreateFileW / LockFileEx…） | **依赖 dsh 的 `@deepseek-ai/dsh-win32-process` 基础绑定**（extendWin32ProcessBindings / Win32Error / allocPtrSlot / decodePtr…）；需内联或引入等价基础层 |
| `token.ts` | 受限令牌构建（openCurrentProcessToken / findLogonSid / makeWellKnownSid / createRestrictedToken / setTokenDefaultDaclGrant） | 已读 |
| `acl.ts` | grant/revoke capability SID（SetEntriesInAclW 合并 + 逐路径 LockFileEx 锁 + exact-ACE skip） | 已读 |
| `grant.ts` | `AclWriteGrant`（工作区 standing ACE 跨会话复用 / temp 可撤销） | 已读 |
| `path-boundary.ts` | temp 根/私有 temp 判空 | ✅ 已移植（`pi-sandbox-dsh` 的 `win32/path-boundary.ts`） |
| `workspace-sid.ts` | S-1-4-x-y / S-1-4-x-y-1 派生 | ✅ 已移植（纯函数，可测） |
| `spawn.ts` | spawnUnderToken / pipe 直通 / waitForExit / kill-on-close job | |
| `runner.ts` | argv-prefix wrapper（`--workspace/--temp/--mode/--write-sid/--temp-write-sid/--`） | 已读 |
| `index.ts` | `AclSandbox`（token + grant + spawn 组装；manageDacls 布尔） | 最大单文件 |

> 移植要点：`runner` 依赖 `AclSandbox`，`AclSandbox` 依赖 token/acl/ffi/spawn/grant/win32-abi，**整套必须一起移植**（无"只移植 runner"的切法）。`ffi.ts` 还依赖 dsh 的 `dsh-win32-process` 基础绑定层，需一并内联或引入等价物。

---

## 2. 移植后 · Windows 真机验证步骤

> 前置：Windows 宿主 + pwsh + Node + `koffi` 可加载（`npm install` 允许 koffi 构建脚本）。

### 2.1 后端 probe
```powershell
# 直接跑结构验证（win32 后端已接）
Set-Location C:\...\pi-sandbox-dsh
npm run typecheck   # strict
npm test            # 结构测试（selectBackend→winacl / probe / runner-argv / SID 派生）应过
```
预期：`selectBackend("win32")` → winacl；`probe()` 调 `node --experimental-strip-types win32/runner.ts --probe` 返回 0。

### 2.2 pwsh-under-token 往返（核心）
```powershell
# runner 在受限令牌下跑 pwsh；验证 read-only / workspace-write 往返
node --experimental-strip-types win32/runner.ts --workspace <ws> --temp <tmp> --mode read-only -- pwsh -c "Set-Content <ws>\x.txt hi"
```
- **read-only**：写被拒（`Access to the path ... is denied` / `permission denied`），读成功。
- **workspace-write**：工作区 + private-temp 内写成功；**工作区外写被拒**。
- **读不受限**：`read` / `Get-Content` 任意路径成功（**不藏读、无 deny-read**）。

### 2.3 dispose 撤销
- temp ACE 在 `dispose()` 撤销（不留持久 ACL 残渣）；工作区 standing ACE 保留（跨会话复用缓存）。

### 2.4 enforcement = partial 表现
- Everyone 保留（外部对象 grant Everyone 写仍可写）；NTFS 硬链接可别名（文档化差异）。进入 readonly/verify 经 notice 明示。

---

## 3. 已知边界（dsh 文档化，接受）

- **只限写**：读 / 网络 / 进程可见性**不**受令牌限制（`WRITE_RESTRICTED` 只交写）。
- **console isolation**：受限令牌下 share 宿主控制台（`CREATE_NO_WINDOW`/`CREATE_NEW_CONSOLE` 子进程 `STATUS_DLL_INIT_FAILED`）。
- **可写目录须 caller 拥有**（owner-implicit `WRITE_DAC`）。
- **Authenticated Users / INTERACTIVE / LOCAL 从两个列表剔除**（关 CIM/`C:\` 根树提权/Public 树写逃逸）；`whoami`/token 检查 cmdlet 在受限令牌下部分不可用。

---

## 4. 回归（Windows）

```powershell
npm run typecheck
npm test
npm run probe   # winacl pwsh-under-token + read-only 往返 + dispose 撤销（需实现 probe 真机断言）
```

---

## 5. 与 Linux 侧对齐

- Linux=`bwrap`（`--ro-bind / /` + 按档 `--bind` 工作区 / `--tmpfs /tmp`），无 `--unshare-net`、无凭据掩码。
- Windows=`winacl`（受限令牌 + NTFS ACE），读/网络同样不受限。
- **两条正交轴**：平台轴（bwrap / winacl）× 能力轴（shell 走 OS 沙箱 / write-edit 走 `isPathUnder` 围栏）。读两种平台都全开。
