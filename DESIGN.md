# pi-sandbox-dsh 设计依据（是什么 / 为什么）

> 本文是**设计依据**（是什么 / 为什么）：定位、参考源锚点、判定门记录、设计决策、架构、不变量、已知取舍。
> **agent 在本目录工作的行为约束见 `AGENTS.md`（本地文件、不入库，故 clone 中不出现）**；本文件按需读：改语义 / 改不变量 / 改参考源语义前。
> 单一参考源 = **dsh**（`deepseek-harness`，已 clone 至 `~/projects/deepseek-harness`）。

---

## 〇、定位与核心命题

- 一个 pi 扩展，把模型的**写**动作用 OS 边界约束起来，模型为 **连续 agent**。
- **单一参考源 = dsh**。语义裁剪到 pi 哲学（核心小 / 最小暴露面 / OS 边界优先 / 用户决策点）。
- 一句话：**沙箱是"写面"边界，不是"读"边界；档位是全局持续的；批准是"逐级升级到更宽档"，而不是"每命令弹窗"或"命令白名单"。**

## 一、参考源锚点（dsh 源码实证）

| dsh 概念 | 源码位置 | 语义要点 |
|---|---|---|
| `SandboxMode` | `packages/sandbox/sandbox/src/index.ts:29` | `'read-only' \| 'workspace-write' \| 'danger-full-access'`；`ConfinedSandboxMode` 排除 danger |
| 档位阶梯 | `packages/sandbox/sandbox/src/escalation.ts:28` | `WIDER_MODES = { 'read-only': ['workspace-write','danger-full-access'], 'workspace-write': ['danger-full-access'] }` —— 严格更宽 |
| 批准升级 | `escalation.ts:157` `approveEscalation` | 执行前校验"严格更宽"→ 走人类审批通道 → 映射 allowed-once/rejected/cancelled/unavailable → **仅本次调用**以更宽档执行；无审批 service / 无 agent → fail-closed |
| 模型侧提示 | `escalation.ts:71` `sandboxDenialMarker` / `escalationHintMarker` | 写被拒时给模型"denial"标记 + "可升级"提示，让模型带 `sandbox_permissions + justification` 重试 |
| 参数配对校验 | `escalation.ts:51` | `sandbox_permissions` 与 `justification` 必须同带；justification 须非空句 |
| fail-closed | `index.ts:124` `SANDBOX_UNAVAILABLE` / `:131` `SandboxUnavailableError` | 请求 confined 档但本机无可用后端 → 抛错，**绝不静默降级成无沙箱**；runner 自身失败同样升级为该错，**不误报成 denial** |
| 网络/读不在档位词汇 | `sandbox-policy/README.md:148` | "File-effect modes only — network and process policy are outside its vocabulary" → **读全开、网络不管** |
| 后端 | `sandbox-local` / `sandbox-windows-acl` | `confine(argv, policy, signal?)` 返回 `ConfinedArgv { argv, enforcement, denialSignatures, runnerFailureRules }`；Linux=bwrap / landlock，mac=sandbox-exec，Windows=`WRITE_RESTRICTED` token + NTFS ACE |
| denial 方言 | `sandbox-local/src/index.ts:203-211` `DENIAL_SIGNATURES` | 每个后端声明自己的 stderr 方言（bwrap=`read-only file system`；windows-acl 含 `operation not permitted`，即 Node EPERM）；**不用跨后端并集** |
| runner 失败规则 | `sandbox/src/index.ts:81-88` `RunnerFailureRule` | `allowedExitCodes?`（exit 门）+ `informationalLines?`（**整行精确**排除）+ `fatalSignatures`（子串）；未匹配到致命行 = 证据不足，不算 runner 失败 |
| 结果侧分类 | `sandbox/src/diagnostics.ts` | `matchesSignature`（需非零、非 null 退出；signal 死亡不是 denial）/ `classifyRunnerFailure` / `isRunnerSpawnFailure` |
| 判定顺序 | `bash-sandbox/src/index.ts:117-124,165-176` | **runner 失败优先于 denial**（命令没跑起来，就不该把失败归给策略）；`denied = !runnerFailed && matchesSignature(...)`；runner 失败抛 `SandboxUnavailableError(mode, 致命行)` |
| confine 可取消 | `sandbox/src/index.ts:176` | `confine(...)` 为 async + `AbortSignal`；消费侧在 confine 之后、admit spawn 之前再 `throwIfAborted()` |
| 执行世界路径拼写 | `sandbox-policy/src/index.ts:27-31` + `sandbox-local/src/index.ts:318` | policy 只要求"绝对执行世界路径"；`canonicalPath` 由 enforcing provider 在**自己的宿主**上做（不在宿主侧提前规范化） |

