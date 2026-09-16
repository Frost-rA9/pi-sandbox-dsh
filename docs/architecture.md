# pi-sandbox-dsh · 技术设计（dsh 单源，完整复现）

> 配套：根 `AGENTS.md`（本地设计依据，gitignored）；本文为可入库的架构/设计说明。
> 参考源：**dsh**（`deepseek-harness`）@ `~/projects/deepseek-harness`，HEAD `0d1f50007f`（`0.1.6-alpha.1`；上一轮锚点为 `5dda764`）。
> 本文把 dsh 沙箱**全链路**（tool 层 → executor → provider → policy → escalation → 渲染 → 后端）逐一映射到 pi 扩展 API，并用**三段式判定门**（pi 原生 → dsh 语义 → pi 裁剪）给出每条功能的落地。

---

## 0. dsh 沙箱全链路（源码实证）

```
tool-bash (模型面)            sandbox-policy                escalation.ts
  ├ 加 sandbox_permissions      ├ resolve():               ├ WIDER_MODES
  │   + justification 参数      │   explicit > session     ├ approveEscalation
  ├ approveBashEscalation ────► │   > default              ├ sandboxDenialMarker /
  ├ resolveSandboxPolicy        ├ session sandbox/mode     │   escalationHintMarker
  └ render (denial+hint)        │  → sys prompt 段         └ validateEscalationArgs
        │
        ▼
bash-sandbox (executor)         sandbox-local (provider)
  ├ run/start: confine()         ├ selectRunner: platform chain
  ├ classifyDenial/              │   linux: bwrap→landlock; win32: windows-acl
  │   classifyRunnerFailure     ├ confine() → 包装 argv
  └ result.sandbox{denied,       └ ACL grants (win): standing workspace
      enforcement, runnerFailed}     + revocable session temp
        │
        ▼
后端: bwrap(--ro-bind / / + 按档 --bind 工作区 / tmpfs /tmp)
      winacl(WRITE_RESTRICTED token + NTFS ACE capability SID)
```

## 1. 模型面 tool（`@deepseek-ai/dsh-tool-bash`）

### dsh 语义
- `parameters` 仅在存在沙箱 executor 时追加：
  ```ts
  sandbox_permissions: { type:'string', enum: ESCALATION_TARGETS }  // ['workspace-write','danger-full-access']
  justification: { type:'string' }  // 与 sandbox_permissions 必须同带、非空句
  ```
- `description` 加入升级指引：denied → 同一回合用 `sandbox_permissions + justification` 重试精确同一条命令；不绕道聊天；拒绝即定论。
- `execute`：先 `resolveSandboxPolicy`（session 模式 > 默认）；若带升级参数 → `approveBashEscalation` → `approveEscalation`（严格更宽 + 审批）→ 得到 approved mode → **只对本次调用**以更宽 policy 执行。
- `output.render`：denied 时在结果末尾追加 `[sandbox: file access denied under <mode> mode]` + `[sandbox: escalation available — retry …]`。

### 三段式 → pi 落地
| 维度 | pi 原生 | dsh 语义 | pi 裁剪（门控驱动） |
|---|---|---|---|
| 升级参数 | `tool_call` 门控 + `ctx.ui.select` | 工具带 `sandbox_permissions`+`justification` | **不 fork 工具**：文件工具被拒即征求用户批准；bash 升级走 `/sandbox <mode>`（更宽档确认） |
| 批准 | `ctx.ui.select` | `approveEscalation`（严格更宽） | `ctx.ui.select` + 严格更宽校验（`/sandbox`） |
| denial 渲染 | 门控 block + reason | 结果尾部 `[sandbox…]` 标记 | 门控拒绝的 block reason 带 denial+hint |
| 只作用于本次调用 | — | allowed-once → per-call wider | 文件工具：门控放行仅本次；bash：`/sandbox` 全局持久档 |

> 说明：pi 的 `spawnHook` 是同步、只读全局 policy，无法把"本次调用批准的更宽档"传进去，故 bash 不做逐命令升级（避免命令白名单启发式）；升级收敛到全局 `/sandbox`。

