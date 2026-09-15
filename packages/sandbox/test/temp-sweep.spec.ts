/**
 * pi-sandbox-dsh-sandbox · 私有 temp 目录清扫策略单测（**任意平台可跑**）。
 *
 * 被测对象是纯逻辑（`temp-sweep.ts`）：活体判定用注入探针模拟，因此不需要 koffi / Windows。
 * 真实 koffi 锁协议的跨进程行为由 `npm run probe` 的 Windows 段覆盖。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPrivateTempDirName,
  STALE_WITHOUT_LOCK_MS,
  sweepStaleTempDirs,
  TEMP_DIR_PREFIX,
  TEMP_LOCK_DIR_NAME,
  tempLockPath,
  type TempLockProbe,
  type TempLockState,
} from "../src/win32/temp-sweep.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "pi-sandbox-dsh-sweep-spec-"));
const lockDir = join(root, TEMP_LOCK_DIR_NAME);
mkdirSync(lockDir, { recursive: true });

const staleLocked = join(root, `${TEMP_DIR_PREFIX}stale-locked`);
const liveLocked = join(root, `${TEMP_DIR_PREFIX}live-locked`);
const freshUnlocked = join(root, `${TEMP_DIR_PREFIX}fresh-unlocked`);
const oldUnlocked = join(root, `${TEMP_DIR_PREFIX}old-unlocked`);
const ownDir = join(root, `${TEMP_DIR_PREFIX}own`);
const unrelated = join(root, "not-ours");
for (const dir of [staleLocked, liveLocked, freshUnlocked, oldUnlocked, ownDir, unrelated]) {
  mkdirSync(dir, { recursive: true });
}
// stale-locked / live-locked 有锁文件；old-unlocked 无锁但 mtime 够老。
for (const dir of [staleLocked, liveLocked]) writeFileSync(tempLockPath(root, dir), "", "utf8");
const oldTime = new Date(Date.now() - STALE_WITHOUT_LOCK_MS - 60_000);
utimesSync(oldUnlocked, oldTime, oldTime);

const released: string[] = [];
const probe: TempLockProbe = {
  tryLock(dirPath: string): TempLockState {
    if (dirPath === staleLocked) return { state: "available", release: () => released.push(dirPath) };
    if (dirPath === liveLocked) return { state: "busy" };
    if (dirPath === ownDir) throw new Error("ownDir 不该被探测");
    return { state: "unlocked" };
  },
};

const logged: string[] = [];
const result = sweepStaleTempDirs(root, probe, { ownDir, log: (line) => logged.push(line) });

console.log("=== 前缀/锁目录识别 ===");
assert(isPrivateTempDirName(`${TEMP_DIR_PREFIX}abc`), "私有目录前缀识别");
assert(!isPrivateTempDirName(TEMP_LOCK_DIR_NAME), "锁目录不被当成私有目录");
assert(!isPrivateTempDirName("random-dir"), "无关目录不被识别");

console.log("=== 清扫判定 ===");
assert(result.removed.length === 2, "恰好删两个（死主残留 + 老的无锁残留）", result.removed.join(", "));
assert(result.removed.includes(staleLocked), "死主（取得到锁）被清扫");
assert(result.removed.includes(oldUnlocked), "无锁但够老的残留被清扫");
assert(result.kept.length === 2, "恰好保留两个（活体 + 太新）", result.kept.join(", "));
assert(result.kept.includes(liveLocked), "活体（锁被持有）被保留");
assert(result.kept.includes(freshUnlocked), "无锁但新建的目录被保留（年龄门槛）");
assert(result.failures.length === 0, "无失败", result.failures.join(", "));
assert(released.includes(staleLocked), "清扫死主前先释放探测锁（否则 rm 会被锁句柄挡住）");

console.log("=== 落盘效果 ===");
assert(!existsSync(staleLocked), "死主目录已从磁盘删除");
assert(!existsSync(tempLockPath(root, staleLocked)), "死主锁文件一并清理");
assert(existsSync(liveLocked), "活体目录仍在磁盘上");
assert(existsSync(tempLockPath(root, liveLocked)), "活体锁文件未被动");
assert(existsSync(freshUnlocked), "太新目录未被删");
assert(existsSync(ownDir), "ownDir 被跳过（未被探测、未被删）");
assert(existsSync(unrelated), "无关目录未被删");
assert(logged.length === 2, "清扫日志行数 = 删除数", `实际 ${logged.length}`);
assert(statSync(ownDir).isDirectory(), "ownDir 仍是目录");

console.log("=== 失败隔离（probe 抛错 → 记 failure 且不删）===");
const throwing: TempLockProbe = {
  tryLock(): TempLockState {
    throw new Error("lock probe exploded");
  },
};
const isolated = sweepStaleTempDirs(root, throwing, {});
assert(isolated.removed.length === 0 && isolated.failures.length > 0, "probe 抛错被记入 failures（不中断）",
  `removed=${isolated.removed.length} failures=${isolated.failures.length}`);

rmSync(root, { recursive: true, force: true });
console.log(`\n结果是: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
