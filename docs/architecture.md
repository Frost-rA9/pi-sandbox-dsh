# pi-sandbox-dsh · 架构（精简）

> 用 **OS 边界**约束模型的**写**面：连续 agent + 全局档位 + 逐级批准。读全开、网络不掺和、无命令白名单。
> 单一参考源 = dsh `packages/sandbox/{sandbox,sandbox-local,sandbox-policy}` + `sandbox-windows-acl`
> （Windows 层另内联 dsh `packages/subprocess/win32-process`）；锚点 `ddefc45fbc`。
> 行为约束见 `AGENTS.md`（本地文件、不入库）；不变量、已知取舍与验证入口见本文。

## pi 机制映射

| 需求 | pi 原生机制 |
|---|---|
| 壳命令收敛 | `createBashTool` + `spawnHook`（bwrap 包 argv）／`createPowerShellTool` + `operations`（winacl 走 Node runner） |
| 文件写面门控 | `tool_call` 门控（write/edit；被拒 → `ui.select` 征求"允许本次"） |
| 未接管的同类壳 | 平台态工具表收敛（win32 摘 `bash`，`setActiveTools`）+ `tool_call` 门控兜底 |
| 档位持久状态 | `appendEntry('sandbox-mode')` + `getEntries()` 折叠（禁内存真源） |
| 档位提示段 | `before_agent_start` 追加（≤ ~100 tok；档位不变时字节不变） |
| 徽标 / 告知 | `ui.setStatus` + `ui.notify`（英文文案） |

## 结构

| 块 | 职责 | 实现 |
|---|---|---|
| core | 扩展宿主：档位折叠、受限壳注册与门控、文件门控、`/sandbox`、fail-closed 可见化 | `packages/core/src/{index,state,tools-fs,tools-shell}.ts` |
| bridge | 纯函数/类型：档位阶梯、严格更宽、denial/hint 标记、结果侧分类、fail-closed 词汇 | `packages/bridge/src/index.ts` |
| sandbox | OS 写面沙箱库：bwrap（Linux/WSL2）／winacl（Windows）；后端事实 + 分类包装 | `packages/sandbox/src/{backend,bwrap,winacl,classify,probe}.ts`、`win32/*` |

## 关键语义

- **三档严格更宽**：`read-only` → `workspace-write` → `danger-full-access`；切档需用户确认；文件工具被拒可"允许本次"（per-call）。
  阶梯规则（对齐 dsh `escalation.ts`，锚点 `ddefc45fbc`）：**重复当前生效档 = 免批准**（不属于升级）；更宽 = 需批准且仅作用于该次调用；更窄或非法目标 = 执行前失败。
- **壳缝恒在位**：受限壳**恒注册**；后端不可用 → **调用点**抛 `SANDBOX_UNAVAILABLE`（绝不裸跑）；`danger-full-access` 才委托 pi 本地 shell。`probe()` 只出可见性（通知/徽标），不决定"有没有壳"。
- **未接管的同类壳：平台态收敛 + 门控兜底**：pi 默认活跃壳名是 `bash`；Windows 受限壳只能叫 `powershell`（受限令牌 × git-bash 不兼容）→ 按 dsh「one shell stack per host」把 `bash` 从**模型工具表**里摘掉（平台态、与档位无关；`danger-full-access` 也不还回来 —— danger 只是"不约束"，不是"多一个壳"）。`tool_call` 门控保留为**兜底**：别的扩展（「记基线→还原」惯用法）/ `--tools` / `defaultTools` 把名字塞回来时，confined 档仍在调用点拦下。Linux 受限壳即 `bash`，同名覆盖完整，无需 roster 处理。
- **结果侧分类**：runner 失败（exit 门 + 致命签名）**优先于** denial → `SANDBOX_UNAVAILABLE`；denial = 非零退出 + 本后端方言（不取跨后端并集）；`danger` 无事实不判定；分类窗口取输出尾部 64 KiB。
- **winacl 细节**：`WRITE_RESTRICTED` 令牌 + NTFS ACE 写白名单；runner 子进程（宿主 Bun 不能加载 koffi）；standalone grant（工作区 ACE 幂等 standing、temp 按次授予/撤销）；残留清扫（占用锁判死主）；Node 解析 `PI_SANDBOX_NODE` → `PATH` → 注册表 `Path`。

