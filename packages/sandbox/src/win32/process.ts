/**
 * pi-sandbox-dsh-sandbox · Win32 进程操作（受限令牌子进程）。
 *
 * 单一源 = dsh `subprocess/win32-process/src/process.ts`，**裁剪**为 pi 需要的形状：
 * - 保留：命令行引号规则、CreateProcessAsUserW（受限令牌）两种 stdio 形态、Job（kill-on-close）、
 *   管道排空、退出码等待、能力探针。
 * - 去掉：`spawnCurrentTokenJobProcess`（当前令牌 + 载体 fd，dsh 用于它的子进程控制面）、
 *   control-stdio 继承（pi 无对应概念）。
 */
import * as abi from "./abi.ts";
import {
  allocProcessInfo,
  allocPtrSlot,
  allocStartupInfo,
  allocUint32,
  decodeProcessInfo,
  decodePtr,
  decodeUint32,
  encodeStartupInfo,
  isNullPtr,
  throwLastError,
  throwWin32,
} from "./ffi.ts";
import type { NativePtr, Win32Bindings } from "./ffi.ts";
import { requireKoffi } from "./koffi.ts";

/**
 * 按 CommandLineToArgvW 规则给单个参数加引号。
 * @param argument - 一个 argv 项。
 * @returns 裸串或加引号后的命令行片段。
 */
export function quoteArg(argument: string): string {
  if (argument === "") return '""';
  if (!/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  for (let index = 0; index < argument.length; index++) {
    let backslashes = 0;
    while (index < argument.length && argument.charAt(index) === "\\") {
      backslashes += 1;
      index += 1;
    }
    if (index === argument.length) {
      quoted += "\\".repeat(backslashes * 2);
    } else if (argument.charAt(index) === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += "\\".repeat(backslashes) + argument.charAt(index);
    }
  }
  return quoted + '"';
}

/**
 * 构造 CreateProcessAsUserW 接受的命令行。
 * @param program - 可执行文件 argv[0]。
 * @param args - 其余 argv。
 * @returns 拼接后的 Win32 命令行。
 */
export function buildCommandLine(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteArg).join(" ");
}

interface RestrictedProcessSpawnOptions {
  /** 透传给 CreateProcess 的可执行 argv[0]。 */
  command: string;
  /** 不含可执行文件的参数。 */
  args: readonly string[];
  /** 子进程工作目录。 */
  cwd: string;
  /** 受限主令牌。 */
  token: NativePtr;
}

/** 管道 stdio 子进程：进程句柄与读端句柄归调用方所有。 */
export interface SpawnedPipedProcess {
  /** 直接子进程 id。 */
  pid: number;
  /** 由 waitForProcessExit 关闭的进程句柄。 */
  process: NativePtr;
  /** 由 drainPipe 关闭的 stdout 管道读端。 */
  stdoutRead: NativePtr;
  /** 由 drainPipe 关闭的 stderr 管道读端。 */
  stderrRead: NativePtr;
}

/** 已挂入调用方 kill-on-close Job 的挂起子进程。 */
export interface SpawnedJobProcess {
  /** 直接子进程 id。 */
  pid: number;
  /** 由 waitForProcessExit 关闭的进程句柄。 */
  process: NativePtr;
  /** 由生命周期所有者关闭的 Job 句柄。 */
  job: NativePtr;
}

interface PipePair {
  read: NativePtr;
  write: NativePtr;
}

function freeNative(pointer: NativePtr | undefined): void {
  if (pointer !== undefined) requireKoffi().free(pointer);
}

function closeBestEffort(api: Win32Bindings, handle: NativePtr | null | undefined): void {
  if (!isNullPtr(handle)) api.closeHandle(handle);
}

function createPipe(api: Win32Bindings, owned: Set<NativePtr>): PipePair {
  const readSlot = allocPtrSlot();
  let writeSlot: NativePtr | undefined;
  try {
    writeSlot = allocPtrSlot();
    if (api.createPipe(readSlot, writeSlot, null, 0) === 0) throwLastError(api, "CreatePipe");
    const read = decodePtr(readSlot);
    const write = decodePtr(writeSlot);
    if (read === null || write === null) {
      closeBestEffort(api, read);
      closeBestEffort(api, write);
      throwLastError(api, "CreatePipe", "null pipe handle");
    }
    owned.add(read);
    owned.add(write);
    return { read, write };
  } finally {
    freeNative(writeSlot);
    requireKoffi().free(readSlot);
  }
}

function closeOwned(api: Win32Bindings, owned: Set<NativePtr>, handle: NativePtr): void {
  if (!owned.delete(handle)) return;
  api.closeHandle(handle);
}