**实现要点（门控驱动，不重注册工具）**：
- bash：`createBashTool(workspaceRoot, toolOptions)` 直接注册（`spawnHook` 收敛到全局档）；升级走 `/sandbox <mode>`（更宽档 `ctx.ui.select` 确认）。
- write/edit：`tool_call` 门控 `classifyFileWrite`（`isPathUnder` 围栏）→ 被拒 `ctx.ui.select` 征求"允许本次" → 放行仅本次；拒绝 → block(denial+hint)。
- 全部审批在**门控/命令**处（用户决策点），无一工具 schema 分支。

## 2. executor 层（`@deepseek-ai/dsh-bash-sandbox`）
- `run/start`：`danger-full-access` → 原样执行；否则 `confine(['bash','-c',cmd], policy)`（provider 包装 argv）。
- 分类：`classifyRunnerFailure`（runner 自身失败 → 抛 `SandboxUnavailableError`；命令没跑起来，**不算 denial**）、`classifyDenial`（非零退出 + 本后端方言 → `denied:true`）、`enforcement`。
- 结果携带 `sandbox: { mode, denied, enforcement, runnerFailed }`。

**三段式 → pi**：pi 在 `createBashTool` 的 `spawnHook` 里改**命令字符串**（`bwrap <profile> -- sh -c '<cmd>'`）；winacl 走 `operations.exec`（其 danger 档回落到本地 pwsh operations）。pi 的 `spawnHook` 由工具先跑、再把 `command/cwd/env` 交给 `operations.exec`，**两者可共存** → 结果侧分类就挂在 `operations.exec` 上（`packages/sandbox/src/classify.ts`：`createConfinedOperations`），**不新增 executor、不 fork 工具**。

与 dsh 的已知差异（见 `DESIGN.md` §七）：
- dsh 的 `confine(argv, policy, signal): Promise` 是 async + 可取消；pi 的 `spawnHook` 同步，故不移植取消协议，预备（winacl 令牌/ACE）只能在 `operations.exec` 内自己做。
- dsh 自己持有完整 stderr；pi 只有 `onData` 流 → 分类窗口有界（尾部 64 KiB）。
- dsh 声称 `denied` 事实而不改文本；pi 把 denial 标记**追加进模型可见输出**（pi 的 `BashToolDetails` 无 `stderr/exitCode` 字段，无别的结构化出口）。

## 3. provider 层（`@deepseek-ai/dsh-sandbox-local`）
- `PLATFORM_CHAINS = { linux:['bwrap','landlock'], darwin:['seatbelt'], win32:['windows-acl'] }`。
- `confine(argv, policy, signal?)` → 选 runner + profile → 返回 `ConfinedArgv`（argv + `enforcement` + `denialSignatures` + `runnerFailureRules`）。
- platform 无可用 runner → `SandboxUnavailableError`（fail-closed）。
- ACL grant 生命周期（win）：工作区 SID 确定性、ACE **stand（跨会话复用缓存，exact-ACE skip O(1)）**；每会话**随机 temp 目录 + SID**，dispose 撤销；provider dispose 清 temp、保工作区站台 ACE。

**三段式 → pi**：`selectBackend()`（bwrap/winacl）+ `probe()`；`createBashTool` spawnHook 用 bwrapProfile（argv 包装）+ `operations`（结果侧分类），`createPowerShellTool` operations 用 winacl Node runner + 同一分类包装。**provider 承载 grant 生命周期**（winacl 由 Node runner 子进程承载，Bun 宿主不 load koffi）；后端只声明**自己的** denial 方言与 runner 失败规则（不用跨后端并集）。

## 4. policy 层（`@deepseek-ai/dsh-sandbox-policy`）
- `resolve({session, mode})`：`mode`（显式批准）> 会话最近 `sandbox/mode` 事件 > 部署默认；`workspaceRoot` = 会话 cwd > 配置 root。返回 `SandboxExecutionPolicy`（含 `sessionId`）。
- 会话 override 以**日志事件**持久化（`sandbox/mode`），折回 session-projection。
- 注入系统提示段 `sandbox:policy`：按 mode 渲染对模型的指引（read-only / workspace-write / danger-full-access 各自文案）。

