/** 配色皮肤：与 globals.css 的 html[data-skin] 块一一对应。
 *  只存本机 localStorage（不进数据库、不参与同步），换设备各自选择。 */
export const SKINS = [
  { id: 'sakura', name: '樱粉暖阳', dot: 'linear-gradient(135deg,#f65c8a,#f59e0b)' },
  { id: 'night', name: '暗夜紫火', dot: 'linear-gradient(135deg,#8b5cf6,#fb923c)' },
  { id: 'mint', name: '薄荷奶咖', dot: 'linear-gradient(135deg,#0d9488,#b45309)' },
  { id: 'ocean', name: '雾蓝海盐', dot: 'linear-gradient(135deg,#2563eb,#22d3ee)' },
] as const;

export type SkinId = (typeof SKINS)[number]['id'];

export const DEFAULT_SKIN: SkinId = 'sakura';

export function isSkinId(value: unknown): value is SkinId {
  return typeof value === 'string' && SKINS.some((s) => s.id === value);
}

export function skinName(id: SkinId): string {
  return SKINS.find((s) => s.id === id)?.name ?? '樱粉暖阳';
}
