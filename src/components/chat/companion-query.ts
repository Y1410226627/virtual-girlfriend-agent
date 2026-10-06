// 「按伴侣作用域」的请求 URL / 本地已读键工具（纯函数、无副作用，可单测）。
//
// 多女友隔离要点：服务端通过 resolveCompanionId(req) 读取 `?companionId=` 或 `X-Companion-Id` 头，
// 缺省回落主女友（=1）。前端只需给「伴侣作用域」的请求追加 companionId 查询参数即可。
//
// 硬指标（单女友零回归）：companionId 非法或等于缺省 1 时**原样返回 url**，
// 保证既有单女友链路逐字节不变、不产生多余查询参数。
//
// 例外（非伴侣作用域，不加参数）：/api/tick（全局后台推进）、/api/asr（语音识别能力）、
// /api/tts（全局语音配置）、/api/groups（群聊为全局表）——这些服务端并不读取 companion 上下文。

/** 主女友（既有那份数据）恒定的 companion_id，与服务端 PRIMARY_COMPANION_ID 一致。 */
export const DEFAULT_COMPANION_ID = 1;

/**
 * 为伴侣作用域请求追加 companionId 查询参数。
 * - companionId 非法（NaN / Infinity / <=0）或 === defaultId → 返回原 url（零回归）；
 * - 否则 `url?companionId=<id>`；url 已有 query 时用 `&` 连接。
 */
export function withCompanionQuery(
  url: string,
  companionId: number | string,
  defaultId: number = DEFAULT_COMPANION_ID
): string {
  const id = Math.trunc(Number(companionId));
  if (!Number.isFinite(id) || id <= 0 || id === defaultId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}companionId=${id}`;
}

/**
 * 未读「已读位置」的本地存储键：
 * - 主女友沿用旧键 'lastReadMsgId'（零回归，既有数据不丢）；
 * - 其它伴侣用 'lastReadMsgId#c<id>'，从而未读角标按伴侣分别计算（切走后主女友的新消息不计入当前伴侣）。
 */
export function companionReadKey(
  companionId: number | string,
  defaultId: number = DEFAULT_COMPANION_ID
): string {
  const id = Math.trunc(Number(companionId));
  if (!Number.isFinite(id) || id <= 0 || id === defaultId) return 'lastReadMsgId';
  return `lastReadMsgId#c${id}`;
}
