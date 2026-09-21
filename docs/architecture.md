# pi-sandbox-dsh · 架构（精简）

> 用 **OS 边界**约束**壳命令**的写面（bwrap）；`write/edit` 由**进程内 `tool_call` 护栏**兜住（**非安全边界**）。连续 agent + 全局档位 + 逐级批准。读全开、网络不掺和、无命令白名单。
> 单一参考源 = dsh `packages/sandbox/{sandbox,sandbox-local,sandbox-policy}`；锚点 `ddefc45fbc`。
> **平台分叉（2026-09-21 决策）**：只有 **Linux/WSL2** 有 OS 写面沙箱（bwrap）；**Windows 无可用机制 → 固定 `danger-full-access`、不可切档**（见「已知取舍」）。
> 行为约束见 `AGENTS.md`（本地文件、不入库）；不变量、已知取舍与验证入口见本文。

## pi 机制映射

| 需求 | pi 原生机制 |
|---|---|
| 壳命令收敛（Linux/WSL2） | `createBashTool` + `spawnHook`（bwrap 包 argv） |
| 文件写面门控（Linux/WSL2） | `tool_call` 门控（write/edit；被拒 → `ui.select` 征求"允许本次"）——**护栏，非安全边界** |
| 档位持久状态（Linux/WSL2） | `appendEntry('sandbox-mode')` + `getEntries()` 折叠（禁内存真源） |
| 档位提示段 | `before_agent_start` 追加（≤ ~100 tok；档位不变时字节不变） |
| 徽标 / 告知 | `ui.setStatus` + `ui.notify`（英文文案） |
| 无沙箱平台（Windows） | 固定 `danger-full-access` + 启动通知 + `/sandbox` 只读；不注册壳覆盖/门控 |

## 结构

| 块 | 职责 | 实现 |
|---|---|---|
| core | 扩展宿主：平台分叉、档位折叠、受限壳注册与文件门控、`/sandbox`、不可用/无沙箱可见化 | `packages/core/src/{index,state,tools-fs}.ts` |
| bridge | 纯函数/类型：档位阶梯、严格更宽、denial/hint 标记、结果侧分类、fail-closed 词汇、无沙箱固定档 | `packages/bridge/src/index.ts` |
| sandbox | OS 写面沙箱库（**仅 Linux/WSL2**）：bwrap、后端选择、结果侧分类包装、真机 probe、路径围栏 | `packages/sandbox/src/{backend,bwrap,classify,containment,probe}.ts` |

## 关键语义

- **三档严格更宽（Linux/WSL2）**：`read-only` → `workspace-write` → `danger-full-access`；切档需用户确认；文件工具被拒可"允许本次"（per-call）。
  阶梯规则（对齐 dsh `escalation.ts`，锚点 `ddefc45fbc`）：**重复当前生效档 = 免批准**（不属于升级）；更宽 = 需批准且仅作用于该次调用；更窄或非法目标 = 执行前失败。
- **壳缝恒在位（Linux/WSL2）**：受限壳**恒注册**；后端不可用 → **调用点**抛 `SANDBOX_UNAVAILABLE`（绝不裸跑）；`danger-full-access` 才委托 pi 本地 shell。`probe()` 只出可见性（通知/徽标），不决定"有没有壳"。
- **无沙箱平台（Windows）**：`selectBackend()` 返回 `undefined` → core **不注册**受限壳、不注册文件门控、不折叠档位；`mode` 恒 `UNSANDBOXED_MODE = danger-full-access`；`/sandbox` 保留可见性但拒绝切换；启动发一条 warning 通知；徽标 `[danger-full-access] (no sandbox)`。**无后端 ≠ 后端不可用**：这不是 fail-closed 的失败，而是"本平台没有可宣称的沙箱"。
- **结果侧分类（Linux/WSL2）**：runner 失败（exit 门 + 致命签名）**优先于** denial → `SANDBOX_UNAVAILABLE`；denial = 非零退出 + 本后端方言（不取跨后端并集）；`danger` 无事实不判定；分类窗口取输出尾部 64 KiB。
- **bwrap 细节**：只读 bind 基座 `--ro-bind / /`；`workspace-write` 追加 `--tmpfs /tmp` + `--bind <workspace>`；`--unshare-pid`；**不 unshare 网络**；不掩码敏感路径（读全开）；env 白名单（PATH/HOME/代理，不含密钥）。

