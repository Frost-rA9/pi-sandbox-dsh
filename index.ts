/**
 * pi-sandbox-dsh · 包根入口
 *
 * 单一参考源 = dsh：连续 agent + 全局沙箱档 + 逐级批准。
 * 包根 re-export（保证 /config 显示名为 `pi-sandbox-dsh/index.ts`，与 pi-plan-mode 同构）。
 */
export * from "./packages/core/src/index.ts";
