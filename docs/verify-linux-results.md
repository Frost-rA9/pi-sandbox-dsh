# pi-sandbox-dsh · Linux 真机验证结果

> 按 `docs/verify-linux.md` 清单，在**真实 pi 会话 + 本机 bwrap（0.11.1，WSL2 Linux）**挂载 pi-sandbox-dsh 完成全量人工验证。
> 范围：§2 运行行为（read-only / workspace-write / danger 三档）× §3 回归自动测试。
> 验证时间以用户切换 `/sandbox` 通知为准；环境为 `node v24.20.0（volta）+ npm 11.19.0`。

---

## §2 运行行为验证清单 —— 全部通过

| 检查项 | 结果 | 实测说明 |
|---|---|---|
| 2.1 `/sandbox` 查看 / 切换 | ✅ | 空参显示当前档；升档（read-only→workspace-write→danger）**弹确认框**；降档（→read-only）**无确认框、立即生效** |
| 2.2 系统提示含档位段 | ✅ | 系统提示含 `Current DSH file policy: read-only.` |
| 2.3 read-only：bash 写被拒 | ✅ | 写 `/tmp`、写工作区均报 `Read-only file system`(EROFS) |
| 2.3 read-only：读全开 | ✅ | `cat /etc/hostname`、家目录 / git 文件可读 |
| 2.3 无凭据隐藏 | ✅ | reads 返回真值，不藏读 |
| 2.4 write/edit 门控 deny 分支 | ✅ | 被拒返回 `[sandbox: file access denied under read-only mode]`<br>+ `[sandbox: escalation available ... sandbox_permissions ...]` hint |
| 2.4 write/edit 门控 allow 分支（per-call） | ✅ | 选「允许本次」→ **仅本次**写入成功 |
| 2.5 workspace-write 切档确认 | ✅ | 切更宽档弹确认框；选「切换」生效 |
| 2.5 workspace-write：写工作区放行 | ✅ | 工作区内 write **直接放行无弹窗**；bash 亦可写工作区 |
| 2.5 workspace-write：写工作区外门控 | ✅ | write 工具写 `/tmp` 被拒：`目标不在工作区内` + hint |
| 2.6 danger：绕过沙箱 | ✅ | bash / write 写家目录、`/tmp`、工作区任意路径**均放行、无弹窗** |
| 2.7 降回 read-only + fail-closed | ✅ | bash 写恢复 EROFS，读仍全开 |

## §3 回归自动测试 —— 全部通过

| 项 | 结果 |
|---|---|
| `npm run typecheck`（bridge / core / sandbox） | ✅ 三包全过 |
| bridge / core / load 单测 | ✅ 35 / 10 / 8 passed |
| sandbox.spec + winacl.spec + bwrap-e2e.spec | ✅ 23 / 15 / 7 passed |

> sandbox 包自测在 **danger-full-access** 档跑通（见发现 1）。

## 发现与建议（供写入 `AGENTS.md` 已知取舍 / 待补）

1. **sandbox 包自测必须在未沙箱化环境跑**：`sandbox.spec.ts:70`、`bwrap-e2e.spec.ts` 用 `mkdtemp` 在 `/tmp` 建临时目录；read-only 档 `/tmp` 只读 → EROFS。在 pi 内跑：
   - ✅ 切 **danger**（bash 未 wrap，真实 `/tmp` + 可 spawn 嵌套 bwrap）→ 通过。
   - ❌ **不可用 workspace-write**：该档是 bwrap 内嵌 bwrap，e2e 的嵌套 spawn 大概率失败。
   - 最稳妥仍是独立终端（`export PATH="$HOME/.volta/bin:$PATH"` 后 `npm test -w pi-sandbox-dsh-sandbox`）。

2. **文档 §2.5「bash 写入工作区外 → 门控/拒绝」表述偏粗**。实测三者机制不同：
   - bash 写 `/tmp` 在 workspace-write 下**成功**：bwrap 对 `/tmp` 做 `--tmpfs`（设计如此，工具可用临时目录）。
   - bash 写**真正工作区外**（如家目录）是 **OS 只读 EROFS**。
   - write / edit **工具**写工作区外才是**门控弹窗**（`ctx.ui.select`）。
   - 建议把 §2.5 的描述按「bash / 文件工具」两类拆分。