## 二、三段式判定门（每个改动必须过）

1. **pi 原生机制**——这个需求 pi 官方原生机制是什么？（`tool_call` 门控 / `appendEntry` 折叠 / `before_agent_start` / `ui.select` / `createBashTool`+`spawnHook` / `createPowerShellTool` + `operations.exec`）
2. **dsh 语义**——dsh 给这个机制补的成熟语义是什么？（3 档阶梯 / 严格更宽 / per-call 升级 / denial+hint 标记 / **结果侧分类（runner 失败优先于 denial）** / fail-closed）
3. **pi 裁剪**——按 pi 哲学裁成什么形态？（核心小 / 最小暴露面 / 读全开 / 网络不掺和）

## 三、设计决策（为什么这样，而非其他）

- **不采用"命令白名单"（字符串匹配）**：会误判，且修误判导致白名单膨胀。写面约束用 **OS 边界**，不是字符串启发式。
- **不采用 plan/build 双模式**：写面是**全局档位**，与"是否处于计划阶段"解耦；因此不存在"只读计划里塞一个允许写的工作区子档"这类矛盾。
- **不隐藏读**：档位只限**写面**（文件效果）；读全开。凭据靠"写面 + 网络出口"约束，而非"藏读"。
- **`danger-full-access` 也要批准**：即使全权档，升级/切换也走人类批准，避免"裸奔无审批"。

## 四、架构（当前实现，packages/*）

| 块 | 职责 | 实现 |
|---|---|---|
| **core** | 唯一 pi 扩展宿主：全局档位持久状态（appendEntry 折叠）、bash/pwsh 工具注入（spawnHook/operations，**不 fork**）、文件工具门控 + 门控/命令审批、fail-closed 降级 | `packages/core/src/{state,tools-fs,index}.ts` |
| **sandbox** | OS 写面沙箱库：bwrap（Linux/WSL2）/ winacl（Windows 受限令牌 + NTFS ACE，pwsh shell）；**后端事实**（denial 方言 + runner 失败规则）+ 结果侧分类包装 | `packages/sandbox/src/{backend,bwrap,winacl,classify}.ts` |
| **bridge**（可选） | 共享纯函数/类型：档位阶梯、严格更宽判定、denial/hint 标记、**结果侧分类（`matchesSignature` / `classifyRunnerFailure` / `classifyDenial`）**、fail-closed 词汇 | `packages/bridge/src/index.ts` |

- **插拔一致**：能力 = 库，core 经 `loadCapabilities` 惰性加载；后端 = `selectBackend()`（bwrap / winacl），`probe()` 失败 → fail-closed（danger 或 SANDBOX_UNAVAILABLE）。
- **两个执行缝**：bwrap = `spawnHook`（把命令字符串包成 `bwrap … sh -c '<cmd>'`）+ `operations`（分类）；winacl = `operations.exec`（命令交给 Node runner）。pi 的 `spawnHook` 在工具里先跑，其产物（command/cwd/env）再交给 `operations.exec`——两者可共存。

## 五、档位与批准流（核心）

