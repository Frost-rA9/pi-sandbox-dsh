/**
 * pi-sandbox-dsh-sandbox · winacl 原生绑定层（koffi FFI）。
 *
 * 单一源 = dsh `subprocess/win32-process/src/ffi.ts`（通用进程/管道/Job 绑定）
 * ⊕ dsh `sandbox/sandbox-windows-acl/src/ffi.ts`（令牌/ACE 绑定）——**合并为一张表**，
 * 去掉 dsh 的 `extendWin32ProcessBindings` 扩展机制（本仓只有一个消费方，无需分层）。
 *
 * 所有绑定都是惰性的（首次原生调用才 `koffi.load`）；Windows-only。
 */
import * as abi from "./abi.ts";
import { Win32Error } from "./errors.ts";
import { requireKoffi, type Koffi } from "./koffi.ts";
import * as aclAbi from "./win32-abi.ts";

declare const nativePtr: unique symbol;
/** koffi 原生指针（品牌化，避免被当普通数值使用）。 */
export type NativePtr = bigint & { readonly [nativePtr]: true };

type Ptr = ReturnType<Koffi["pointer"]>;

/** STARTUPINFOW 中与 stdio 相关的字段。 */
export interface StartupInfoInput {
  cb: number;
  dwFlags: number;
  hStdInput: NativePtr;
  hStdOutput: NativePtr;
  hStdError: NativePtr;
  cbReserved2?: number;
  lpReserved2?: NativePtr;
}

/** 解码后的 PROCESS_INFORMATION。 */
export interface ProcessInfoOutput {
  hProcess: NativePtr | null;
  hThread: NativePtr | null;
  dwProcessId: number;
  dwThreadId: number;
}

/**
 * 通用 Win32 进程/管道/Job 绑定 ⊕ 令牌/ACE 绑定（dsh 两张表的并集）。
 * 方法名与 dsh 保持一致，便于与单一源逐项对照。
 */
