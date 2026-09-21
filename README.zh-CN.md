# pi-sandbox-dsh

一个 pi 扩展，用 OS 边界约束模型的**写入**动作——是「plan/强制」二分中的**强制轴**。仅以单一参考源建模：[dsh](https://github.com/deepseek-ai/deepseek-harness)。

## 模型

**连续 agent + 全局沙箱档位 + 渐进式批准**。无 plan/build 双模式、无命令白名单、无读取隐藏。

- 全局沙箱档位（默认 `read-only`）是持久、贯穿会话的写入策略——不绑定「规划阶段」。
- 档位阶梯严格只增：

  ```
  read-only          — 读取开放，禁止写入
  workspace-write    — 工作区内写入（+ 临时区）
  danger-full-access — 无任何限制
  ```

- 写入被拒时，模型看到 `[sandbox: file access denied under <mode> mode]` 标记。文件工具（write/edit）由门控**当场**征求批准（用户可「允许本次」）；被拒或无可交互通道时，模型看到拒绝理由与切档提示（`/sandbox <更宽档>`）——pi 的 write/edit 无 per-call 升级参数。
- 阶梯规则（对齐 dsh `escalation.ts`，锚点 `ddefc45fbc`）：**重复当前生效档位无需批准**；更宽档位需批准且只作用于该次调用；更窄或非法目标在执行前失败。

## 正交性

「plan/强制」二分镜像 dsh 且完全正交：

| 轴 | 扩展 | 状态 | 角色 |
|---|---|---|---|
| 强制 | `pi-sandbox-dsh` | `sandbox/mode` | 写入边界的 OS 沙箱 |
| 引导 | `pi-plan-dsh` | `plan/mode` | 软提示引导 |

`sandbox` 从不读写 `plan` 状态（反之亦然）；二者独立、各自配置。镜像 dsh 自身的拆分：*"Plan mode is soft guidance. Sandbox mode and approval policy enforce restrictions independently; neither reads nor writes plan state."* 这一对共同**替代已弃用的 `pi-plan-mode`**。

## 设计规则

1. 沙箱只约束**写入**，从不约束**读取**——读取不受限。
2. 档位全局/连续；**无 `verify` 子档位**，也无 plan/build 切换。
3. 批准是**渐进式升级**（严格更宽的阶梯），不是逐命令弹窗也不是命令白名单；重复当前档位不构成批准。
4. **有后端时才失败即关闭**：Linux/WSL2 上受限档无可用后端时拒绝运行（`SANDBOX_UNAVAILABLE`），绝不静默无限制运行。Windows 根本没有后端 → 固定且可见的 `danger-full-access`（绝不宣称一个不存在的沙箱）。
5. 批准从不进入模型上下文；升级仅针对单次调用。

## 后端

| 平台 | 后端 | Shell |
|---|---|---|
| Linux / WSL2 | bubblewrap | bash |
| Windows | **无** —— 固定 `danger-full-access` | pi 默认（`bash` + `powershell`） |

### Windows 不做 OS 写面沙箱

Windows 上本扩展**不做任何约束**：固定运行在 `danger-full-access`，`/sandbox` 只报告这个事实（拒绝切换）。
这是有意为之，不是待补的缺口：

- 唯一已实现的 Windows 机制——`WRITE_RESTRICTED` 受限令牌 + NTFS ACE 写白名单——与 **Schannel/SSPI 平台级不兼容**：
  凡是走 Windows 原生 TLS 栈的 HTTPS 客户端（`curl`、`git https`、`Invoke-WebRequest`）都在握手之前失败，报
  `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030E)`。去掉 `DISABLE_MAX_PRIVILEGE`
  或往 restricting 列表里加 SID 都无效 → **任何特权/ACL 微调都修不了**（实测；证据留档在
  [docs/dsh-upstream-report.md](docs/dsh-upstream-report.md)）。基于 Python `tempfile` 的工具（pip/pytest）是另一个
  独立缺口，且没有绕法。
- 候选替代机制（Low Integrity + 强制标签）**未经社区验证**，在**单一参考源 dsh 里没有对应实现**，采用它会丢掉参考锚点——
  对一个只管写面的边界来说，代价太大。
- 与其留一个「看着在管写、实际破坏原生 TLS」的形态，不如**移除 Windows 后端**、如实声明边界：无 OS 沙箱、不可切档。

因为没有约束，Windows 上不注册任何壳覆盖与写面门控：模型拿到 pi 默认的壳工具，你自己敲的 `!` 命令也照常。
Linux/WSL2 完全不变（bubblewrap + fail-closed）。

架构、不变量与已知取舍见 [docs/architecture.md](docs/architecture.md)。

## 许可证

MIT
