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

/**
 * 私有计数器键命名空间（对齐架构文档 §2.4）：
 *   ck('turn_count') → 主女友（c1）返回 'turn_count'；其它伴侣返回 'turn_count#c{id}'
 * 仅用于「按伴侣隔离」的计数器键；全局键（scheduler_lease_pid / config_version / llm_calls_* 等）
 * **不要**改用它，否则会把全局语义误私有化。
 *
 * 关于主女艾（c1）沿用「无后缀全局键」这一点（T02 收尾 D3）：
 * - 向后兼容：既有库里主女友的计数/标记都存于无后缀键，无需迁移、老数据不丢；
 * - 零回归：既有测试直接 setCounter/getCounter('turn_count') 等无后缀键，主女友仍映射到同一键；
 * - 隔离性：非主女友一律落到 'key#c{id}'，与主女友及彼此互不干扰。
 * 本函数只依赖 cId()，不依赖 db.ts（保持本模块零依赖，避免与 db.ts 成环）。
 */
export function ck(key: string): string {
  const id = cId();
  return id === PRIMARY_COMPANION_ID ? key : `${key}#c${id}`;
}
