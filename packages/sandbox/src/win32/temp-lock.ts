/**
 * pi-sandbox-dsh-sandbox · 私有 temp 目录的占用锁（koffi 实现，Windows-only）。
 *
 * 为什么需要锁：宿主超时/中止会 kill runner，runner 的 `finally` 不跑 → 私有 temp 目录与其
 * 写 SID ACE 留在 `%TEMP%`。清扫（`temp-sweep.ts`）需要区分"死主的残留"与"活着的 runner 正在用"，
 * 判据就是这里持有的排他锁：CreateFileW **不带 FILE_SHARE_DELETE** + `LockFileEx` 排他，
 * 探测方非阻塞尝试同一把锁 —— 拿得到=持有者已死，拿不到（`ERROR_LOCK_VIOLATION`）=活体。
 *
 * 零窗口约定：`createPrivateTempDir` **先取锁再建目录**，因此任何本模块产出的私有目录必有锁文件；
 * 清扫侧把"没有锁文件"当作历史残留（另有 mtime 年龄门槛）处理。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  allocOverlapped,
  isInvalidHandle,
  throwLastError,
  throwWin32,
  type NativePtr,
  type Win32Bindings,
} from "./ffi.ts";
import { requireKoffi } from "./koffi.ts";
import {
  TEMP_DIR_PREFIX,
  TEMP_LOCK_DIR_NAME,
  tempLockPath,
  type TempLockProbe,
  type TempLockState,
} from "./temp-sweep.ts";
import * as abi from "./win32-abi.ts";

interface HeldLock {
  handle: NativePtr;
  overlapped: NativePtr;
  lockPath: string;
}

/** 打开（必要时创建）锁文件并尝试取排他锁；被占用返回 "busy"。 */
function openAndLock(api: Win32Bindings, lockPath: string, flags: number): HeldLock | "busy" {
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE, // 关键：不共享 delete（否则删除句柄不会被挡住）
    null,
    abi.OPEN_ALWAYS,
    0,
    null,
  );
  if (isInvalidHandle(handle)) throwLastError(api, "CreateFileW", lockPath);
  const overlapped = allocOverlapped(); // 全零：偏移 0、hEvent NULL（koffi 收到 NULL 会崩）
  if (api.lockFileEx(handle, flags, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(handle);
    requireKoffi().free(overlapped);
    if (win32Code === abi.ERROR_LOCK_VIOLATION) return "busy";
    throwWin32(api, "LockFileEx", win32Code, lockPath);
  }
  return { handle, overlapped, lockPath };
}

/** 释放锁句柄（best-effort：清理路径不应抛）。 */
function releaseLock(api: Win32Bindings, lock: HeldLock): void {
  try {
    api.unlockFileEx(lock.handle, 0, 1, 0, lock.overlapped);
  } catch {
    /* best-effort */
  }
  api.closeHandle(lock.handle);
  requireKoffi().free(lock.overlapped);
}

/** 一次私有 temp 目录的生命周期句柄。 */
export interface PrivateTempDir {
  /** 目录绝对路径。 */
  readonly dir: string;
  /** 占用锁文件路径。 */
  readonly lockPath: string;
  /** 释放占用锁（幂等）。 */
  release(): void;
  /** 释放占用锁 + 删目录 + 删锁文件（删除失败静默留给下次清扫）。 */
  remove(): void;
}

/**
 * 建一个本扩展的私有 temp 目录（先取锁再建目录）。
 * @param api - 绑定表。
 * @param tempRoot - `--temp` 根（必须已存在）。
 * @returns 目录与锁句柄；调用方必须在结束时 `remove()`。
 */
export function createPrivateTempDir(api: Win32Bindings, tempRoot: string): PrivateTempDir {
  mkdirSync(join(tempRoot, TEMP_LOCK_DIR_NAME), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const dir = join(tempRoot, `${TEMP_DIR_PREFIX}${randomBytes(5).toString("hex")}`);
    const lockPath = tempLockPath(tempRoot, dir);
    const outcome = openAndLock(
      api,
      lockPath,
      abi.LOCKFILE_EXCLUSIVE_LOCK | abi.LOCKFILE_FAIL_IMMEDIATELY,
    );
    if (outcome === "busy") continue; // 名字碰撞（概率极低）→ 换名重试
    mkdirSync(dir);
    let released = false;
    return {
      dir,
      lockPath,
      release: () => {
        if (released) return;
        released = true;
        releaseLock(api, outcome);
      },
      remove: () => {
        if (!released) {
          released = true;
          releaseLock(api, outcome);
        }
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* 留给下次清扫 */
        }
        try {
          rmSync(lockPath, { force: true });
        } catch {
          /* 留给下次清扫 */
        }
      },
    };
  }
  throw new Error(`createPrivateTempDir: could not acquire a temp-dir lock under ${tempRoot}`);
}

/**
 * 由绑定表构造清扫用的活体判定探针。
 * @param api - 绑定表。
 * @returns `temp-sweep.ts` 的 `TempLockProbe` 实现。
 */
export function createTempLockProbe(api: Win32Bindings): TempLockProbe {
  return {
    tryLock(dirPath: string): TempLockState {
      const lockPath = tempLockPath(dirname(dirPath), dirPath);
      if (!existsSync(lockPath)) return { state: "unlocked" };
      const outcome = openAndLock(
        api,
        lockPath,
        abi.LOCKFILE_EXCLUSIVE_LOCK | abi.LOCKFILE_FAIL_IMMEDIATELY,
      );
      if (outcome === "busy") return { state: "busy" };
      return { state: "available", release: () => releaseLock(api, outcome) };
    },
  };
}
