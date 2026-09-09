# pi-sandbox-dsh · 技术设计（dsh 单源）

> 配套：根 `AGENTS.md`（本地设计依据，gitignored）；本文为可入库的架构/设计说明。
> 参考源：**dsh**（`deepseek-harness`）@ `~/projects/deepseek-harness`，版本 HEAD `5dda764`。

---

## 1. 目标

做一个 pi 扩展，让模型在**连续会话**下：
- 默认运行在**只读**档（`read-only`），读全开、不落盘；
- 需要写/改时，**逐级批准升级**（`read-only → workspace-write → danger-full-access`），经人类确认；
- **无计划/构建相位**，无命令白名单，无读隐藏；沙箱只在**写面**做 OS 边界。

## 2. dsh 模型（源码锚点）

### 2.1 档位阶梯（`sandbox/src/index.ts:29`）
```ts
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

### 2.2 严格更宽（`escalation.ts:28`）
```ts
const WIDER_MODES = {
  'read-only':        ['workspace-write', 'danger-full-access'],
  'workspace-write':  ['danger-full-access'],
}
const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']
```

### 2.3 批准升级（`escalation.ts:157` `approveEscalation`）
执行前按序：
1. 校验 `requestedMode` 是否严格更宽于 `effectiveMode`（非更宽 → 抛错，**不弹窗**）；
2. 无 approval 通道 / 无 agent → fail-closed 抛错；
3. 走 `approver.request({ reason: 'escalate sandbox to <mode>: <justification>' })`；
4. 结果映射：`allowed-once` → 返回 granted mode；`rejected`/`cancelled`/`unavailable` → 抛对应文本。

### 2.4 模型侧标记（`escalation.ts:71/83`）
```ts
sandboxDenialMarker(mode)  → `[sandbox: file access denied under ${mode} mode]`
escalationHintMarker(subj) → `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (…) + justification; the approval prompt asks the user]`
```

### 2.5 fail-closed（`index.ts` `SandboxUnavailableError`）
confined 档请求但无可用后端 → 抛 `SANDBOX_UNAVAILABLE`，**绝不静默降级为无沙箱**。

## 3. pi 原生机制（映射基础）

| pi API | 说明 |
|---|---|
| `pi.registerTool` / `pi.setActiveTools` | 注册/调整工具面 |
| `createBashTool(root, { spawnHook })` | 覆盖 bash，`spawnHook` 注入 bwrap 前缀（Linux/WSL2） |
| `createPowerShellTool(root, { operations })` | 覆盖 pwsh，`operations.exec` 接 winacl（Windows） |
| `pi.on("tool_call")` | 命令/工具门控（block + reason） |
| `pi.on("before_agent_start")` | system prompt / notice 注入 |
| `pi.appendEntry` + 纯折叠 | 全局档位持久状态（日志真源，不建内存镜像） |
| `ctx.ui.select` | 人类批准（升级确认） |
| `pi.sendMessage` | 即时告知（升级结果 / 档位变化） |

## 4. 架构（packages/*）

```
packages/bridge   契约 + 共享纯函数：SandboxMode / WIDER_MODES / 严格更宽 / denial+hint 标记 / fail-closed 判定
packages/sandbox  OS 写面沙箱库：bwrap(Linux/WSL2) / winacl(Windows, pwsh, win32/ FFI 子包 + Node runner)
packages/core     唯一 pi 扩展宿主：全局档位折叠、bash/pwsh 工具注入、escalation 解析 + 批准、fail-closed
```

- 根 `index.ts` → 包根 re-export（`packages/core/src/index.ts`）。
- `pi.extensions` → 仅 core；sandbox/bridge 作为库被 core import（`BashSpawnHook` 同步约束 → 沙箱作为库、被 mode import，非独立扩展）。

## 5. 档位与批准（落地形态）

### 5.1 全局档
- 默认 `read-only`；持久状态经 `appendEntry`（事件折回），`session_start` 恢复。
- 档位是会话的全局写面策略，不随任何阶段切换。

### 5.2 写面拦截 + 升级
- bash/pwsh 工具接到命令 → 按当前全局档构造 `SandboxExecutionPolicy` → 后端 `confine`/`spawnHook`/`operations.exec`。
- **写被拒**（后端报 EROFS/EACCES 或预判写面）→ 返回 `{ block, reason: denialMarker + escalationHintMarker }`，模型看到标记。
- **模型升级**：调用带 `sandbox_permissions`（目标档）+ `justification` → core 解析：
  - 校验严格更宽（`WIDER_MODES[effectiveMode].includes(target)`）→ 非更宽直接拒绝（不弹窗）；
  - 走 `ctx.ui.select`（展示 justification）→ `allowed-once` → **仅本次调用**以目标档执行；`rejected`/cancelled → 拒绝。
- **升级只作用于本次调用**，不改全局档 → 不留持久更宽（不变量 5）。

### 5.3 fail-closed
- confined 档（read-only / workspace-write）但后端不可用（`probe()` 失败 / 加载失败 / koffi 载入失败）→ 抛 `SANDBOX_UNAVAILABLE`，拒绝裸跑。
- 模型若确需全权 → 显式切 `danger-full-access`（这本身也是一次升级，走批准）。

## 6. 后端

| 平台 | 后端 | shell | 写面实现 |
|---|---|---|---|
| Linux / WSL2 | bwrap | bash | `spawnHook` 注入：`--ro-bind / /`（写基座）+ 工作区 `--ro-bind`/`--bind`（按档）+ `/tmp` tmpfs |
| Windows | winacl | pwsh | `WRITE_RESTRICTED` token + NTFS ACE 写白名单 / deny-read（敏感目录）；`operations.exec` 经 Node runner |

- `selectBackend()` 按平台选；`probe()` 失败 → fail-closed。
- **winacl 由独立 Node runner 子进程承载**（Bun 宿主不能加载 koffi）；加载前 fail-closed 降级。

## 7. 设计不变量（摘要，详见根 AGENTS.md）

1. 沙箱管写面不含读面；读全开。
2. 档位全局持续，无阶段绑定、无子档。
3. 批准 = 逐级升级（严格更宽），禁用命令白名单。
4. fail-closed（无后端→ SANDBOX_UNAVAILABLE；非更宽→不弹窗）。
5. 批准不进模型上下文；升级仅 per-call，不留持久更宽。
6. 状态 = 日志折叠，禁双源。
7. 敏感路径凭"写面 + 出口"约束，不做 deny-read 名单。

## 8. 已知取舍

- 计划性工作流不在本扩展内，交由独立扩展承担。
- winacl `partial`；Windows shell=pwsh；koffi 依赖 Node runner；网络不掺和（dsh "outside vocabulary"）；devDep ≥0.84.4。

## 9. 验证

- `npm run typecheck`（strict）。
- `npm test`：档位折叠 / 严格更宽 / escalation 批准流（allowed-once / rejected / cancelled / unavailable / 非更宽不弹窗）/ fail-closed / denial+hint 标记 / `selectBackend` / bwrap / winacl 签名。
- `npm run probe`：bwrap `--version`；winacl pwsh-under-token + read-only 往返 + dispose 撤销。