- **全局档**（默认 `read-only`）：持久状态，非 plan/build 相位。
- **预执行门控（文件工具）**：write/edit 被拒 → `ctx.ui.select` 征求"允许本次"；拒绝 → `denialMarker` + `escalationHintMarker` 返回给模型，命令 block。
- **结果侧分类（shell 命令，本次新增）**：命令跑完后按后端事实判定——① 命中 runner 失败规则 → 抛 `SANDBOX_UNAVAILABLE`（**命令没跑起来，不算策略拒绝**）；② 否则非零退出且命中该后端 denial 方言 → 在模型可见输出尾部追 `denialMarker` + 切档提示（bash 无 per-call 升级字段 → 提示改指向"请用户 `/sandbox` 切档"）。
- **批准（门控驱动，用户决策点）**：文件工具（write/edit）被拒 → `ctx.ui.select` 征求"允许本次"（per-call 更宽）；bash 升级走全局 `/sandbox <mode>`（更宽档确认）。不 fork 任何工具，无命令白名单。
- **fail-closed**：confined 档无可用后端 → 抛 `SANDBOX_UNAVAILABLE`，绝不裸跑；runner 失败同样抛该错（绝不误报成 denial、绝不降级裸跑）；升级目标非严格更宽 → 不弹窗、直接拒绝。

## 六、设计不变量（回退需先改本节）

1. **沙箱管写面，不管读面**——读全开；凭据靠"写面 + 网络出口"约束，不靠藏读。
2. **档位 = 全局持续状态，不与任何阶段绑定**；无子档。
3. **批准 = 逐级升级（严格更宽）**，不是每命令弹窗、不是命令白名单。
4. **fail-closed = 缝恒在位、不可用即拒**（不是“工具消失”）—— 受限壳工具**恒注册**（Linux=`bash` 覆盖内置；Windows=`powershell`）；`confined` 档下后端不可用 / runner 起不来 → **调用点**抛 `SANDBOX_UNAVAILABLE`，**绝不裸跑**；只有 `danger-full-access` 才委托 pi 本地 shell（用户显式决策）。**未接管的同类 shell 名字**（Windows 的 git-bash `bash`）在 confined 档由 `tool_call` 门控**封住**，不得成为绕过口。升级非严格更宽 → 不弹窗；后端不可用必须可见（不变量 10）。
5. **批准不进模型上下文**；文件工具升级仅作用于本次调用（per-call，门控放行）；bash 升级为全局 `/sandbox`（持久档，更宽档经确认）。
6. **状态 = 日志折叠，禁内存真源**。
7. **最小暴露面**——凭据 / 敏感目录不因"读隐藏"而特殊处理；如需约束，用写面 + 网络出口，而非藏读或 deny-read 名单。
8. **切换/升级告知 = 通知机制**（英文文案，对齐 plan 侧）。**pi 需要它而 dsh 不需要**：pi 的档位提示段由 `before_agent_start` **每用户轮**静态拼接（本轮内不再重建），dsh 的 `sandbox:policy` 是 systemPrompt.context 的 **text 回调**、每次 assembly 动态求值（`sandbox-policy/src/index.ts:140-152`），故 dsh 的 `sandbox/mode` 保持 log-only、**从不进模型 transcript**（`session-mode.ts:27-38`）；pi 移植用一条 steer notice 补偿该时机差。
9. **结果侧分类 = 事实判定，不是猜测**：只有 **runner 失败规则命中** 才升级为 `SANDBOX_UNAVAILABLE`；只有 **非零退出（signal 死亡不算）+ 本后端 denial 方言命中** 才追 denial 标记；runner 失败优先于 denial（互斥，不同时出现）；`danger-full-access` 无后端事实 → 不做任何判定。**denial 标记只进工具结果、不进 system prompt**。
10. **后端不可用必须可见（不假收敛）**：`probe()` 失败**不改变工具面**（受限壳仍在、`danger-full-access` 仍可用），但必须在 `session_start` 发一条 **error 级通知（英文）**：说明“受限壳会拒绝执行 / 未接管的同类 shell 已被门控 / 修复方向 + `/sandbox danger-full-access` 出口”，footer 徽标追加 `(no backend)`；文件门控的拒绝文案在无后端时标注“这是档位策略拒绝，不是内核拒绝”。理由：不变量 4 的“不静默降级”不只是不裸跑，也包括**不让用户/模型误判是哪一层在拦**。

## 七、已知取舍（接受并文档化）