function closeAllOwned(api: Win32Bindings, owned: Set<NativePtr>): void {
  for (const handle of owned) api.closeHandle(handle);
  owned.clear();
}

function createRestrictedProcess(
  api: Win32Bindings,
  options: RestrictedProcessSpawnOptions,
  commandLine: string,
  creationFlags: number,
  startupInfo: NativePtr,
  processInfo: NativePtr,
): number {
  // 沙箱在调用前改的是自己的进程环境；把显式环境块交给 koffi 会让
  // CreateProcessAsUserW 以 ERROR_INVALID_PARAMETER 拒绝，故 lpEnvironment 保持 NULL。
  return api.createProcessAsUserW(
    options.token,
    null,
    commandLine,
    null,
    null,
    1,
    creationFlags,
    null,
    options.cwd,
    startupInfo,
    processInfo,
  );
}

/**
 * 以匿名管道 stdout/stderr 拉起子进程（stdin 立即 EOF）。
 * @param api - 生效的绑定表。
 * @param options - 命令、cwd、argv 与受限主令牌。
 * @returns 调用方持有的进程与管道读端句柄。
 */
export function spawnPipedProcess(
  api: Win32Bindings,
  options: RestrictedProcessSpawnOptions,
): SpawnedPipedProcess {
  const owned = new Set<NativePtr>();
  let startupInfo: NativePtr | undefined;
  let processInfo: NativePtr | undefined;
  try {
    const stdIn = createPipe(api, owned);
    const stdOut = createPipe(api, owned);
    const stdErr = createPipe(api, owned);
    for (const [handle, label] of [
      [stdIn.read, "stdin read end"],
      [stdOut.write, "stdout write end"],
      [stdErr.write, "stderr write end"],
    ] as const) {
      if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
        throwLastError(api, "SetHandleInformation", label);
      }
    }
    startupInfo = allocStartupInfo();
    encodeStartupInfo(startupInfo, {
      cb: abi.STARTUPINFOW_SIZE,
      dwFlags: abi.STARTF_USESTDHANDLES,
      hStdInput: stdIn.read,
      hStdOutput: stdOut.write,
      hStdError: stdErr.write,
    });
    processInfo = allocProcessInfo();
    const created = createRestrictedProcess(
      api,
      options,
      buildCommandLine(options.command, options.args),
      0,
      startupInfo,
      processInfo,
    );
    if (created === 0) {
      const win32Code = api.getLastError();
      throwWin32(api, "CreateProcessAsUserW", win32Code, `command: ${options.command}, cwd: ${options.cwd}`);
    }
    const info = decodeProcessInfo(processInfo);
    if (info.hProcess === null || info.hThread === null) {
      if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1);
      closeBestEffort(api, info.hThread);
      closeBestEffort(api, info.hProcess);
      throw new Error(`CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`);
    }
    closeOwned(api, owned, stdIn.read);
    closeOwned(api, owned, stdIn.write);
    closeOwned(api, owned, stdOut.write);
    closeOwned(api, owned, stdErr.write);
    closeBestEffort(api, info.hThread);
    owned.delete(stdOut.read);
    owned.delete(stdErr.read);
    return {
      pid: info.dwProcessId,
      process: info.hProcess,
      stdoutRead: stdOut.read,
      stderrRead: stdErr.read,
    };
  } catch (error) {
    closeAllOwned(api, owned);
    throw error;
  } finally {
    freeNative(processInfo);
    freeNative(startupInfo);
  }
}

/**
 * 排空一个匿名管道直到写端关闭。
 * @param api - 生效的绑定表。
 * @param handle - 调用方持有的管道读端。
 * @returns EOF 前的全部字节；句柄总会被关闭。
 */
