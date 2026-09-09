# pi-sandbox-dsh · 技术设计（dsh 单源，完整复现）

> 配套：根 `AGENTS.md`（本地设计依据，gitignored）；本文为可入库的架构/设计说明。
> 参考源：**dsh**（`deepseek-harness`）@ `~/projects/deepseek-harness`，HEAD `5dda764`。
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
| 维度 | pi 原生 | dsh 语义 | pi 裁剪 |
|---|---|---|---|
| 工具 schema 加升级字段 | 重注册 bash 工具，扩展 `parameters`（typebox） | 传入 `sandbox_permissions`(enum)+`justification` | 复用 pi 的 bash 工具对象，`parameters` 里**追加**这两个字段；无沙箱 executor 时**不追加**（不广告） |
| 批准 | `ctx.ui.select` | `approveEscalation`（严格更宽 + 人类确认） | 拦截 upgrade 参数 → 校验严格更宽 → `ctx.ui.select`（展示 justification）→ allowed-once=本次更宽 / rejected=拒绝 |
| denial 渲染 | pi bash 工具结果是文本 | 结果尾部追加 `[sandbox: …]` 标记 | **覆写 bash `execute`**：跑完后若输出匹配 denial 方言（bwrap EROFS / winacl "Access is denied"），向 content 追加 `denialMarker + escalationHintMarker` |
| 只作用于本次调用 | — | allowed-once → per-call wider | 批准的更宽 mode 只并入本次 policy，**不改全局档** |

**实现要点**：
```ts
// 重新注册 bash 工具，保留原 schema 语义并加升级字段（无沙箱时字段不出现）
pi.registerTool({
  ...baseBashTool,
  parameters: { ...baseBashTool.parameters, ...(escalationAdvertised ? {
    sandbox_permissions: {...}, justification: {...},
  } : {}) },
  execute: async (id, params, signal, onUpdate) => {
    const standing = resolvePolicy(session)
    let mode = standing.mode
    if (params.sandbox_permissions && params.justification) {
      mode = await approveEscalation({ requestedMode, justification, effectiveMode: mode, subject:'command' },
                                     { approver: ui.select, agent, callId, toolName:'bash', signal })
    }
    const result = await baseBashTool.execute(id, {...params}, signal, onUpdate)
    if (mode !== 'danger-full-access' && looksLikeDenial(result)) {
      return appendMarkers(result, mode)   // denial + hint
    }
    return result
  },
})
```
其中 `looksLikeDenial(result)` 匹配当前后端的 `denialSignatures`（bwrap `read-only file system`；winacl `access is denied`/`permission denied`/…）。

## 2. executor 层（`@deepseek-ai/dsh-bash-sandbox`）
- `run/start`：`danger-full-access` → 原样执行；否则 `confine(['bash','-c',cmd], policy)`（provider 包装 argv）。
- 分类：`classifyRunnerFailure`（runner 自身失败 → `SANDBOX_UNAVAILABLE`，命令没跑）、`classifyDenial`（stderr 匹配 denial 方言 → `denied:true`）、`enforcement`。
- 结果携带 `sandbox: { mode, denied, enforcement, runnerFailed }`。

**三段式 → pi**：pi 在 `createBashTool` 的 `spawnHook` 里改**命令字符串**（`bwrap <profile> -- sh -c '<cmd>'`）；winacl 走 `operations.exec`。**不新增 executor**，分类逻辑并入上图 execute 的探针。

## 3. provider 层（`@deepseek-ai/dsh-sandbox-local`）
- `PLATFORM_CHAINS = { linux:['bwrap','landlock'], darwin:['seatbelt'], win32:['windows-acl'] }`。
- `confine(argv, policy)` → 选 runner + profile → 返回包装 argv + enforcement + denial 方言 + runner-failure 规则。
- platform 无可用 runner → `SandboxUnavailableError`（fail-closed）。
- ACL grant 生命周期（win）：工作区 SID 确定性、ACE **stand（跨会话复用缓存，exact-ACE skip O(1)）**；每会话**随机 temp 目录 + SID**，dispose 撤销；provider dispose 清 temp、保工作区站台 ACE。

**三段式 → pi**：`selectBackend()`（bwrap/winacl）+ `probe()`；`createBashTool` spawnHook 用 bwrapProfile、`createPowerShellTool` operations 用 winacl Node runner。**provider 承载 grant 生命周期**（winacl 由 Node runner 子进程承载，Bun 宿主不 load koffi）。

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
- **enforcement=partial**（Everyone 保留 / NTFS 硬链接 / 同身份读限制）。

**三段式 → pi**：落地 dsh 的 win32 后端（受限令牌 + NTFS ACE + Node runner），**只限写**（不含 deny-read / 凭据掩码）；无 plan/verify 档位。

