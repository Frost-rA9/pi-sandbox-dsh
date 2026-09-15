/**
 * pi-sandbox-dsh-sandbox · runner Node 解析单测（纯函数，任意平台可跑）。
 *
 * 背景：扩展进程的 PATH 可能不含 node（陈旧终端启动 pi），而 winacl runner 必须要一个系统 Node。
 * 真机行为（PATH → 注册表 Path 回退）由 `npm run probe` 与 Windows 真机验证覆盖；这里只测纯函数。
 */
import { nodeCandidatesFromPathList } from "../src/node-runtime.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

console.log("=== Windows 候选生成 ===");
const win = nodeCandidatesFromPathList("C:\\a;C:\\b;", "win32");
assert(win.length === 2, "忽略空段", JSON.stringify(win));
assert(win[0] === "C:\\a\\node.exe", "拼接 node.exe", String(win[0]));
assert(nodeCandidatesFromPathList("C:\\a;c:\\A", "win32").length === 1, "大小写不敏感去重");
assert(nodeCandidatesFromPathList('"C:\\Program Files\\x";C:\\b', "win32")[0] === "C:\\Program Files\\x\\node.exe", "去引号");

console.log("=== POSIX 候选生成 ===");
const posix = nodeCandidatesFromPathList("/usr/bin:/usr/local/bin:", "linux");
assert(posix.length === 2, "忽略空段", JSON.stringify(posix));
assert(posix[0] === "/usr/bin/node", "拼接 node", String(posix[0]));
assert(nodeCandidatesFromPathList("/usr/bin:/usr/bin", "linux").length === 1, "去重");
assert(nodeCandidatesFromPathList("  /opt/n  ", "linux")[0] === "/opt/n/node", "首尾空格容忍");

console.log("=== 边界 ===");
assert(nodeCandidatesFromPathList("", "linux").length === 0, "空 PATH → 无候选");
assert(nodeCandidatesFromPathList(";;;", "win32").length === 0, "全空段 → 无候选");

console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