export async function drainPipe(api: Win32Bindings, handle: NativePtr): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let countSlot: NativePtr | undefined;
  try {
    countSlot = allocUint32();
    for (;;) {
      const peeked = api.peekNamedPipe(handle, null, 0, null, countSlot, null);
      if (peeked === 0) {
        const win32Code = api.getLastError();
        if (win32Code === abi.ERROR_BROKEN_PIPE || win32Code === abi.ERROR_NO_DATA) break;
        throwLastError(api, "PeekNamedPipe", `drain failure after ${chunks.length} chunk(s)`);
      }
      const available = decodeUint32(countSlot);
      if (available > 0) {
        const chunk = Buffer.alloc(available);
        if (api.readFile(handle, chunk, chunk.length, countSlot, null) === 0) {
          throwLastError(api, "ReadFile", `drain failure after ${chunks.length} chunk(s)`);
        }
        chunks.push(chunk.subarray(0, decodeUint32(countSlot)));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    return Buffer.concat(chunks);
  } finally {
    freeNative(countSlot);
    api.closeHandle(handle);
  }
}

/**
 * 等待进程结束并总是关闭其句柄。
 * @param api - 生效的绑定表。
 * @param process - 调用方持有的进程句柄。
 * @returns 直接退出码。
 */
export function waitForProcessExit(api: Win32Bindings, process: NativePtr): number {
  let exitCodeSlot: NativePtr | undefined;
  try {
    if (api.waitForSingleObject(process, abi.INFINITE) === 0xFFFFFFFF) {
      throwLastError(api, "WaitForSingleObject");
    }
    exitCodeSlot = allocUint32();
    if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, "GetExitCodeProcess");
    return decodeUint32(exitCodeSlot);
  } finally {
    freeNative(exitCodeSlot);
    api.closeHandle(process);
  }
}

function createKillOnCloseJob(api: Win32Bindings): NativePtr {
  const job = api.createJobObjectW(null, null);
  if (isNullPtr(job)) throwLastError(api, "CreateJobObjectW");
  const information = Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE);
  information.writeUInt32LE(
    abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
  );
  if (api.setInformationJobObject(
    job,
    abi.JobObjectExtendedLimitInformation,
    information,
    information.length,
  ) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(job);
    throwWin32(api, "SetInformationJobObject", win32Code);
  }
  return job;
}

interface ProcessStandardHandles {
  stdin: NativePtr;
  stdout: NativePtr;
  stderr: NativePtr;
}

/** 取本进程继承的 stdio 句柄（Node 启动时会清掉可继承位，这里临时恢复）。 */
function inheritedStandardHandles(api: Win32Bindings): ProcessStandardHandles {
  const get = (selector: number, label: string): NativePtr => {
    const handle = api.getStdHandle(selector);
    if (!isNullPtr(handle)) return handle;
    throwLastError(api, "GetStdHandle", `null ${label} handle`);
  };
  return {
    stdin: get(abi.STD_INPUT_HANDLE, "stdin"),
    stdout: get(abi.STD_OUTPUT_HANDLE, "stdout"),
    stderr: get(abi.STD_ERROR_HANDLE, "stderr"),
  };
}

/** 共享的「挂起创建 → 挂 Job → 恢复」生命周期。 */
function spawnJobProcess(
  api: Win32Bindings,
  options: RestrictedProcessSpawnOptions,
  resolveStdio: () => ProcessStandardHandles,
  createName: "CreateProcessAsUserW",
  create: (startupInfo: NativePtr, processInfo: NativePtr) => number,
): SpawnedJobProcess {
  const job = createKillOnCloseJob(api);
  const enabled: NativePtr[] = [];
  let startupInfo: NativePtr | undefined;
  let processInfo: NativePtr | undefined;
  let created = 0;
  let createFailureCode = 0;
  try {
    const stdio = resolveStdio();
    for (const [handle, label] of [
      [stdio.stdin, "stdin"],
      [stdio.stdout, "stdout"],
      [stdio.stderr, "stderr"],
    ] as const) {
      if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
        throwLastError(api, "SetHandleInformation", `${label} (enable inherit)`);
      }
      enabled.push(handle);
    }
    startupInfo = allocStartupInfo();
    encodeStartupInfo(startupInfo, {
      cb: abi.STARTUPINFOW_SIZE,
      dwFlags: abi.STARTF_USESTDHANDLES,
      hStdInput: stdio.stdin,
      hStdOutput: stdio.stdout,
      hStdError: stdio.stderr,
    });
    processInfo = allocProcessInfo();
    created = create(startupInfo, processInfo);
    if (created === 0) createFailureCode = api.getLastError();
  } catch (error) {
    freeNative(processInfo);
    api.closeHandle(job);
    throw error;
  } finally {
    freeNative(startupInfo);
    for (const handle of enabled) {
      // runner 不再拉起别的子进程；恢复失败不能掩盖子进程结果。
      api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, 0);
    }
  }
  if (created === 0) {
    freeNative(processInfo);
    api.closeHandle(job);
    throwWin32(api, createName, createFailureCode, `command: ${options.command}, cwd: ${options.cwd}`);
  }
  let info: ReturnType<typeof decodeProcessInfo>;
  try {
    info = decodeProcessInfo(processInfo);
  } finally {
    freeNative(processInfo);
  }
  if (info.hProcess === null || info.hThread === null) {
    if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1);
    api.closeHandle(job);
    closeBestEffort(api, info.hThread);
    closeBestEffort(api, info.hProcess);
    throw new Error(`${createName} succeeded but returned null process/thread handles (pid ${info.dwProcessId})`);
  }
  if (api.assignProcessToJobObject(job, info.hProcess) === 0) {
    const win32Code = api.getLastError();
    api.terminateProcess(info.hProcess, 1);
    closeBestEffort(api, info.hThread);
    closeBestEffort(api, info.hProcess);
    api.closeHandle(job);
    throwWin32(api, "AssignProcessToJobObject", win32Code, `pid ${info.dwProcessId}`);
  }
  if (api.resumeThread(info.hThread) === 0xFFFFFFFF) {
    const win32Code = api.getLastError();
    closeBestEffort(api, info.hThread);
    closeBestEffort(api, info.hProcess);
    api.closeHandle(job);
    throwWin32(api, "ResumeThread", win32Code, `pid ${info.dwProcessId}`);
  }
  closeBestEffort(api, info.hThread);
  return { pid: info.dwProcessId, process: info.hProcess, job };
}