## 7. 复现的功能清单（dsh → pi-sandbox-dsh）

| # | dsh 功能 | pi 落地 | 三段式 |
|---|---|---|---|
| 1 | 全局档位（read-only/workspace-write/danger + 默认） | 全局档 = appendEntry 折叠 + `/sandbox` 命令 | 原生(折叠)+dsh(3档有效默认)+裁剪(无plan档) |
| 2 | 档位解析（explicit>session>default；root=cwd） | `resolvePolicy(session)` 纯函数 | 同 dsh |
| 3 | 命令写面收敛（confine） | spawnHook(bwrap) / operations.exec(winacl) | 原生工具钩子 + dsh 后端 |
| 4 | 写被拒 → denial marker + hint | execute 覆写探测 denial 方言 → 追加标记 | 原生(文本结果)+dsh(标记) |
| 5 | 模型升级（sandbox_permissions+justification） | bash 工具 schema 追加字段 | 原生(工具schema)+dsh(参数) |
| 6 | 批准（approveEscalation） | `ctx.ui.select` + 严格更宽校验 | 原生(ui.select)+dsh(词表) |
| 7 | per-call 更宽（不持久） | 批准的 mode 只并入本次 policy | 同 dsh |
| 8 | fail-closed（SANDBOX_UNAVAILABLE） | 后端不可用 → 拒绝（block）| 原生(block)+dsh(降级为拒绝) |
| 9 | 系统提示档位段 | before_agent_start 追加 | 原生 + dsh(renderPolicyContext) |
| 10 | 后端（bwrap/winacl，只限写） | 复用骨架，**去掉凭据隐藏/plan档** | 原生 + dsh(读全开/网络) |

## 7. plan-mode 与沙箱正交（解耦依据）

**dsh 的 plan-mode 与沙箱正交、解耦**（源码实证）：

- `plan-mode`（`packages/plan/plan-mode/`）只管**工作流软引导**：`plan:policy` 提示段 + `/plan` + `exit_plan_mode` 工具 + `plan/mode` 布尔事件，**不限制任何工具**（"every tool stays callable"），**不改变沙箱档**。
- `sandbox`（`packages/sandbox/sandbox*/`）管**写面强制执行**：全局档（read-only/workspace-write/danger）+ 逐级升级批准，**独立于相位**。
- 两者在系统提示里**并存**（`plan:policy` 与 `sandbox:policy` 各自注册，互不依赖）；README 的关系只是一句建议（plan 软引导，需强制限制就去配 sandbox），**不是耦合**。

**结论**：pi-sandbox-dsh **不含 plan-mode**——沙箱管写、计划管工作流，两者是**正交两层**。将来若做计划工作流扩展（如 opencode 版），应做成**独立的软引导层**，与本沙箱**解耦共存**，绝不焊成"相位开关沙箱"。

## 8. 模式持久化（session-mode）与文件工具围栏（待实现）

**模式写路径（对齐 dsh `session-mode.ts`）**：全局档 = 只追加一条 log-only `sandbox/mode` 事件；`effective = 折叠态 ?? 部署默认`。存活靠会话重放，无外部配置 store，不建内存真源（不变量 6）。pi 落点：`appendEntry("sandbox/mode", { mode })` + 纯折叠；`/sandbox <mode>` 命令走此写路径。

**两条正交轴（弄清"fs 侧"）**：
- **平台轴**：Linux/mac（bwrap/landlock/seatbelt）vs Windows（winacl）——选哪个 **OS 沙箱后端**。
- **能力轴**：shell（bash/pwsh，spawn 进程 → 由 OS 沙箱包 argv）vs **文件工具**（write/edit，在进程内调 fs API，不 spawn 进程）。

**文件工具写面（dsh `fs-sandbox` + `tool-fs`，最小复现）**：文件编辑工具不 spawn 进程，OS 沙箱包不到——dsh 用**进程内路径围栏**（`isPathUnder`：词法快路径判断 target 是否在可写根内，不匹配时用文件系统身份兜底，处理 Windows 8.3/大小写别名）配合 fs-tool 的 escalation/denial。**读全部放开**（每种模式都允许读）。pi 落点：`edit`/`write` 工具的 execute 前置 `isPathUnder(target, workspaceRoot)` 判可写 + 升级提示。

## 9. 验证

- `npm run typecheck`（strict）。
- `npm test`：pure（bridge）——`WIDER_MODES` 严格更宽 / `approveEscalation` 各结果 / `validateEscalationArgs` / `resolvePolicy` 优先级 / `sandboxDenialMarker`/`escalationHintMarker` / backlog denial 探测；`selectBackend` / bwrap / winacl 签名。
- `npm run probe`：`bwrap --version`；winacl pwsh-under-token + read-only 往返 + dispose 撤销。