**三段式 → pi**：
- 全局档 = `appendEntry` 折叠（日志真源，不建内存镜像）。默认 `read-only`（fail-safe）。
- 提供 `/sandbox <mode>` 命令 + `session_start` 恢复；persist 走 appendEntry（不建内存真源，不变量 6）。
- `before_agent_start` 注入 **当前档位 + 升级规则** 系统提示段（不变量 8）。

## 5. escalation 词表（`@deepseek-ai/dsh-sandbox/escalation.ts`）
```ts
WIDER_MODES = { 'read-only':['workspace-write','danger-full-access'], 'workspace-write':['danger-full-access'] }
approveEscalation(req, approval):
   1. requested ∈ WIDER_MODES[effective] ?（否则抛错，不弹窗）
   2. approver/agent 缺失 → fail-closed
   3. approver.request({ reason: `escalate sandbox to ${mode}: ${justification}`, ... })
   4. allowed-once→mode / rejected/cancelled/unavailable→抛文本
sandboxDenialMarker(mode) = `[sandbox: file access denied under ${mode} mode]`
escalationHintMarker(subject) = `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (…) + justification; …]`
validateEscalationArgs(sp, j) = 必须同带 + j 非空句
```
**三段式 → pi**：纯函数原样落地（bridge 包）。`approveEscalation` 的 `approver` 换 `ctx.ui.select`；`subject='command'`。

## 6. 后端（bwrap / winacl）

### 6.1 Linux/WSL2 bwrap（`profiles.ts`）
```ts
['--ro-bind','/','/','--dev','/dev','--unshare-pid','--proc','/proc','--die-with-parent']
workspace-write 追加: ['--tmpfs','/tmp','--bind', workspaceRoot, workspaceRoot]
```
- read-only：整树只读可读，无写挂载 → 写全拒、读全开。
- workspace-write：工作区 + `/tmp` 可写，其余只读。
- **无 `--unshare-net`、无敏感路径掩码**（读全开、网络共享）。
- 第 2 候选 landlock 仅作 bwrap 不可用时的后备。

