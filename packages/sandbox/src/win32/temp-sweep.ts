/**
 * pi-sandbox-dsh-sandbox · 私有 temp 目录的清扫策略（**纯逻辑 + 注入式活体判定**）。
 *
 * 背景：workspace-write 的每次执行都会在 `--temp` 下建一个 `pi-sandbox-dsh-<rand>` 私有目录
 * （其写 SID ACE 只覆盖该目录）。宿主在超时/中止时 kill runner，runner 的 `finally` 不会跑
 * → 该目录（及其 ACE）会留在 `%TEMP%`。本模块提供"下次运行时顺手清扫"的判定与执行。
 *
 * 活体判定契约（`TempLockProbe`）：对某目录的占用锁做**非阻塞**尝试。
 * - `available` = 拿到锁 → 原持有者已死 → 可清扫（必须先 release 再删目录：锁句柄会挡住删除）；
 * - `busy`      = 锁被他人持有 → 目录属于活着的 runner → 跳过；
 * - `unlocked`  = 没有锁文件 → 历史残留（本仓代码建目录前必先取锁）→ 按 mtime 年龄门槛决定。
 * 锁文件命名：`<tempRoot>/pi-sandbox-dsh-locks/<目录名>.lock`；实现在 `temp-lock.ts`（需要 koffi），
 * 本文件只依赖注入接口 → 可在任意平台单测（见 `test/temp-sweep.spec.ts`）。
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** 私有 temp 目录名前缀（runner 建目录、probe/测试造样本都用它）。 */
export const TEMP_DIR_PREFIX = "pi-sandbox-dsh-";
/** 占用锁目录名（位于 tempRoot 之下，与私有目录同级）。 */
export const TEMP_LOCK_DIR_NAME = "pi-sandbox-dsh-locks";
/**
 * 无锁文件时的年龄门槛：本仓代码建目录前必先取锁（见 `temp-lock.ts`），
 * 所以"无锁文件"只可能是历史残留或手工产物 —— 仍需够老才动，避免误伤刚要建目录的 runner。
 */
export const STALE_WITHOUT_LOCK_MS = 5 * 60 * 1000;

/** 一次非阻塞锁探测的结果。 */
export type TempLockState =
  | { state: "available"; release: () => void }
  | { state: "busy" }
  | { state: "unlocked" };

/** 非阻塞锁探测（生产实现见 `temp-lock.ts`）。 */
export interface TempLockProbe {
  tryLock(dirPath: string): TempLockState;
}

export interface TempSweepResult {
  /** 已删除的目录。 */
  removed: string[];
  /** 判定为活体 / 太新而保留的目录。 */
  kept: string[];
  /** 失败（含原因）。 */
  failures: string[];
}

/** 某私有 temp 目录对应的占用锁文件路径。 */
export function tempLockPath(tempRoot: string, dirPath: string): string {
  return join(tempRoot, TEMP_LOCK_DIR_NAME, `${basename(dirPath)}.lock`);
}

/** 该目录名是否属于本扩展的私有 temp 目录（排除锁目录自身）。 */
export function isPrivateTempDirName(name: string): boolean {
  return name.startsWith(TEMP_DIR_PREFIX) && name !== TEMP_LOCK_DIR_NAME;
}

/**
 * 清扫 `tempRoot` 下属于本扩展的残留私有目录。
 *
 * 只碰 `pi-sandbox-dsh-` 前缀的目录；`ownDir`（当前 runner 自己的目录）永远跳过。
 * @param tempRoot - 私有目录的父目录（runner 的 `--temp`）。
 * @param probe - 活体判定（生产用 `temp-lock.ts` 的 koffi 实现）。
 * @param options - `ownDir` 排除自身；`log` 收警告行。
 * @returns 删除/保留/失败清单（调用方决定怎么报）。
 */
export function sweepStaleTempDirs(
  tempRoot: string,
  probe: TempLockProbe,
  options: { ownDir?: string; log?: (line: string) => void } = {},
): TempSweepResult {
  const result: TempSweepResult = { removed: [], kept: [], failures: [] };
  const ownDir = options.ownDir === undefined ? undefined : resolve(options.ownDir);
  let entries;
  try {
    entries = readdirSync(tempRoot, { withFileTypes: true });
  } catch (error) {
    result.failures.push(`readdir(${tempRoot}): ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isPrivateTempDirName(entry.name)) continue;
    const dirPath = join(tempRoot, entry.name);
    if (ownDir !== undefined && resolve(dirPath) === ownDir) continue;

    let probeResult: TempLockState;
    try {
      probeResult = probe.tryLock(dirPath);
    } catch (error) {
      // 探测失败不中断整个清扫；该目录本轮不动。
      result.failures.push(`${dirPath}: lock probe failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (probeResult.state === "busy") {
      result.kept.push(dirPath);
      continue;
    }
    if (probeResult.state === "available") {
      // 先释放探测锁再删目录：锁句柄会挡住 rmSync。
      try {
        probeResult.release();
      } catch (error) {
        result.failures.push(`${dirPath}: releasing probe lock failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    } else {
      // 无锁文件：只清扫足够老的残留（避免误伤尚未取锁的新目录）。
      let ageMs: number;
      try {
        ageMs = Date.now() - statSync(dirPath).mtimeMs;
      } catch (error) {
        result.failures.push(`${dirPath}: stat failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (ageMs < STALE_WITHOUT_LOCK_MS) {
        result.kept.push(dirPath);
        continue;
      }
    }

    try {
      rmSync(dirPath, { recursive: true, force: true });
      result.removed.push(dirPath);
      options.log?.(`swept stale private temp dir: ${dirPath}`);
      // 锁文件一并清掉（此刻已无人持有；失败留给下次）。
      try {
        rmSync(tempLockPath(tempRoot, dirPath), { force: true });
      } catch {
        /* best-effort */
      }
    } catch (error) {
      result.failures.push(`${dirPath}: rm failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