3. **`npm run probe` 指向缺失文件**：`package.json` 的 probe 脚本指向 `packages/sandbox/src/probe.ts`，但该文件**不存在**于源码树（`AGENTS.md` §8 提及 probe）。属待补。

4. **`load.spec.ts` 覆盖度不足**：只断言 `tool_call` 钩子"已注册"，**不测实际拦截结果**（deny / allow 分支）。建议补一条直接喂 `ToolCallEvent` 的用例。纯函数 `classifyFileWrite` 逻辑在验证过程中单独确认正确（read-only / workspace-write / danger 判定均符合预期）。

## 产物与收尾状态

- 验证期间产生的所有探针文件已删除；工作区 `git status` 干净，未提交任何改动。
- 验证结束时沙箱档位恢复为默认 **read-only**（fail-safe）。

---

## §4 结果侧分类增量验证（参考源刷新到 dsh `0d1f50007f` / `0.1.6-alpha.1`）

> 变更：把 dsh 的"结果侧分类"（runner 失败 vs 策略拒绝）首次接入 pi 的 shell 工具缝。
> 环境：WSL2 Linux + bwrap 0.11.1 + `node v24.20.0`（volta）+ npm 11.19.0。
> 本轮在 **workspace-write** 档内执行（`npm test` 含 bwrap 嵌套 spawn，实测通过）。

### 自动测试

| 项 | 结果 |
|---|---|
| `npm run typecheck`（bridge / core / sandbox） | ✅ 三包全过（strict） |
| bridge（含新分类用例） | ✅ 52 passed |
| core / load | ✅ 10 / 13 passed |
| sandbox / winacl / **classify（新）** | ✅ 23 / 15 / 20 passed |
| bwrap-e2e（真实 bwrap + 生产路径分类） | ✅ 15 passed |

### 真实 bwrap 端到端（生产路径：`spawnHook` → `operations.exec`）

| 场景 | 期望 | 实测 |
|---|---|---|
| read-only 下 `echo hi > 工作区文件` | 退出非零 + 模型可见输出尾部含 `[sandbox: file access denied under read-only mode]` + 切档提示 | ✅ EROFS 真实触发，标记落在命令输出之后 |
| read-only 下 `wc -c <文件>` | 退出 0、**无**标记 | ✅ |
| PATH 前置假 `bwrap`（打印 `bwrap: …` 致命行 + 一行 denial 方言，退出 1） | 抛错、`code=SANDBOX_UNAVAILABLE`、文案含 "not a policy denial"、**不追** denial 标记 | ✅ runner 失败优先于 denial |

### 发现

1. **runner 失败路径需要 process 级 PATH 才能端到端模拟**：bwrap 后端的 `spawnHook` 用白名单 env（取自 `process.env`，不含密钥），所以测试里传 `env` 无法影响它；注入假 `bwrap` 只能改 `process.env.PATH`（测完还原）。这不是缺陷，是既有 env 白名单设计的直接结果，已写入 `DESIGN.md` §七。
2. **pi 的 shell 工具没有后台任务路径**（schema 只有 `command / timeout`）：原计划里的"后台任务是否绕开收敛"核对结论 = 无该路径，无需收敛（dsh `processJob` 在 pi 无对应物）。
3. **`user_bash`（`!` / `!!`）不经本扩展**：用户自己的命令走 pi 独立缝（默认本地 bash operations）；按"沙箱管模型写面"的定位不拦截，已在 `DESIGN.md` §七 记为边界。
4. 与旧记录「sandbox 包自测不可用 workspace-write（嵌套 bwrap 大概率失败）」相反：本轮 workspace-write 档内嵌套 bwrap **通过**（WSL2 userns 允许嵌套）。仍建议优先在未沙箱化终端跑 sandbox 包自测，但不再是硬约束。

### 收尾

- 未提交任何改动；工作区改动留待明确指示后再提交。
