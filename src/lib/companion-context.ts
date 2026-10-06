// 请求级「伴侣上下文」：为多女友隔离提供 companion_id 的隐式传递。
//
// 设计要点（对齐架构文档 §3.1）：
// - 基于 node:async_hooks 的 AsyncLocalStorage，全程零第三方依赖；
// - 本模块【不依赖 db.ts】，避免与 db.ts 形成循环依赖（check:cycles 约束）；
// - withCompanion(id, fn) 在给定作用域内绑定 companion_id，支持嵌套（内层覆盖外层）；
// - cId() 在无作用域或缺省时返回 PRIMARY_COMPANION_ID（= 1），保证所有"未包裹的旧路径"
//   等价于主女友，行为与引入伴侣维度之前完全一致。
import { AsyncLocalStorage } from 'node:async_hooks';

/** 主女友（既有那份数据）恒定的 companion_id。全库隔离以该值为默认锚点。 */
export const PRIMARY_COMPANION_ID = 1;

/** 当前异步执行流所绑定的 companion_id；未绑定时 getStore() 返回 undefined。 */
const companionStore = new AsyncLocalStorage<number>();

/**
 * 规整 companionId：非法值（非数字 / NaN / Infinity / 非正整数）一律落到主女友 id。
 * 目的：隔离键在任何调用路径上都始终是一个有效的正整数，避免越界或落库为非法值。
 */
function normalizeCompanionId(companionId: number | null | undefined): number {
  if (typeof companionId !== 'number' || !Number.isFinite(companionId)) {
    return PRIMARY_COMPANION_ID;
  }
  const truncated = Math.trunc(companionId);
  return truncated > 0 ? truncated : PRIMARY_COMPANION_ID;
}

/**
 * 在指定伴侣作用域内执行 fn（同步或异步均可，返回值原样透传）。
 *
 * 用法：
 *   withCompanion(2, () => cAll('SELECT * FROM messages WHERE companion_id = ?'));
 * 嵌套调用时以内层 id 为准（AsyncLocalStorage 天然隔离各异步分支）。
 */
export function withCompanion<T>(companionId: number, fn: () => T): T {
  return companionStore.run(normalizeCompanionId(companionId), fn);
}

/**
 * 读取当前作用域的 companion_id。
 * 无作用域时返回 PRIMARY_COMPANION_ID（= 1），使旧调用点零改动即等价于主女友。
 */
export function cId(): number {
  return companionStore.getStore() ?? PRIMARY_COMPANION_ID;
}

/** 是否处在显式的伴侣作用域内（供测试与调试使用，不参与业务逻辑）。 */
export function hasCompanionContext(): boolean {
  return companionStore.getStore() !== undefined;
}