export interface Win32Bindings {
  /* ------------------------------ 通用进程 / 句柄 ------------------------------ */
  closeHandle(handle: NativePtr): number;
  getLastError(): number;
  formatMessageW(
    flags: number,
    source: null,
    messageId: number,
    languageId: number,
    buffer: Buffer,
    size: number,
    args: null,
  ): number;
  createPipe(readHandle: NativePtr, writeHandle: NativePtr, attributes: null, size: number): number;
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number;
  createProcessAsUserW(
    token: NativePtr,
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number;
  readFile(file: NativePtr, buffer: Buffer, count: number, bytesRead: NativePtr, overlapped: null): number;
  peekNamedPipe(
    pipe: NativePtr,
    buffer: null,
    size: number,
    bytesRead: NativePtr | null,
    totalAvail: NativePtr,
    leftThisMessage: NativePtr | null,
  ): number;
  waitForSingleObject(handle: NativePtr, milliseconds: number): number;
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number;
  createJobObjectW(attributes: null, name: null): NativePtr;
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number;
  queryInformationJobObject(
    job: NativePtr,
    cls: number,
    information: Buffer,
    length: number,
    returnLength: null,
  ): number;
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number;
  resumeThread(thread: NativePtr): number;
  terminateProcess(process: NativePtr, exitCode: number): number;
  terminateJobObject(job: NativePtr, exitCode: number): number;
  getStdHandle(stdHandle: number): NativePtr;

  /* ------------------------------ 令牌 / SID ------------------------------ */
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr;
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number;
  localAlloc(flags: number, bytes: number): NativePtr;
  localFree(memory: NativePtr): NativePtr;
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number;
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number;
  isValidSid(sid: NativePtr): number;
  getLengthSid(sid: NativePtr): number;
  copySid(length: number, destination: NativePtr, source: NativePtr): number;
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number;
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number;
  createRestrictedToken(
    existing: NativePtr,
    flags: number,
    disableCount: number,
    disableSids: null,
    deletePrivilegeCount: number,
    privilegesToDelete: null,
    restrictCount: number,
    restrictingSids: Buffer,
    newToken: NativePtr,
  ): number;
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number;
  setNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: null,
    group: null,
    dacl: NativePtr | null,
    sacl: null,
  ): number;
  getNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: NativePtr,
    group: NativePtr,
    dacl: NativePtr,
    sacl: NativePtr,
    descriptor: NativePtr,
  ): number;
  getTempPathW(length: number, buffer: Buffer): number;
  setEnvironmentVariableW(name: string, value: string): number;
  setConsoleCtrlHandler(handler: null, add: number): number;
  createFileW(
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    attributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ): NativePtr;
  lockFileEx(
    file: NativePtr,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number;
  unlockFileEx(
    file: NativePtr,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number;
}

interface Win32Types {
  PVOID: Ptr;
  PPVOID: Ptr;
  STARTUPINFOW: ReturnType<Koffi["struct"]>;
  PROCESS_INFORMATION: ReturnType<Koffi["struct"]>;
}

let cachedTypes: Win32Types | undefined;

/** 首次原生操作时解析 koffi 指针与进程结构布局。 */
function win32Types(): Win32Types {
  if (cachedTypes !== undefined) return cachedTypes;
  const koffi = requireKoffi();
  const PVOID = koffi.pointer("void");
  const PPVOID = koffi.pointer(PVOID);
  const STARTUPINFOW = koffi.struct("PI_SANDBOX_STARTUPINFOW", {
    cb: "uint32", lpReserved: "str16", lpDesktop: "str16", lpTitle: "str16",
    dwX: "uint32", dwY: "uint32", dwXSize: "uint32", dwYSize: "uint32",
    dwXCountChars: "uint32", dwYCountChars: "uint32", dwFillAttribute: "uint32",
    dwFlags: "uint32", wShowWindow: "uint16", cbReserved2: "uint16",
    lpReserved2: koffi.pointer("uint8"), hStdInput: PVOID, hStdOutput: PVOID, hStdError: PVOID,
  });
  const PROCESS_INFORMATION = koffi.struct("PI_SANDBOX_PROCESS_INFORMATION", {
    hProcess: PVOID, hThread: PVOID, dwProcessId: "uint32", dwThreadId: "uint32",
  });
  // ABI 守卫：结构布局与本文件里的偏移/尺寸常量必须一致（x64）。
  if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
    throw new Error(`STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, expected ${abi.STARTUPINFOW_SIZE}`);
  }
  if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
    throw new Error(`PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, expected ${abi.PROCESS_INFORMATION_SIZE}`);
  }
  return cachedTypes = { PVOID, PPVOID, STARTUPINFOW, PROCESS_INFORMATION };
}

/**
 * 指针是否为 NULL。
 * @param value - koffi 指针或 Win32 返回值。
 * @returns null/undefined/地址 0 均为 true。
 */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n;
}

/**
 * 判断 CreateFileW 是否返回 INVALID_HANDLE_VALUE。
 * @param handle - CreateFileW 的返回值。
 * @returns null/0/全 1 哨兵均为 true。
 */
export function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true;
  return (handle as bigint) === 0xFFFFFFFFFFFFFFFFn || (handle as bigint) === -1n;
}

/** 分配一个指针宽度的出参槽。 */
export function allocPtrSlot(): NativePtr {
  return requireKoffi().alloc(win32Types().PVOID, 1) as NativePtr;
}

/** 分配一个 uint32 出参槽。 */
export function allocUint32(): NativePtr {
  return requireKoffi().alloc("uint32", 1) as NativePtr;
}

/** 分配一段原始字节块。 */
export function allocBytes(length: number): NativePtr {
  return requireKoffi().alloc("uint8", length) as NativePtr;
}

/**
 * 分配一个已清零的 x64 OVERLAPPED 记录。
 * @remarks koffi 3.1.1 在 LockFileEx/UnlockFileEx 收到 NULL 时会崩；
 * 同步锁文件句柄用全零 OVERLAPPED 等价。
 */
export function allocOverlapped(): NativePtr {
  return allocBytes(32);
}

