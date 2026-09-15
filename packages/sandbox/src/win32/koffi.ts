/**
 * pi-sandbox-dsh-sandbox · koffi 惰性加载（Windows-only）。
 *
 * 单一源 = dsh `dsh-lazy-require`：首次真正调用 Win32 时才 require koffi，
 * 失败不缓存（修好安装后可重试）。
 *
 * 关键约束：koffi 是原生 FFI，**不能加载进 pi 宿主（Bun）**；本文件只被
 * `win32/*` 引用，而这些模块只在独立 Node runner 子进程里真正执行 Win32 调用
 * （pi 宿主侧仅静态 import 类型与惰性函数，不触发 require）。
 */
import { createRequire } from "node:module";
import type koffi from "koffi";

/** koffi 运行时导出类型。 */
export type Koffi = typeof koffi;

const requireFromHere = createRequire(import.meta.url);
let loaded = false;
let value: Koffi;

/** 返回 koffi（首次调用时加载，成功后缓存）。 */
export function requireKoffi(): Koffi {
  if (!loaded) {
    value = requireFromHere("koffi") as Koffi;
    loaded = true;
  }
  return value;
}
