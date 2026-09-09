/**
 * pi-sandbox-dsh-sandbox · Windows ACL 路径边界判定（纯函数，可测）。
 *
 * 对齐 dsh `sandbox-windows-acl/path-boundary.ts`：
 * - `assertTempRootOutsideWorkspace`：temp 根不能在 workspace 内（否则子目录继承 standing workspace 能力）。
 * - `assertPrivateTempDisjoint`：private temp 目录与任何可写目录不得互相包含（任一继承方向都会合并两个能力）。
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** root 与 candidate 是否为同一规范目录或 root 包含 candidate。 */
function containsDirectory(root: string, candidate: string): boolean {
  const relation = relative(realpathSync.native(root), realpathSync.native(candidate));
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

export function assertTempRootOutsideWorkspace(workspaceRoot: string, tempRoot: string): void {
  if (containsDirectory(workspaceRoot, tempRoot)) {
    throw new Error(`Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`);
  }
}

export function assertPrivateTempDisjoint(writableDirs: readonly string[], tempDir: string): void {
  for (const writableDir of writableDirs) {
    if (containsDirectory(writableDir, tempDir) || containsDirectory(tempDir, writableDir)) {
      throw new Error(`AclSandbox private temp directory must be disjoint from writable directories: writable=${writableDir}; temp=${tempDir}`);
    }
  }
}
