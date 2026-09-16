# pi-sandbox-dsh · 架构（精简）

> 用 **OS 边界**约束模型的**写**面：连续 agent + 全局档位 + 逐级批准。读全开、网络不掺和、无命令白名单。
> 单一参考源 = dsh `packages/sandbox/{sandbox,sandbox-local,sandbox-policy}` + `sandbox-windows-acl`
> （Windows 层另内联 dsh `packages/subprocess/win32-process`）；锚点 `0d1f50007f`。
> 行为约束见 `AGENTS.md`（本地文件、不入库）；不变量、已知取舍与验证入口见本文。

## pi 机制映射

| 需求 | pi 原生机制 |
|---|---|
| 壳命令收敛 | `createBashTool` + `spawnHook`（bwrap 包 argv）／`createPowerShellTool` + `operations`（winacl 走 Node runner） |
| 文件写面门控 | `tool_call` 门控（write/edit；被拒 → `ui.select` 征求"允许本次"） |
| 未接管的同类壳 | `tool_call` 门控（confined 档拦下另一个壳名字） |
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
- **壳缝恒在位**：受限壳**恒注册**；后端不可用 → **调用点**抛 `SANDBOX_UNAVAILABLE`（绝不裸跑）；`danger-full-access` 才委托 pi 本地 shell。`probe()` 只出可见性（通知/徽标），不决定"有没有壳"。
- **未接管的同类壳被门控**：pi 默认活跃壳名是 `bash`；Windows 受限壳只能叫 `powershell`（受限令牌 × git-bash 不兼容）→ confined 档拦下 `bash`，避免绕过；Linux 受限壳即 `bash`，同名覆盖完整。
- **结果侧分类**：runner 失败（exit 门 + 致命签名）**优先于** denial → `SANDBOX_UNAVAILABLE`；denial = 非零退出 + 本后端方言（不取跨后端并集）；`danger` 无事实不判定；分类窗口取输出尾部 64 KiB。
- **winacl 细节**：`WRITE_RESTRICTED` 令牌 + NTFS ACE 写白名单；runner 子进程（宿主 Bun 不能加载 koffi）；standalone grant（工作区 ACE 幂等 standing、temp 按次授予/撤销）；残留清扫（占用锁判死主）；Node 解析 `PI_SANDBOX_NODE` → `PATH` → 注册表 `Path`。

## 不变量（回退先改这里）

1. **管写面不管读面**；凭据靠"写面 + 网络出口"，不靠藏读。
2. **档位 = 全局持续状态**，不与阶段绑定、无子档。
3. **批准 = 逐级升级（严格更宽）**，不是每命令弹窗、不是命令白名单。
4. **缝恒在位、不可用即拒**（`SANDBOX_UNAVAILABLE`，绝不裸跑）；未接管的同类壳必须被门控。
5. 批准不进模型上下文；文件升级 per-call，壳升级走全局 `/sandbox`。
6. 状态 = 日志折叠，禁内存真源。
7. 最小暴露面。
8. 切换/升级/不可用告知 = 通知机制（英文文案）。
9. 结果侧分类 = **事实判定**（runner 失败优先于 denial；denial 需非零退出 + 本后端方言；danger 不判定）。
10. **后端不可用必须可见**（不假收敛）：工具面不变 + error 通知 + 徽标 `(no backend)` + 文件拒绝文案标注"档位策略拒绝"。

## 已知取舍 / 边界

- 不做命令白名单；不做 plan/build 双模式；不隐藏读；`danger-full-access` 也要用户确认。
- winacl `enforcement=partial`（Everyone / NTFS 硬链接 / 同身份读）；受限令牌下 pwsh = `ConstrainedLanguage`（.NET 方法调用被禁）。
- winacl 每命令一个 runner 子进程（净开销 ~80–100 ms）；宿主 kill 会留私有 temp 目录，由下次调用清扫。
- pi 的 `before_agent_start` 每用户轮只跑一次 → 同轮内切档后提示段滞后一轮（由 notice 补偿）。
- 分类窗口有界（64 KiB）；`user_bash`（`!`）与 RPC `bash` 不在约束内（边界声明）。
- 后端不可用时 confined 档**没有可用壳**（fail-closed 的代价；出口 = 修后端或显式 `danger-full-access`）。

## 验证

- `npm run typecheck`（strict）
- `npm test`：bridge 纯函数 / bwrap / winacl 契约 / 结果侧分类 / 清扫策略 / Node 解析 / core 装配与两条门控 / 不可用可见化
- `npm run probe`（真机）：bwrap，或 winacl 往返（read-only 写被拒、workspace-write 区内可写区外被拒、ACE 幂等、temp 无残留、清扫）