## 不变量（回退先改这里）

1. **管写面不管读面**；凭据靠"写面 + 网络出口"，不靠藏读。**写面之外的一切必须由断言证明不受影响**——受限令牌的副作用会外溢到
   写面之外（见「已知取舍」的 Schannel 条），因此**每条不变量/边界声明都要有一条可执行断言**（`npm run probe` 的「HTTPS」节就是补上的那条；
   此前的"网络不掺和"只是散文，于是缺口静默存活）。
2. **档位 = 全局持续状态**，不与阶段绑定、无子档。
3. **批准 = 逐级升级（严格更宽）**，不是每命令弹窗、不是命令白名单；重复当前档位不构成批准（dsh `ddefc45fbc` 语义）。
4. **缝恒在位、不可用即拒**（`SANDBOX_UNAVAILABLE`，绝不裸跑）；未接管的同类壳**既不激活也不可调用**（win32 全程 pwsh，dsh「one shell stack per host」）。
5. 批准不进模型上下文；文件批准 per-call（布尔「允许本次」，不改档位），壳升级走全局 `/sandbox`。
6. 状态 = 日志折叠，禁内存真源。
7. 最小暴露面。
8. 切换/升级/不可用告知 = 通知机制（英文文案）。
9. 结果侧分类 = **事实判定**（runner 失败优先于 denial；denial 需非零退出 + 本后端方言；danger 不判定）。
10. **后端不可用必须可见**（不假收敛）：工具面不变 + error 通知 + 徽标 `(no backend)` + 文件拒绝文案标注"档位策略拒绝"。

## 已知取舍 / 边界