/** 解码指针出参（地址 0 → null）。 */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value = requireKoffi().decode(slot, win32Types().PVOID) as NativePtr | null;
  return isNullPtr(value) ? null : value;
}

/** 解码 uint32 出参。 */
export function decodeUint32(slot: NativePtr): number {
  return requireKoffi().decode(slot, "uint32") as number;
}

/** 把 uint32 写进已分配的槽。 */
export function encodeUint32(slot: NativePtr, value: number): void {
  requireKoffi().encode(slot, "uint32", value);
}

/** 取 koffi 指针的数值地址（用于结构体打包）。 */
export function ptrAddress(ptr: NativePtr): bigint {
  return requireKoffi().address(ptr);
}

/**
 * 从 Buffer 字段里解码一个指针。
 * @param buffer - 已编码的原生记录。
 * @param offset - 指针字段字节偏移。
 * @returns 地址 0 → null。
 */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value = requireKoffi().decode(buffer, offset, win32Types().PVOID) as NativePtr | null;
  return isNullPtr(value) ? null : value;
}

/** 从原生指针偏移处解码 uint8。 */
export function decodeUint8At(ptr: NativePtr, offset: number): number {
  return requireKoffi().decode(ptr, offset, "uint8") as number;
}

/** 从原生指针偏移处解码 uint16。 */
export function decodeUint16At(ptr: NativePtr, offset: number): number {
  return requireKoffi().decode(ptr, offset, "uint16") as number;
}

/** 从原生指针偏移处解码 uint32。 */
export function decodeUint32At(ptr: NativePtr, offset: number): number {
  return requireKoffi().decode(ptr, offset, "uint32") as number;
}

/**
 * 逐字段比较两块内存里的 SID（不分配字符串）。
 * @param left - 第一块原生缓冲。
 * @param leftOffset - 第一个 SID 的字节偏移。
 * @param right - 第二块原生缓冲。
 * @param rightOffset - 第二个 SID 的字节偏移。
 * @returns revision、authority 与全部 sub-authority 都相同才为 true。
 */
export function sameSidAt(
  left: NativePtr,
  leftOffset: number,
  right: NativePtr,
  rightOffset: number,
): boolean {
  if (decodeUint8At(left, leftOffset) !== decodeUint8At(right, rightOffset)) return false;
  const leftCount = decodeUint8At(left, leftOffset + 1);
  const rightCount = decodeUint8At(right, rightOffset + 1);
  if (leftCount !== rightCount || leftCount > aclAbi.SID_MAX_SUB_AUTHORITIES) return false;
  for (let index = 0; index < 6; index += 1) {
    if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) {
      return false;
    }
  }
  for (let index = 0; index < leftCount; index += 1) {
    if (decodeUint32At(left, leftOffset + 8 + index * 4) !==
      decodeUint32At(right, rightOffset + 8 + index * 4)) return false;
  }
  return true;
}

/** 分配一个已清零的 STARTUPINFOW。 */
export function allocStartupInfo(): NativePtr {
  return requireKoffi().alloc(win32Types().STARTUPINFOW, 1) as NativePtr;
}

/**
 * 编码 STARTUPINFOW 的 stdio 字段。
 * @param startupInfo - 已分配的 STARTUPINFOW 指针。
 * @param fields - 继承 stdio 所需的字段。
 */
export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  requireKoffi().encode(startupInfo, win32Types().STARTUPINFOW, fields);
}

/** 分配一个已清零的 PROCESS_INFORMATION。 */
export function allocProcessInfo(): NativePtr {
  return requireKoffi().alloc(win32Types().PROCESS_INFORMATION, 1) as NativePtr;
}

/**
 * 解码 PROCESS_INFORMATION。
 * @param processInfo - CreateProcess 填充的结构指针。
 * @returns 进程/线程句柄与 id。
 */
export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  return requireKoffi().decode(processInfo, win32Types().PROCESS_INFORMATION) as ProcessInfoOutput;
}

let cached: Win32Bindings | undefined;