### 6.2 Windows winacl（`sandbox-windows-acl`）
- **受限令牌**：`CreateRestrictedToken(WRITE_RESTRICTED|LUA_TOKEN|DISABLE_MAX_PRIVILEGE)` + restricting-SID 列表；read-only=`[logon SID, EVERYONE]`，workspace-write=加 workspace SID + temp SID；剔除 Authenticated Users / INTERACTIVE / LOCAL（防 CIM、`C:\` 根树、Public 树逃逸）。
- **NTFS ACE 写白名单**：工作区确定性 SID（`workspaceWriteSid`）+ 每会话随机 temp SID（`tempWriteSid`）；Windows 权限**两次检查**（普通 SID + restricting SID），只允许列表 SID 写。
- **runner 子进程**（`runner.ts`）：`[node, runner, --workspace, d, --temp, d, --mode, m, [--write-sid, ...], '--', cmd]`；stdin/stdout 直通、镜像退出码、改写 TMP/TEMP 到 private-temp、退出撤 temp grant；失败→`windows-acl-run:`+exit 127，绝不裸 spawn。
- **enforcement=partial**（Everyone 保留 / NTFS 硬链接 / 同身份读限制）；实际受限令牌下 pwsh 跑在 `ConstrainedLanguage`（.NET 方法调用被禁）。
- **宿主/原生隔离**：pi 宿主是 Bun（不能加载 koffi）→ 宿主只含 `runner-contract.ts`（argv 纯函数）+ `winacl.ts`（spawn 驱动），全部 Win32 逻辑在 runner 子进程；装配期 `runner --probe` 只出**可见性**（通知/徽标），可用性判定落在调用点（fail-closed）。
- **grant 归属**：宿主不能物化 ACE → runner 走 standalone 流程（自行派生工作区 SID、建私有 temp 并授予/撤销）；工作区 ACE 幂等保留（standing reuse cache）。
- **残留清扫**：宿主 kill runner 会留下私有 temp 目录；每次 runner 调用开头用**占用锁**（先取锁再建目录）判定死主/活体并清扫（只碰 `pi-sandbox-dsh-` 前缀）。
- **壳缝恒在位（不变量 4）**：受限壳工具**恒注册**（Linux=`bash` 同名覆盖内置；Windows=`powershell`）；不可用时**调用点拒绝**（`SANDBOX_UNAVAILABLE`），绝不裸跑；`danger-full-access` 才委托 pi 本地 shell。
- **未接管的同类壳被门控**：Windows 的内置 `bash`（git-bash，无约束）在 confined 档由 `tool_call` 拦下（pi 默认活跃壳名是 `bash`，而受限壳只能叫 `powershell` → 同名覆盖不完整）；Linux 无此问题。
- **后端不可见性**：`probe()` 失败 → `session_start` error 通知（壳会拒绝执行 + 同类壳已门控 + 修复方向）+ 徽标 `(no backend)`（不假收敛）。

**三段式 → pi**：落地 dsh 的 win32 后端（受限令牌 + NTFS ACE + Node runner），**只限写**（不含 deny-read / 凭据掩码）；无 plan/verify 档位。

## 7. 复现的功能清单（dsh → pi-sandbox-dsh）

| # | dsh 功能 | pi 落地 | 三段式 |
|---|---|---|---|
| 1 | 全局档位（read-only/workspace-write/danger + 默认） | 全局档 = appendEntry 折叠 + `/sandbox` 命令 | 原生(折叠)+dsh(3档有效默认)+裁剪(无plan档) |
| 2 | 档位解析（explicit>session>default；root=cwd） | `resolvePolicy(session)` 纯函数 | 同 dsh |
| 3 | 命令写面收敛（confine） | spawnHook(bwrap) / operations.exec(winacl) | 原生工具钩子 + dsh 后端 |
| 4 | 写被拒 → denial marker + hint | 门控被拒 → `ctx.ui.select` 征求批准；拒绝 → block(denial+hint) | 原生(ui.select)+dsh(标记) |
| 5 | 模型升级（sandbox_permissions+justification） | **不 fork 工具**：文件工具→门控被拒即征求；bash→全局 `/sandbox` 切换 | 原生(门控/命令)+dsh(批准语义) + 裁剪(最小暴露面) |
| 6 | 批准（approveEscalation） | `ctx.ui.select`（门控 + `/sandbox` 更宽档确认）+ 严格更宽校验 | 原生(ui.select)+dsh(词表) |
| 7 | per-call 更宽（不持久） | 文件工具：门控放行仅本次；bash：全局 `/sandbox`（持久档） | 同 dsh（语义）+ 裁剪 |
| 8 | fail-closed（SANDBOX_UNAVAILABLE） | 后端不可用 → 拒绝（block）| 原生(block)+dsh(降级为拒绝) |
| 9 | 系统提示档位段 | before_agent_start 追加 | 原生 + dsh(renderPolicyContext) |
| 10 | 后端（bwrap/winacl，只限写） | 复用骨架，**去掉凭据隐藏/plan档** | 原生 + dsh(读全开/网络) |

## 8. plan-mode 与沙箱正交（解耦依据）

**dsh 的 plan-mode 与沙箱正交、解耦**（源码实证）：

- `plan-mode`（`packages/plan/plan-mode/`）只管**工作流软引导**：`plan:policy` 提示段 + `/plan` + `exit_plan_mode` 工具 + `plan/mode` 布尔事件，**不限制任何工具**（"every tool stays callable"），**不改变沙箱档**。
- `sandbox`（`packages/sandbox/sandbox*/`）管**写面强制执行**：全局档（read-only/workspace-write/danger）+ 逐级升级批准，**独立于相位**。
- 两者在系统提示里**并存**（`plan:policy` 与 `sandbox:policy` 各自注册，互不依赖）；README 的关系只是一句建议（plan 软引导，需强制限制就去配 sandbox），**不是耦合**。

**结论**：pi-sandbox-dsh **不含 plan-mode**——沙箱管写、计划管工作流，两者是**正交两层**。将来若做计划工作流扩展（如 opencode 版），应做成**独立的软引导层**，与本沙箱**解耦共存**，绝不焊成"相位开关沙箱"。

## 9. 模式持久化 + 门控驱动（两条正交轴）

**模式写路径（对齐 dsh `session-mode.ts`）**：全局档 = 只追加一条 log-only `sandbox/mode` 事件；`effective = 折叠态 ?? 部署默认`。存活靠会话重放，无外部配置 store，不建内存真源（不变量 6）。pi 落点：`appendEntry("sandbox/mode", { mode })` + 纯折叠；`/sandbox <mode>` 命令走此写路径。

**门控驱动（统一，不 fork 任何 pi 工具）**：
- **bash**：bwrap `spawnHook` 读全局档收敛（不重注册工具、无 escalation 字段）；升级走全局 `/sandbox <mode>`（更宽档经 `ctx.ui.select` 确认）。
- **文件工具（write/edit）**：`tool_call` 门控 `isPathUnder` 围栏；被拒 → `ctx.ui.select` 征求"允许本次"（per-call 升级）；拒绝 → block(denial+hint)。不 fork write/edit。
- 全部批准/拒绝在门控或命令（`/sandbox`）处完成 = **用户决策点**；无工具 schema 分支、无命令白名单。

**两条正交轴（弄清"fs 侧"）**：
- **平台轴**：Linux/mac（bwrap/landlock/seatbelt）vs Windows（winacl）——选哪个 **OS 沙箱后端**。
- **能力轴**：shell（bash/pwsh，spawn 进程 → 由 OS 沙箱包 argv）vs **文件工具**（write/edit，进程内调 fs API，不 spawn 进程 → 进程内 `isPathUnder` 围栏）。

**文件工具写面（dsh `fs-sandbox` + `tool-fs`）**：`isPathUnder`（词法快路径 + 文件系统身份兜底，处理 Windows 8.3/大小写别名）+ 门控被拒即征求批准。**读全部放开**（每种模式都允许读）。

## 10. 实现状态（截至提交）

| 部分 | 状态 |
|---|---|
| bridge（档位/升级词表/policy/denial） | ✅ 已实现 + 测试 |
| bwrap（Linux/WSL2 写面） | ✅ 已实现 + 测试 |
| 文件工具围栏（`isPathUnder` + 门控被拒即征求批准） | ✅ 已实现 + 测试 |
| 门控驱动 / `/sandbox`（用户决策点，不 fork 工具） | ✅ 已实现 |
| **winacl（Windows）后端** | ✅ **已接通并 Windows 真机验证**（令牌/ACE/FFI runner 全部落地：`runner --probe`、read-only 写被拒/读全开、workspace-write 工作区内可写/外被拒、ACE 幂等、temp 无残留；证据见 `docs/verify-windows.md`）；已知边界：受限令牌下 pwsh=ConstrainedLanguage、enforcement=partial、每命令一个 runner 子进程 |

**Linux 验证（已完成，真机 bwrap 执行）**：
- `bwrap-e2e.spec.ts`（真机）：read-only 写工作区→EROFS；read-only 读→成功；workspace-write 写→成功；**无凭据隐藏**（~/.gitconfig 可读）。7/7。
- `core load.spec.ts`（mock pi 实例化扩展）：注册受限壳工具 + `/sandbox` 命令 + 两条 `tool_call` 门控（文件、同类壳）+ `session_start` 折叠 + `before_agent_start` 档位提示段 + 同类壳在 confined 档被拦。22/22。
- `core backend-unavailable.spec.ts`：强制后端不可用 → 壳仍在位、confined 调用被拒（`SANDBOX_UNAVAILABLE`）、danger 真执行、同类壳被门控、通知/徽标/文件拒绝文案。22/22。

## 11. 验证

- `npm run typecheck`（strict）。
- `npm test`：pure（bridge）——`WIDER_MODES` 严格更宽 / `approveEscalation` 各结果 / `validateEscalationArgs` / `resolvePolicy` 优先级 / `sandboxDenialMarker`/`escalationHintMarker` / backlog denial 探测；`selectBackend` / bwrap / winacl 签名 / 残留 temp 清扫策略 / runner Node 解析 / **同类壳门控** / **后端不可用时的 fail-closed 与可见化**。
- `npm run probe`：Linux/WSL2 = `bwrap --version`；Windows = winacl runner capability + 残留清扫（死主/活体）+ read-only/workspace-write 往返 + grant 生命周期（ACE 幂等 + temp 清理）。
