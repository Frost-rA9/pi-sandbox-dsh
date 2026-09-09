/**
 * pi-sandbox-dsh-sandbox · 进程内路径围栏（文件工具写面受限）。
 *
 * 对齐 dsh `fs-sandbox/containment.ts` `isPathUnder`：判断目标是否位于可写根内。
 * 词法快路径命中直接返回 true；否则用文件系统身份（dev+ino）比对，识别
 * Windows 8.3 短名 / 大小写别名 / 符号链接。文件编辑工具在进程内调 fs API
 * （不 spawn 进程），OS 沙箱包不到 → 用此围栏在 TRUSTED 代码里、对 MODEL 控制的
 * 路径做"规范化后包含"检查（containment，非安全边界；内核级隔离仍是 shell 的事）。
 * 读不受限（每种模式都允许读）。
 */
import { statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

function isLexicallyUnder(path: string, root: string, caseSensitive: boolean): boolean {
  const target = caseSensitive ? path : path.toLowerCase();
  const base = caseSensitive ? root : root.toLowerCase();
  if (target === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(prefix);
}

function sameIdentity(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * 判断 `target` 是否位于 `root` 内（或等于 root）。词法快路径优先；不一致时
 * 向上遍历 target 的已存在祖先、用文件系统身份与 root 比对（识别别名/符号链接）。
 * @param caseSensitive 词法比较是否区分大小写；默认按平台（win32 不区分）。
 */
export function isPathUnder(target: string, root: string, caseSensitive: boolean = process.platform !== "win32"): boolean {
  const t = resolve(target);
  const r = resolve(root);
  if (isLexicallyUnder(t, r, caseSensitive)) return true;

  let rootStat;
  try {
    rootStat = statSync(r);
  } catch {
    return false;
  }

  let ancestor = t;
  // 用集合记录已访问路径，防御极端符号链接环。
  const seen = new Set<string>();
  while (!seen.has(ancestor)) {
    seen.add(ancestor);
    let st;
    try {
      st = statSync(ancestor);
    } catch {
      // 目标或祖先不存在：继续向上（存在性由上级判定）。
      st = undefined;
    }
    if (st && sameIdentity(st, rootStat)) return true;
    const parent = dirname(ancestor);
    if (parent === ancestor) return false; // 已到文件系统根，未命中
    ancestor = parent;
  }
  return false;
}

/** 某档位下允许写的根集合（对齐 dsh `writableRoots`；temp 区暂不展开）。 */
export function writableRoots(policy: { mode: string; workspaceRoot: string }): readonly string[] {
  if (policy.mode === "workspace-write") {
    return [policy.workspaceRoot];
  }
  return [];
}
