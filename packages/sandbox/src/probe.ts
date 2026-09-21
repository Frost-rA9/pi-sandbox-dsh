/**
 * pi-sandbox-dsh-sandbox · 真机 probe（`npm run probe`）。
 *
 * 结构测试（`npm test`）只验证纯函数与 argv 契约；本文件在**真机**验证后端能不能真正约束写面：
 * - Linux/WSL2：bwrap 可用性（完整 e2e 在 `test/bwrap-e2e.spec.ts`）。
 * - Windows：**无后端**——本扩展在该平台固定 `danger-full-access`（见 `docs/architecture.md`），故仅报告。
 *
 * 退出码 0 = 全部通过；1 = 有失败（fail-closed：Linux 探针失败即视为后端不可用）。
 */
import { probeBwrap } from "./bwrap.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

console.log(`=== pi-sandbox-dsh probe（platform=${process.platform}）===`);

if (process.platform === "win32") {
  console.log("=== Windows · 无沙箱后端 ===");
  console.log("  · 本扩展在 Windows 上不提供 OS 写面沙箱（受限令牌 × Schannel/SSPI 不兼容；见 docs/architecture.md）");
  console.log("  · 固定档位 danger-full-access，不可切换 → 无需探针");
} else {
  console.log("=== Linux/WSL2 · bwrap ===");
  const available = probeBwrap();
  assert(available, "bwrap 可用（probe 通过）", "bwrap --version 未通过 → 后端不可用（fail-closed）");
  if (available) {
    console.log("  完整写面 e2e 见 `npm test`（test/bwrap-e2e.spec.ts）");
  }
}

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