/**
 * 以受限令牌挂起创建子进程、挂入 kill-on-close Job、再恢复执行；stdio 直接继承。
 * @param api - 生效的绑定表。
 * @param options - 命令、cwd、argv 与受限主令牌。
 * @returns 恢复执行后归调用方所有的进程与 Job 句柄。
 */
export function spawnInheritedJobProcess(
  api: Win32Bindings,
  options: RestrictedProcessSpawnOptions,
): SpawnedJobProcess {
  const commandLine = buildCommandLine(options.command, options.args);
  return spawnJobProcess(
    api,
    options,
    () => inheritedStandardHandles(api),
    "CreateProcessAsUserW",
    (startupInfo, processInfo) =>
      createRestrictedProcess(api, options, commandLine, abi.CREATE_SUSPENDED, startupInfo, processInfo),
  );
}

/**
 * 探针：验证当前令牌下能创建并释放一个 kill-on-close Job。
 * @param api - 生效的绑定表。
 */
export function probeRestrictedTokenJobSupport(api: Win32Bindings): void {
  const job = createKillOnCloseJob(api);
  closeHandleChecked(api, job, "restricted-token Job capability probe");
}

/**
 * 非阻塞轮询一个进程句柄。
 * @param api - 生效的绑定表。
 * @param process - 调用方持有的进程句柄。
 * @returns 已结束时为退出码，仍在运行时为 undefined。
 */
export function pollProcessExit(api: Win32Bindings, process: NativePtr): number | undefined {
  const waitResult = api.waitForSingleObject(process, 0);
  if (waitResult === abi.WAIT_TIMEOUT) return undefined;
  if (waitResult === 0xFFFFFFFF) throwLastError(api, "WaitForSingleObject");
  const exitCodeSlot = allocUint32();
  try {
    if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, "GetExitCodeProcess");
    return decodeUint32(exitCodeSlot);
  } finally {
    requireKoffi().free(exitCodeSlot);
  }
}

/**
 * Job 内是否已无活动进程。
 * @param api - 生效的绑定表。
 * @param job - 调用方持有的 Job 句柄。
 * @returns Job 报告活动进程数为 0 时为 true。
 */
export function isJobEmpty(api: Win32Bindings, job: NativePtr): boolean {
  const information = Buffer.alloc(abi.JOBOBJECT_BASIC_ACCOUNTING_SIZE);
  if (api.queryInformationJobObject(
    job,
    abi.JobObjectBasicAccountingInformation,
    information,
    information.length,
    null,
  ) === 0) {
    throwLastError(api, "QueryInformationJobObject", "active process count");
  }
  return information.readUInt32LE(abi.JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET) === 0;
}

/**
 * 终止 Job 内全部进程。
 * @param api - 生效的绑定表。
 * @param job - 调用方持有的 Job 句柄。
 * @param exitCode - 赋给成员的退出码。
 */
export function terminateJob(api: Win32Bindings, job: NativePtr, exitCode: number): void {
  if (api.terminateJobObject(job, exitCode) === 0) throwLastError(api, "TerminateJobObject");
}

/**
 * 关闭调用方持有的句柄，失败时带标签抛错。
 * @param api - 生效的绑定表。
 * @param handle - 待关闭句柄。
 * @param detail - 诊断标签。
 */
export function closeHandleChecked(api: Win32Bindings, handle: NativePtr, detail: string): void {
  if (api.closeHandle(handle) === 0) throwLastError(api, "CloseHandle", detail);
}
