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

- 写入被拒时，模型看到 `[sandbox: file access denied under <mode> mode]` 标记与可升级提示。它以 `sandbox_permissions`（严格更宽的最近档位）+ `justification` 重试；人工批准后**只有那次调用**在更宽档位下运行。

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
3. 批准是**渐进式升级**（严格更宽的阶梯），不是逐命令弹窗也不是命令白名单。
4. **失败即关闭**：受限制档位无可用后端时拒绝运行（`SANDBOX_UNAVAILABLE`），绝不静默无限制运行。
5. 批准从不进入模型上下文；升级仅针对单次调用。

## 后端

| 平台 | 后端 | Shell |
|---|---|---|
| Linux / WSL2 | bubblewrap | bash |
| Windows | restricted-token + NTFS ACE (winacl) | pwsh |

Windows 上模型可用的**受限**壳是 `pwsh`；默认的 `bash` 工具（git-bash）不具收敛能力（受限令牌跑不了它），
因此在 confined 档被**门控拦下**——只有 `danger-full-access` 才两者都放开。Linux 的受限壳本身就是 `bash`，
故同名覆盖完整、无此问题。详见 [docs/verify-windows.md](docs/verify-windows.md)。

Windows 前置：系统 `node`（Bun 宿主不能跑 Win32 runner 子进程；解析顺序 `PI_SANDBOX_NODE` → `PATH` → 用户/系统注册表
`Path`）与 `npm install` 装上的 `koffi`（optionalDependency）。受限令牌下 PowerShell 运行在 `ConstrainedLanguage`
（.NET 方法调用被禁）——机制固有代价，详见 [docs/verify-windows.md](docs/verify-windows.md)。

架构见 [docs/architecture.md](docs/architecture.md)，设计依据与已知取舍见 [DESIGN.md](DESIGN.md)。

## 许可证

MIT