- **提示词预算规则**：每轮注入的 prompt 段 ≤ ~100 tok；新增内容必须**置换**已有内容或**按需门控**；且不得让档位未变时 system prompt 发生字节变化（保前缀缓存）。
- **同轮内档位提示段滞后（与 dsh 的已知差异）**：切档发生在同一轮内时，`before_agent_start` 不会重跑，模型本轮后续请求仍看到旧档位的 `Current DSH file policy: …`；dsh 无此问题（见不变量 8 的动态求值说明）。补偿：切档 notice 立即告知模型；下一轮提示段自动校正。不改 prompt 拼接架构（改写 payload 需权衡前缀缓存，未做）。
- **计划性工作流不在本扩展内**：本扩展只做"写面沙箱 + 逐级批准"；"读资料→出计划→批准执行"这类工作流由独立扩展承担。
- **winacl enforcement=partial**（Everyone 保留 / 硬链接 / 同身份读限制）：进入 read-only / workspace-write 需 notice 明示。
- **Windows 沙箱档 shell=pwsh**（受限令牌 × git-bash 不兼容）；Linux/WSL2 用 bwrap、shell=bash。
- **winacl 依赖 koffi（原生 FFI），Bun 宿主不能加载** → 独立 Node runner 子进程承载；koffi 缺失 → 调用点 fail-closed（受限壳拒绝执行，不裸跑）。
- **网络默认不掺和**（对齐 dsh "network outside vocabulary"）：本扩展不提供网络档位。
- **不支持命令白名单**——明确拒绝字符串匹配（误判膨胀）。
- **`user_bash`（`!` / `!!`）不在本扩展约束内（边界声明）**：pi 的用户命令走独立缝（默认 pi 本地 bash operations），不经本扩展注册的 shell 工具。用户自己的动作不是"模型写面"（dsh 对应物是用户直接操作宿主，同样不经档位）——不引入拦截，保持最小暴露面。
- **pi 的 shell 工具没有后台/持久任务路径**：pi 的 bash schema 只有 `command / timeout`，不存在 dsh `processJob`（job 自有取消 + 准备期 `readOutput()` 为空）那种形状；因此无需做"后台任务是否绕开收敛"的核对（已核，无该路径）。
- **不对 runner 失败做"spawn 归因"（不采纳 dsh `isRunnerSpawnFailure`）**：dsh 的 shell executor 自己 spawn（argv[0] 即沙箱 runner），pi 的 bwrap 路径把 runner 包进 shell 字符串、spawn 目标是 shell → 用 argv[0] 归因会错指。pi 的 runner 缺失由两道代替：加载期 `probe()`（bwrap `--version`）+ 运行期 `bwrap: ` 致命签名（`sh: 1: bwrap: not found` 也命中）。
- **分类窗口有界（pi 裁剪）**：dsh 自己持有完整 stderr；pi 的 `operations.exec` 只给 `onData` 流 → 本扩展滚动保留尾部 **64 KiB** 用于分类，超出部分不参与判定（长输出后才出现的致命行不保证被识别）。
- **denial 只认非零退出**（dsh 同）：命令退出 0 时不判定 denial，即使输出里含方言子串；因此 `… 2>/dev/null || true` 这类吞掉失败的命令不会拿到 denial 标记。
- **bash 的 denial 提示是"请用户切档"而非 per-call 升级**（dsh 无此分支）：pi 的 bash schema 只有 `command/timeout`，没有 `sandbox_permissions + justification`；bash 升级在本扩展里恒为全局 `/sandbox`（见不变量 5），故提示指向用户决策点，而不是教模型带参重试。
- **`confine` 不可异步/取消（pi 裁剪）**：pi 的 `spawnHook` 是同步函数，dsh 的 `confine(argv, policy, signal): Promise` 无法直接移植；因此 pi 侧的预备（含 winacl 令牌/ACE）只能在 `operations.exec` 内自己做，本扩展不为它引入取消协议。
- **winacl runner 失败契约（已 Windows 真机验证）**：runner 自身失败必须打印 `windows-acl-run: ` 并以保留退出码 `127` 退出，才能被识别为 runner 失败而不是策略拒绝（见 `RUNNER_FAILURE_RULES`）。
- **winacl 在受限令牌下 pwsh = ConstrainedLanguage（真机实测）**：.NET 方法调用被禁，纯 cmdlet / 外部命令不受影响——机制固有代价，非本扩展引入。
- **winacl 每命令一个 runner 子进程**：宿主（Bun）不能加载 koffi → 不能持有 grant 生命周期，temp grant 按次物化/撤销（工作区 ACE 幂等复用）；净开销 ≈ 80–100 ms/命令。
- **winacl 残留私有 temp 目录靠“下次调用”清扫，不是即时清理**：宿主超时/中止会 kill runner（`finally` 不跑）→ 目录与 ACE 留在 `%TEMP%`。补偿：每次 runner 调用开头先 `sweepStaleTempDirs`——只碰 `pi-sandbox-dsh-` 前缀；活体由**占用锁**判定（`temp-lock.ts`：先取锁再建目录 → 拿得到锁=死主，`ERROR_LOCK_VIOLATION`=活体），无锁文件的产物另需 5 min 年龄门槛；`%TEMP%/pi-sandbox-dsh-locks/` 为常驻锁目录（与 `pi-sandbox-dsh-acl-locks/` 同类设计产物）。清扫失败只告警，**不进 runner 失败契约**（退出码 127 只留给真正的失败）。
- **winacl 超时/中止会绕过清理**：宿主 kill runner 时其 finally 不执行，`%TEMP%` 会留下一个 `pi-sandbox-dsh-*` 私有目录及其 ACE（工作区 standing ACE 不受影响）。
- **probe 只负责“可见性”，不再是“有没有壳”的判据**：可用性判定落在调用点（对齐 dsh：winacl rung 连 probe 都不做，靠 runner 失败签名 `windows-acl-run:` + exit 127 fail-closed）。pi 侧仍需装载期 probe 来出通知/徽标，但它不再决定工具注册与否。
- **未接管的同类 shell 名字由 `tool_call` 门控封住（Windows 特有）**：pi 默认活跃的壳工具名是 `bash`（`defaultActiveTools = [read,bash,edit,write]`），而受限令牌×git-bash 不兼容 → Windows 的受限壳只能叫 `powershell`（**不同名 ⇒ 覆盖不完整**，内置 `bash` 仍活跃且无约束）。故 confined 档下把“本后端未接管”的那个壳名字（`bash`/`powershell`）用门控拦下（理由带档位 + 建议用受限壳/切档）。Linux 无此问题：受限壳正好叫 `bash`，同名覆盖即完成；内置 `powershell` 不在默认 active 且非 win32 调用即抛错。
- **winacl 依赖系统 `node`（runner 子进程）**：宿主是 Bun → runner 必须跑在系统 Node 上。**解析不只看 PATH**：`PI_SANDBOX_NODE`（显式覆盖）→ `PATH` → Windows 注册表 `Path`（用户/系统，覆盖 "pi 由陈旧终端启动、进程持有过期 PATH" 这一真机故障）；全部失败 → 调用点 fail-closed（**壳还在，但会拒绝**）。
- **devDep ≥ 0.84.4**（0.84.1 不导出 `createPowerShellTool`）。