## 不变量（回退先改这里）

1. **管写面不管读面**；凭据靠"写面 + 网络出口"，不靠藏读。**承诺强度**：只有**壳（bwrap）**是 **OS 边界**；`write/edit` 的进程内 `tool_call` 门控是**护栏**（pi 官方明言"部分进程内沙箱容易被误认为安全边界"）——**不得宣称是安全边界**，强隔离按 pi 官方走整进程容器/VM。**写面之外的一切必须由断言证明不受影响**；因此**每条不变量/边界声明都要有一条可执行断言**（Linux/WSL2 见 `npm run probe`；Windows 的边界是"无沙箱"，由启动通知 + 固定档 + `/sandbox` 拒绝切换钉住）。
2. **档位 = 全局持续状态**，不与阶段绑定、无子档。**Windows 无阶梯**：只有固定 `danger-full-access`。
3. **批准 = 逐级升级（严格更宽）**，不是每命令弹窗、不是命令白名单；重复当前档位不构成批准（dsh `ddefc45fbc` 语义）。
4. **有后端的平台（Linux/WSL2）缝恒在位、不可用即拒**（`SANDBOX_UNAVAILABLE`，绝不裸跑）；**无后端的平台（Windows）固定 `danger-full-access`、不可切换**——**不假收敛**：不宣称一个不存在的沙箱。
5. 批准不进模型上下文；文件批准 per-call（布尔「允许本次」，不改档位），壳升级走全局 `/sandbox`（仅 Linux/WSL2）。
6. 状态 = 日志折叠，禁内存真源（仅 Linux/WSL2 有档位状态）。
7. 最小暴露面。
8. 切换/升级/不可用告知 = 通知机制（英文文案）。
9. 结果侧分类 = **事实判定**（runner 失败优先于 denial；denial 需非零退出 + 本后端方言；danger 不判定）。
10. **边界必须可见（不假收敛）**：Linux 后端不可用 → 工具面不变 + error 通知 + 徽标 `(no backend)` + 文件拒绝文案标注"档位策略拒绝"；**Windows 无沙箱 → 固定全权 + warning 通知 + 徽标 `(no sandbox)` + `/sandbox` 拒绝切换**。

## 已知取舍 / 边界

