# pi-sandbox-dsh

一个 pi 扩展，用 OS 边界约束模型的**写入**动作——是「plan/强制」二分中的**强制轴**。
壳命令跑在 **OS 边界**内（Linux/WSL2 上是 bubblewrap）；`write`/`edit` 由**进程内 `tool_call` 护栏**兜住，
它**不是安全边界**。仅以单一参考源建模：[dsh](https://github.com/deepseek-ai/deepseek-harness)。

> 目录：[行为模型](#行为模型) · [安装](#安装) · [使用](#使用) · [平台支持](#平台支持) · [正交性](#正交性) · [设计规则](#设计规则) · [承诺强度](#承诺强度) · [延伸阅读](#延伸阅读)

## 行为模型

**连续 agent + 全局沙箱档位 + 渐进式批准**。无 plan/build 双模式、无命令白名单、无读取隐藏。

- 全局沙箱档位（默认 `read-only`）是持久、贯穿会话的写入策略——不绑定「规划阶段」。
- 档位阶梯严格只增：

  ```
  read-only          — 读取开放，禁止写入
  workspace-write    — 工作区内写入（+ 临时区）
  danger-full-access — 无任何限制
  ```

- 写入被拒时，模型看到 `[sandbox: file access denied under <mode> mode]` 标记。文件工具（`write`/`edit`）由门控
  **当场**征求批准（用户可「允许本次」）；被拒或无可交互通道时，模型看到拒绝理由与切档提示（`/sandbox <更宽档>`）
  ——pi 的 `write`/`edit` 无 per-call 升级参数。
- 阶梯规则（对齐 dsh `escalation.ts`，锚点 `ddefc45fbc`）：**重复当前生效档位无需批准**；更宽档位需批准且只作用于
  该次调用；更窄或非法目标在执行前失败。

## 安装

```bash
# 从本地克隆
pi install /absolute/path/to/pi-sandbox-dsh

# 或直接从 git
pi install git:github.com/Frost-rA9/pi-sandbox-dsh
```

前置条件：

- **Linux / WSL2** —— 需要 [bubblewrap](https://github.com/containers/bubblewrap)（`bwrap`），如 `sudo apt install bubblewrap`。
  后端不可用时受限壳**失败即关闭**（拒绝执行，绝不裸跑）。
- **Windows** —— 无需安装任何东西；见[平台支持](#平台支持)。

## 使用

- `/sandbox` —— 显示当前档位，或切换：`/sandbox <read-only|workspace-write|danger-full-access>`（仅 Linux/WSL2）。
  Windows 上只报告固定的 `danger-full-access`，并拒绝切换。
- 写入被拒会显示 `[sandbox: file access denied under <mode> mode]`；随后 `write`/`edit` 当场征求「允许本次」。
  升级仅针对单次调用，且从不进入模型上下文。

## 平台支持

| 平台 | 写面沙箱 | 壳 | 档位 |
|---|---|---|---|
| Linux / WSL2 | bubblewrap（**真实 OS 边界**） | 受限 `bash`（恒注册） | 三档阶梯，可切 |
| Windows | **无**（不宣称） | pi 默认（`bash` + `powershell`） | 固定 `danger-full-access`，不可切 |

Windows 上本扩展**不做任何约束**：固定运行在 `danger-full-access`，不注册壳覆盖、不注册写面门控，`/sandbox` 只报告
这个事实。这是有意为之，不是待补的缺口——唯一已实现的 Windows 机制（`WRITE_RESTRICTED` 受限令牌 + NTFS ACE 写白名单）
与 **Schannel/SSPI 平台级不兼容**：凡是走 Windows 原生 TLS 栈的 HTTPS 客户端（`curl`、`git https`、`Invoke-WebRequest`）
都在握手之前失败，且**任何特权/ACL 微调都修不了**。与其留一个「看着在管写、实际破坏原生 TLS」的形态，不如**移除
Windows 后端**。Linux/WSL2 完全不变。完整证据见 [docs/dsh-upstream-report.md](docs/dsh-upstream-report.md)。

## 正交性

「plan/强制」二分镜像 dsh 且完全正交：

| 轴 | 扩展 | 状态 | 角色 |
|---|---|---|---|
| 强制 | `pi-sandbox-dsh` | `sandbox/mode` | 写入边界：壳 = OS 边界；write/edit = 进程内护栏 |
| 引导 | `pi-plan-dsh` | `plan/mode` | 软提示引导 |

`sandbox` 从不读写 `plan` 状态（反之亦然）；二者独立、各自配置。镜像 dsh 自身的拆分：*"Plan mode is soft guidance.
Sandbox mode and approval policy enforce restrictions independently; neither reads nor writes plan state."* 这一对共同
**替代已弃用的 `pi-plan-mode`**。

## 设计规则

1. 沙箱只约束**写入**，从不约束**读取**——读取不受限。
2. 档位全局/连续；**无 `verify` 子档位**，也无 plan/build 切换。
3. 批准是**渐进式升级**（严格更宽的阶梯），不是逐命令弹窗也不是命令白名单；重复当前档位不构成批准。
4. **有后端时才失败即关闭**：Linux/WSL2 上受限档无可用后端时拒绝运行（`SANDBOX_UNAVAILABLE`），绝不静默无限制运行。
   Windows 根本没有后端 → 固定且可见的 `danger-full-access`（绝不宣称一个不存在的沙箱）。
5. 批准从不进入模型上下文；升级仅针对单次调用。

## 承诺强度

实际被强制的范围：

- **壳命令**（`bash`）跑在 bubblewrap 内：工作区外的写入被内核拒绝。对该工具而言这是**真实 OS 边界**。
- **`write` / `edit`** 由进程内 `tool_call` 门控（路径围栏）兜住。它与 pi 同进程、用用户自己的权限运行，因此是
  **护栏而非安全边界**——pi 官方安全文档明言，部分进程内沙箱"容易被误认为安全边界"。不要指望它挡住刻意的绕过；
  要强隔离就把整个 `pi` 进程放进容器/VM（pi `docs/containerization.md`）。
- 两层都**不约束** `!`（你自己敲的命令）与 RPC `bash`。

## 延伸阅读

- [docs/architecture.md](docs/architecture.md) —— pi 机制映射、不变量、已知取舍、验证入口。
- [docs/dsh-upstream-report.md](docs/dsh-upstream-report.md) —— Windows 决策背后的证据留档。

## 许可证

MIT