## 八、验证与规模

- `npm run typecheck`（strict，全部 workspace）。
- `npm test`：core 档位折叠 / 严格更宽判定 / escalate 批准流（allowed-once / rejected / cancelled / unavailable / 非更宽）/ fail-closed / denial+hint 标记 / **后端不可用的可见化**（受限壳仍在但调用被拒 + 未接管的同类 shell 被门控 + error 通知（原因来自后端自声明）+ `(no backend)` 徽标 + 无后端时的文件拒绝文案）；sandbox `selectBackend` / bwrap / winacl 签名 / **结果侧分类**（runner 失败优先、denial 需非零退出、signal 死亡不判定、danger 不判定、分类窗口有界）/ **残留 temp 目录清扫策略**（死主 vs 活体 vs 无锁年龄门槛、ownDir 排除、probe 抛错隔离）/ **runner Node 解析纯函数**（Windows/POSIX 分隔符、去重、去引号）。
- `npm run probe`（真机）：Linux/WSL2 = bwrap `--version`；Windows = runner capability（koffi/令牌/默认 DACL/Job）+ 残留清扫（死主被删 / 活体与太新保留）+ read-only 写被拒/读全开 + workspace-write 工作区内可写/工作区外被拒 + 工作区 ACE 幂等（仅 1 条）+ temp 目录无残留。
- 规模参考：约 3 个包，src 控制在 ~2000 行内（核心小）。