- 不做命令白名单；不做 plan/build 双模式；不隐藏读；`danger-full-access` 也要用户确认。
- winacl `enforcement=partial`（Everyone / NTFS 硬链接 / 同身份读）；pwsh 语言模式**按档位不同（实测，同一条 runner 契约）**：`read-only` → `ConstrainedLanguage`（AppLocker 探测要写临时文件而被拒）；`workspace-write` → `FullLanguage`（私有 temp 让探测完成；同一次运行里区外写仍被拒，证明令牌确实受限）。
- **受限令牌下 git-bash（MSYS2）起不来**（read-only 与 workspace-write 两档实测同错）：`usr\bin\{bash,sh,ls,uname,cygpath}.exe` 全部在 DLL 初始化阶段死于 `couldn't create signal pipe, Win32 error 5`（exit `0xC0000142`），而同版本**原生** `git.exe`/`node`/`cmd`/`pwsh` 正常。机制 = 受限令牌写访问的**第二轮（限制 SID）检查** + **命名管道 open 被拒**（对齐 dsh 已知限制：匿名管道 OK、命名管道 open 被拒 → piped stdio 子进程 EPERM；实测 `spawnSync` piped = EPERM / inherit = OK）。故 win32 上模型面**只有 pwsh**（`bash` 由 `setActiveTools` 摘除，门控兜底）；想换回 bash 栈 = 不挂本扩展 / 自行 `defaultTools`（门控仍会在 confined 档拦下 —— 兜底不依赖 roster）；`!`（user_bash）仍是用户自己的 git-bash。
- **受限令牌下 Schannel TLS 不可用（机制级，非缺授权）**：受限壳里 `curl`/`git https`/`Invoke-WebRequest` 等**一切走 Windows 原生 TLS 栈（Schannel/WinHTTP）**的 HTTPS 全部失败，报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030E)`（实测：经 HTTP 代理时 CONNECT 隧道建成后立即报此错；直连时若 TCP 都连不上则更早失败，所以断言必须自带一个“连得上”的对端）。而**自带 TLS 实现**的栈（OpenSSL/Go/rustls/OpenSSH：`node`/`python`/`gh`/`ssh`/`git`+SSH）完全不受影响，纯 HTTP 也不受影响。
  根因 = `WRITE_RESTRICTED` 标志**自身**，与 restricting 列表无关（2026-09-20 真机把 `CreateRestrictedToken` 入参逐个拆解）：`flags=0x5`（`DISABLE_MAX_PRIVILEGE|LUA_TOKEN`，不带 `WRITE_RESTRICTED`）→ TLS 正常；加 `WRITE_RESTRICTED` 后，即便把**用户自己的 SID** 放进 restricting 列表（= 凡用户可写即视为可写）也照样失败 → **补文件/注册表白名单修不了**（旁证：给 Schannel 落密钥容器的 `%APPDATA%\Microsoft\Crypto\Keys` 按会话授 create-only ACE 后，TLS 依旧失败；该改动用不上、已回退）。同族还有：受限令牌下 **HKCU 注册表写被拒**（实测 `reg add` → `Access is denied`，不受限对照成功）。
  出口 = 受限壳内改用非 Schannel 客户端（`gh` / `python` / `node` / `git`+SSH / 纯 HTTP 的 `curl`），或临时 `danger-full-access`。`npm run probe` 的「HTTPS」节把这条钉住（两档都断言凭据失败 + 非 Schannel 对照必须通）。
- **不做 dsh 的 `STARTF_USESHOWWINDOW | SW_HIDE`**（`subprocess/win32-process` 用它给**无 console 的宿主**（GUI/desktop）隐藏新建的 console）：该 flag 只决定**新建** console 的初始可见性，而 pi 恒有宿主 console（TUI 必然挂在终端上），受限子进程只会**继承**、从不新建窗口 → 这条路径在 pi 里**不可达**（属死代码）；且它对**继承**窗口是否有副作用未经验证（若真会隐藏宿主窗口，则是灾难性回归），故不采用。将来若 pi 真有无 console 的宿主，再按参考源补上并做真机验证。
- winacl 每命令一个 runner 子进程（净开销 ~80–100 ms）；宿主 kill 会留私有 temp 目录，由下次调用清扫。
- 测试与 probe 需在**未受限**宿主里跑：宿主自己被受限时 `where`（pi 解析 pwsh 用 `spawnSync` + 管道）与 runner 的管道 stdio 都会 EPERM（实测）。
- pi 的 `before_agent_start` 每用户轮只跑一次 → 同轮内切档后提示段滞后一轮（由 notice 补偿）。
- 分类窗口有界（64 KiB）；`user_bash`（`!`）与 RPC `bash` 不在约束内（边界声明）。
- 后端不可用时 confined 档**没有可用壳**（fail-closed 的代价；出口 = 修后端或显式 `danger-full-access`）。

## 验证

- `npm run typecheck`（strict）
- `npm test`：bridge 纯函数 / bwrap / winacl 契约 / 结果侧分类 / 清扫策略 / Node 解析 / **平台态壳栈收敛** / core 装配与两条门控 / 不可用可见化
  （winacl 端到端与 `probe` 需在**未受限**宿主里跑，见上方已知取舍）
- `npm run probe`（真机）：bwrap，或 winacl 往返（read-only 写被拒、workspace-write 区内可写区外被拒、ACE 幂等、temp 无残留、清扫）
  + **HTTPS/Schannel 边界**（本机明文汇监听 → 两档都断言凭据失败；非 Schannel 栈对照必须通）
- 真机会话核查（pi SDK，不调模型）：`createAgentSession({ resourceLoader, sessionManager })` 后**必须** `await session.bindExtensions({})`
  —— `session_start` 是在 `bindExtensions` 里发出的（SDK 路径不会自动发），否则扩展根本没跑；随后 `session.getActiveToolNames()`
  应得 `read, edit, write, powershell`（win32，四档一致；`danger-full-access` 也不把 `bash` 还回来）。
  实测（2026-09-16，win32）：default / read-only / workspace-write / danger-full-access 四种折叠结果都是该集合。