/** 构建（并缓存）合并后的绑定表。 */
function bindings(): Win32Bindings {
  if (cached !== undefined) return cached;
  const koffi = requireKoffi();
  const { PVOID, PPVOID, STARTUPINFOW, PROCESS_INFORMATION } = win32Types();
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const bind = (
    lib: ReturnType<typeof koffi.load>,
    name: string,
    result: Ptr | string,
    args: Array<Ptr | string>,
  ): unknown => lib.func("__stdcall", name, result, args);

  cached = {
    /* 通用进程 / 句柄 */
    closeHandle: bind(kernel32, "CloseHandle", "int", [PVOID]),
    getLastError: bind(kernel32, "GetLastError", "uint32", []),
    formatMessageW: bind(kernel32, "FormatMessageW", "uint32", [
      "uint32", PVOID, "uint32", "uint32", PVOID, "uint32", PVOID,
    ]),
    createPipe: bind(kernel32, "CreatePipe", "int", [PPVOID, PPVOID, PVOID, "uint32"]),
    setHandleInformation: bind(kernel32, "SetHandleInformation", "int", [PVOID, "uint32", "uint32"]),
    createProcessAsUserW: bind(advapi32, "CreateProcessAsUserW", "int", [
      PVOID, "str16", "str16", PVOID, PVOID, "int", "uint32", PVOID, "str16",
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    readFile: bind(kernel32, "ReadFile", "int", [PVOID, PVOID, "uint32", koffi.pointer("uint32"), PVOID]),
    peekNamedPipe: bind(kernel32, "PeekNamedPipe", "int", [
      PVOID, PVOID, "uint32", koffi.pointer("uint32"), koffi.pointer("uint32"), koffi.pointer("uint32"),
    ]),
    waitForSingleObject: bind(kernel32, "WaitForSingleObject", "uint32", [PVOID, "uint32"]),
    getExitCodeProcess: bind(kernel32, "GetExitCodeProcess", "int", [PVOID, koffi.pointer("uint32")]),
    createJobObjectW: bind(kernel32, "CreateJobObjectW", PVOID, [PVOID, "str16"]),
    setInformationJobObject: bind(kernel32, "SetInformationJobObject", "int", [PVOID, "int", PVOID, "uint32"]),
    queryInformationJobObject: bind(kernel32, "QueryInformationJobObject", "int", [
      PVOID, "int", PVOID, "uint32", PVOID,
    ]),
    assignProcessToJobObject: bind(kernel32, "AssignProcessToJobObject", "int", [PVOID, PVOID]),
    resumeThread: bind(kernel32, "ResumeThread", "uint32", [PVOID]),
    terminateProcess: bind(kernel32, "TerminateProcess", "int", [PVOID, "uint32"]),
    terminateJobObject: bind(kernel32, "TerminateJobObject", "int", [PVOID, "uint32"]),
    getStdHandle: bind(kernel32, "GetStdHandle", PVOID, ["int"]),

    /* 令牌 / SID */
    openProcess: bind(kernel32, "OpenProcess", PVOID, ["uint32", "int", "uint32"]),
    openProcessToken: bind(advapi32, "OpenProcessToken", "int", [PVOID, "uint32", PPVOID]),
    localAlloc: bind(kernel32, "LocalAlloc", PVOID, ["uint32", "size_t"]),
    localFree: bind(kernel32, "LocalFree", PVOID, [PVOID]),
    convertStringSidToSidW: bind(advapi32, "ConvertStringSidToSidW", "int", ["str16", PPVOID]),
    createWellKnownSid: bind(advapi32, "CreateWellKnownSid", "int", [
      "int", PVOID, PVOID, koffi.pointer("uint32"),
    ]),
    isValidSid: bind(advapi32, "IsValidSid", "int", [PVOID]),
    getLengthSid: bind(advapi32, "GetLengthSid", "uint32", [PVOID]),
    copySid: bind(advapi32, "CopySid", "int", ["uint32", PVOID, PVOID]),
    getTokenInformation: bind(advapi32, "GetTokenInformation", "int", [
      PVOID, "int", PVOID, "uint32", koffi.pointer("uint32"),
    ]),
    setTokenInformation: bind(advapi32, "SetTokenInformation", "int", [PVOID, "int", PVOID, "uint32"]),
    createRestrictedToken: bind(advapi32, "CreateRestrictedToken", "int", [
      PVOID, "uint32", "uint32", PVOID, "uint32", PVOID, "uint32", PVOID, PPVOID,
    ]),
    setEntriesInAclW: bind(advapi32, "SetEntriesInAclW", "uint32", ["uint32", PVOID, PVOID, PPVOID]),
    setNamedSecurityInfoW: bind(advapi32, "SetNamedSecurityInfoW", "uint32", [
      "str16", "int", "uint32", PVOID, PVOID, PVOID, PVOID,
    ]),
    getNamedSecurityInfoW: bind(advapi32, "GetNamedSecurityInfoW", "uint32", [
      "str16", "int", "uint32", PPVOID, PPVOID, PPVOID, PPVOID, PPVOID,
    ]),
    getTempPathW: bind(kernel32, "GetTempPathW", "uint32", ["uint32", PVOID]),
    setEnvironmentVariableW: bind(kernel32, "SetEnvironmentVariableW", "int", ["str16", "str16"]),
    setConsoleCtrlHandler: bind(kernel32, "SetConsoleCtrlHandler", "int", [PVOID, "int"]),
    createFileW: bind(kernel32, "CreateFileW", PVOID, [
      "str16", "uint32", "uint32", PVOID, "uint32", "uint32", PVOID,
    ]),
    lockFileEx: bind(kernel32, "LockFileEx", "int", [
      PVOID, "uint32", "uint32", "uint32", "uint32", PVOID,
    ]),
    unlockFileEx: bind(kernel32, "UnlockFileEx", "int", [
      PVOID, "uint32", "uint32", "uint32", PVOID,
    ]),
  } as unknown as Win32Bindings;
  return cached;
}

/** 异步解析（缓存的）绑定表。 */
export function win32(): Promise<Win32Bindings> {
  return Promise.resolve(bindings());
}

/** 同步解析（缓存的）绑定表。 */
export function win32Sync(): Win32Bindings {
  return bindings();
}

/**
 * 读取当前 Windows 临时目录（GetTempPathW）。
 * @param api - 生效的绑定表。
 * @returns UTF-16 路径。
 */
export function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((aclAbi.MAX_PATH + 1) * 2);
  const length = api.getTempPathW(buffer.length / 2, buffer);
  if (length === 0) throwLastError(api, "GetTempPathW");
  if (length > buffer.length / 2) {
    throw new Win32Error(
      "GetTempPathW",
      abi.ERROR_INSUFFICIENT_BUFFER,
      `required ${length} chars exceed the ${buffer.length / 2}-char buffer; nothing was written`,
    );
  }
  return buffer.subarray(0, length * 2).toString("utf16le");
}

/**
 * 用 FormatMessageW 格式化 Win32 错误码。
 * @param api - 生效的绑定表。
 * @param win32Code - 捕获到的 GetLastError 值。
 * @returns 去掉首尾空白的系统文案，取不到时为空串。
 */
export function errorText(api: Win32Bindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024);
  const length = api.formatMessageW(
    abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS,
    null,
    win32Code,
    0,
    buffer,
    buffer.length / 2,
    null,
  );
  return length === 0 ? "" : buffer.subarray(0, length * 2).toString("utf16le").trim();
}

/**
 * 抛出当前 GetLastError。
 * @param api - 生效的绑定表。
 * @param name - 失败的 Win32 操作名。
 * @param detail - 可选上下文。
 */
export function throwLastError(api: Win32Bindings, name: string, detail?: string): never {
  const win32Code = api.getLastError();
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}

/**
 * 抛出显式捕获的 Win32 错误码。
 * @param api - 生效的绑定表。
 * @param name - 失败的 Win32 操作名。
 * @param win32Code - 清理前捕获的错误码。
 * @param detail - 可选上下文。
 */
export function throwWin32(
  api: Win32Bindings,
  name: string,
  win32Code: number,
  detail?: string,
): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}