- 不做命令白名单；不做 plan/build 双模式；不隐藏读；`danger-full-access` 也要用户确认（Linux/WSL2）。
- **Windows 不做 OS 写面沙箱（2026-09-21 决策）**：唯一已实现的机制（`WRITE_RESTRICTED` 受限令牌 + NTFS ACE 写白名单）与 **Schannel/SSPI 平台级不兼容**——受限壳里一切走 Windows 原生 TLS 栈的 HTTPS（`curl`/`git https`/`Invoke-WebRequest`）在握手前失败（`SEC_E_NO_CREDENTIALS 0x8009030E`）；**去掉 `DISABLE_MAX_PRIVILEGE`、或往 restricting 列表补 SID 都无效**（已证伪），同族还有组件自建 DACL（Python `tempfile` → pip/pytest 不可用）等缺口。候选替代机制（Low Integrity + 强制标签）**社区未验证**、在 dsh 中**无参考实现**、采用即**丢参考锚点**。故**删除 win32 后端**：固定 `danger-full-access`、不注册壳覆盖/门控，模型拿 pi 默认壳工具（`bash` + `powershell`），`!` 命令照常。完整证据链、最小复现与上游 8+ 重复帖见 `docs/dsh-upstream-report.md`（**自用留档，不对外提交**）。
- Linux/WSL2 沙箱只限写面：不做读隔离、不做网络隔离、不做命令白名单；`danger-full-access` 是唯一出口。
- **文件工具不覆盖 temp（有意不对称）**：`writableRoots` 只返回工作区，**不移植** dsh 的 `/tmp` + `os.tmpdir()`。因为 bwrap 的 `/tmp` 是 `--tmpfs /tmp` 的**私有临时盘**、与宿主 `/tmp` 不是同一目录——把宿主 `/tmp` 当可写根会让 write/edit 够到一个**壳都够不到**的共享位置，扩大暴露面。temp 类 scratch 走壳（私有 tmpfs）；`npm test`（`sandbox.spec`）钉住这条不对称。
- **`containment` 的 ino=0 弱点（护栏的已知限制，非边界缺陷）**：`write/edit` 的路径围栏用 `dev+ino` 身份比对（`containment.ts` `sameIdentity`）；在 `ino` 恒为 0 的文件系统上（FAT/exFAT、部分网络卷），任意祖先都会与工作区根"同身份" → `isPathUnder` 恒真，`write/edit` 可越出工作区。与 dsh `fs-sandbox/containment.ts` **同源**（上游 #5198 已提 `ino === 0 → false`，未落地）。按不变量 1 的**承诺强度**，这是**护栏而非安全边界**的既有弱点（不承诺防住刻意绕过）；真正的写隔离请走 pi 官方容器/VM，或把 `write/edit` 路由进 OS 沙箱（官方 `gondolin` 模式）。
- **与 pi 官方隔离形态的关系（判定门 Q1/Q5 记录）**：pi 官方 **无内置沙箱**（`docs/security.md`）并劝退"部分进程内沙箱"；官方给出的形态是整进程容器/VM（Docker/OpenShell/Docker Sandboxes）或**工具路由扩展**（`examples/extensions/sandbox/` 用 `@anthropic-ai/sandbox-runtime` 覆盖 `bash` + 约束 `!`；`gondolin/` 覆盖 read/write/edit/bash/ls 路由进 micro-VM）。本扩展**不复用**它们，理由：① 官方 runtime/示例是**静态配置**（无档位阶梯/逐级批准），与本扩展的 dsh 轴不同；② 本扩展按**单一参考源 dsh** 移植 `bwrapProfileArgs`（逐字节一致），换官方 runtime 会丢参考锚点；③ 不引入额外依赖。**代价**：官方 runtime 覆盖 `!` 与网络/读策略，本扩展不覆盖（见下两条）。想要更强隔离时按 pi 官方建议把整个 pi 放进容器/VM。
- **不约束 `!`（`user_bash`）（Q1 记录）**：pi 原生可用 `user_bash` 拦截 `!`/`!!` 并注入 `operations`（官方 `sandbox` 示例即如此）。本扩展**有意不拦**：`!` 是**用户自己**敲的命令、用户是授权主体；沙箱约束的是 **agent** 的动作，不是用户直连（与 dsh 一致）。若将来要拦：给 bwrap 后端加一条 operations 适配（`user_bash` 没有 `spawnHook`）。
- **不提供读拒绝 / 网络策略（Q1 记录）**：pi 官方 `sandbox` 示例支持 `denyRead` 与网络域名白/黑名单。本扩展不变量 1 有意**读全开、网络不掺和**（dsh vocabulary 亦如此）；要读/网隔离请走整进程容器/VM。
- pi 的 `before_agent_start` 每用户轮只跑一次 → 同轮内切档后提示段滞后一轮（由 notice 补偿）。
- 分类窗口有界（64 KiB）；`user_bash`（`!`）与 RPC `bash` 不在约束内（边界声明）。
- 后端不可用时 confined 档**没有可用壳**（fail-closed 的代价；出口 = 修后端或显式 `danger-full-access`）。

## 验证

- `npm run typecheck`（strict）
- `npm test`：bridge 纯函数 / bwrap e2e / 结果侧分类 / core 装配与文件门控 / 不可用可见化 / **Windows 无沙箱装配**
- `npm run probe`（真机）：Linux/WSL2 → bwrap 可用性；Windows → 报告"无沙箱后端"（无需探针）
- 真机会话核查（pi SDK，不调模型）：`createAgentSession({ resourceLoader, sessionManager })` 后**必须** `await session.bindExtensions({})`
  —— `session_start` 是在 `bindExtensions` 里发出的（SDK 路径不会自动发），否则扩展根本没跑；随后 `session.getActiveToolNames()`：
  - **Linux/WSL2**：`read, bash, edit, write`（受限壳同名覆盖）；
  - **Windows**：`read, bash, edit, write, powershell`（pi 默认；扩展不摘壳、不注册门控），档位恒 `danger-full-access`。
