/**
 * pi-sandbox-dsh · 包根入口（pi.extensions 指向此处）。
 *
 * 仅 re-export 宿主（packages/core/src/index.ts）。包根入口保证 pi 的 /config
 * 按父目录/文件名推导显示名 `pi-sandbox-dsh/index.ts`。
 */
export { default } from "./packages/core/src/index.ts";
