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
| 参数配对校验 | `escalation.ts:47` | `sandbox_permissions` 与 `justification` 必须同带；justification 须非空句 |
| fail-closed | `index.ts:96` `SandboxUnavailableError` / `SANDBOX_UNAVAILABLE` | 请求 confined 档但本机无可用后端 → 抛错，**绝不静默降级成无沙箱** |
| 网络/读不在档位词汇 | `sandbox-policy/README.md:148` | "File-effect modes only — network and process policy are outside its vocabulary" → **读全开、网络不管** |
| 后端 | `sandbox-local` / `sandbox-windows-acl` | `confine(argv, policy)` 返回包好的 argv；Linux=bwrap / landlock，mac=sandbox-exec，Windows=`WRITE_RESTRICTED` token + NTFS ACE |

## 二、三段式判定门（每个改动必须过）

1. **pi 原生机制**——这个需求 pi 官方原生机制是什么？（`tool_call` 门控 / `appendEntry` 折叠 / `before_agent_start` / `ui.select` / `createBashTool`+`spawnHook` / `createPowerShellTool` + `operations.exec`）
2. **dsh 语义**——dsh 给这个机制补的成熟语义是什么？（3 档阶梯 / 严格更宽 / per-call 升级 / denial+hint 标记 / fail-closed）
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
| **sandbox** | OS 写面沙箱库：bwrap（Linux/WSL2）/ winacl（Windows 受限令牌 + NTFS ACE，pwsh shell） | `packages/sandbox/src/{backend,bwrap,winacl}.ts` |
| **bridge**（可选） | 共享纯函数/类型：档位阶梯、严格更宽判定、denial/hint 标记、fail-closed 判定 | `packages/bridge/src/index.ts` |

- **插拔一致**：能力 = 库，core 经 `loadCapabilities` 惰性加载；后端 = `selectBackend()`（bwrap / winacl），`probe()` 失败 → fail-closed（danger 或 SANDBOX_UNAVAILABLE）。

## 五、档位与批准流（核心）

- **全局档**（默认 `read-only`）：持久状态，非 plan/build 相位。
- **写被拒** → `denialMarker` + `escalationHintMarker` 返回给模型，命令 block。
- **批准（门控驱动，用户决策点）**：文件工具（write/edit）被拒 → `ctx.ui.select` 征求"允许本次"（per-call 更宽）；bash 升级走全局 `/sandbox <mode>`（更宽档确认）。不 fork 任何工具，无命令白名单。
- **fail-closed**：confined 档无可用后端 → 抛 `SANDBOX_UNAVAILABLE`，绝不裸跑；升级目标非严格更宽 → 不弹窗、直接拒绝。

## 六、设计不变量（回退需先改本节）

1. **沙箱管写面，不管读面**——读全开；凭据靠"写面 + 网络出口"约束，不靠藏读。
2. **档位 = 全局持续状态，不与任何阶段绑定**；无子档。
3. **批准 = 逐级升级（严格更宽）**，不是每命令弹窗、不是命令白名单。
4. **fail-closed**——confined 档无后端 → 拒绝（SANDBOX_UNAVAILABLE），绝不静默降级成无沙箱；升级非严格更宽 → 不弹窗。
5. **批准不进模型上下文**；文件工具升级仅作用于本次调用（per-call，门控放行）；bash 升级为全局 `/sandbox`（持久档，更宽档经确认）。
6. **状态 = 日志折叠，禁内存真源**。
7. **最小暴露面**——凭据 / 敏感目录不因"读隐藏"而特殊处理；如需约束，用写面 + 网络出口，而非藏读或 deny-read 名单。
8. **切换/升级告知 = 通知机制**（英文文案，对齐 plan 侧）。**pi 需要它而 dsh 不需要**：pi 的档位提示段由 `before_agent_start` **每用户轮**静态拼接（本轮内不再重建），dsh 的 `sandbox:policy` 是 systemPrompt.context 的 **text 回调**、每次 assembly 动态求值（`sandbox-policy/src/index.ts:140-152`），故 dsh 的 `sandbox/mode` 保持 log-only、**从不进模型 transcript**（`session-mode.ts:27-38`）；pi 移植用一条 steer notice 补偿该时机差。

## 七、已知取舍（接受并文档化）

- **提示词预算规则**：每轮注入的 prompt 段 ≤ ~100 tok；新增内容必须**置换**已有内容或**按需门控**；且不得让档位未变时 system prompt 发生字节变化（保前缀缓存）。
- **同轮内档位提示段滞后（与 dsh 的已知差异）**：切档发生在同一轮内时，`before_agent_start` 不会重跑，模型本轮后续请求仍看到旧档位的 `Current DSH file policy: …`；dsh 无此问题（见不变量 8 的动态求值说明）。补偿：切档 notice 立即告知模型；下一轮提示段自动校正。不改 prompt 拼接架构（改写 payload 需权衡前缀缓存，未做）。
- **计划性工作流不在本扩展内**：本扩展只做"写面沙箱 + 逐级批准"；"读资料→出计划→批准执行"这类工作流由独立扩展承担。
- **winacl enforcement=partial**（Everyone 保留 / 硬链接 / 同身份读限制）：进入 read-only / workspace-write 需 notice 明示。
- **Windows 沙箱档 shell=pwsh**（受限令牌 × git-bash 不兼容）；Linux/WSL2 用 bwrap、shell=bash。
- **winacl 依赖 koffi（原生 FFI），Bun 宿主不能加载** → 独立 Node runner 子进程承载；加载前 fail-closed 降级。
- **网络默认不掺和**（对齐 dsh "network outside vocabulary"）：本扩展不提供网络档位。
- **不支持命令白名单**——明确拒绝字符串匹配（误判膨胀）。
- **devDep ≥ 0.84.4**（0.84.1 不导出 `createPowerShellTool`）。

## 八、验证与规模

- `npm run typecheck`（strict，全部 workspace）。
- `npm test`：core 档位折叠 / 严格更宽判定 / escalate 批准流（allowed-once / rejected / cancelled / unavailable / 非更宽）/ fail-closed / denial+hint 标记；sandbox `selectBackend` / bwrap / winacl 签名。
- `npm run probe`（真机）：bwrap `--version`；winacl `pwsh-under-token` + read-only 往返 + dispose 撤销。
- 规模参考：约 3 个包，src 控制在 ~2000 行内（核心小）。
