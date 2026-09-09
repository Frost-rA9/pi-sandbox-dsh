# pi-sandbox-dsh · Linux 真机验证指南

> 目标：在真实 pi 会话里挂载 pi-sandbox-dsh，人工验证 Linux 写面沙箱行为。
> 前提：本机为 Linux / WSL2，`bwrap` 已在 PATH（`bwrap --version`），pi 已安装，`node_modules` 已就位。

---

## 1. 加载扩展（二选一）

### 方法 A · 快速单测（临时）
```bash
cd /home/lou/projects/pi-extensions/pi-sandbox-dsh
pi -e ./index.ts
```
单会话加载，改动只影响当前进程。

### 方法 B · 常驻（自动发现 + `/reload`）
```bash
# 软链整个仓（含 node_modules，workspace 依赖 file: 相对解析仍有效）
ln -s /home/lou/projects/pi-extensions/pi-sandbox-dsh ~/.pi/agent/extensions/pi-sandbox-dsh
```
启动 pi 后 `/reload`；全局对所有项目生效。也可放 `.pi/extensions/`（项目级）。

> 验证加载：`/config` 里应出现 `pi-sandbox-dsh/index.ts`。若报依赖解析错误，先 `cd pi-sandbox-dsh && npm install`。

---

## 2. 验证清单（read-only 默认档）

> 启动后默认 `read-only`（fail-safe）。可随时 `/sandbox` 查看当前档。

### 2.1 `/sandbox` 命令
```
/sandbox
```
预期：通知显示 `当前沙箱档: read-only` + 描述 + 可切换档位。

### 2.2 系统提示含档位段
让模型看它收到的系统提示（或直接问模型"当前沙箱档/文件策略"）。预期：出现
`Current DSH file policy: read-only. ...`。

### 2.3 read-only：bash 写被拒、读全开
```bash
write 到工作区外的路径（或 `bash` 里 echo > 文件）
```
- **写**：`bash` 里 `echo hi > /tmp/x.txt`（工作区外）或其内写 → 预期 **Read-only file system / 拒绝**。
- **读**：`bash` 里 `cat` / `read` 工作区内文件、`~/.gitconfig`、`/etc/hostname` → 预期 **成功**（读不受限）。
- **无凭据隐藏**：`read` 工具的 `~/.pi/agent/settings.json`、`~/.gitconfig` → 预期读到真值（不藏读）。

### 2.4 read-only：文件工具（write/edit）被门控
```bash
用 write 写一个文件 / 用 edit 改一个文件
```
预期：`tool_call` 门控拦截 → **征求批准（允许本次 / 拒绝）**（`ctx.ui.select`），或拒绝时返回
`[sandbox: file access denied under read-only mode]` + escalation hint。

### 2.5 `/sandbox workspace-write`：工作区可写、读仍全开
```
/sandbox workspace-write
```
预期：切更宽档会 **确认弹窗**（用户决策点）→ 确认后生效。
- **写**：`bash`/`write` 写入**工作区内** → 成功；写入**工作区外** → 门控/拒绝。
- **读**：仍全开。

### 2.6 `/sandbox danger-full-access`：绕过沙箱
```
/sandbox danger-full-access
```
预期：更宽档确认后 → bash / write / edit **不再受限**（能写任意路径）。

### 2.7 降回 read-only + fail-closed
```
/sandbox read-only
```
预期：恢复只读。

---

## 3. 回归自动测试（CI/本地）

```bash
cd /home/lou/projects/pi-extensions/pi-sandbox-dsh
npm run typecheck          # strict，三包
npm test                   # bridge 35 / core 10 / load 8 / sandbox 23 / winacl 15 / e2e 7
```
`bwrap-e2e.spec.ts` 会用真机 bwrap 执行，验证 read-only 写拒/读开/workspace 写/无凭据隐藏。

---

## 4. 排查

| 症状 | 排查 |
|---|---|
| `/config` 无扩展 | 扩展目录/软链位置正确？`npm install`？改用方法 A |
| 依赖解析错误 | `cd pi-sandbox-dsh && npm install && npm run typecheck` |
| bash 未被沙箱 | `bwrap --version` 可用？后端 probe 通过（否则 `backendError` 记录、bash 未加收敛） |
| 文件工具未拦 | `tool_call` 门控是否注册（`load.spec.ts` 已覆盖）；`write`/`edit` 参数是 `path` |
| 升级不弹窗 | 当前档为 `danger-full-access` 时**不广告**升级（`shouldAdvertiseEscalation`）；无 UI（非交互）时不走 `ui.select` |
