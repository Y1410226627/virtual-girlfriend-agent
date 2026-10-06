// 她的照片：按当前活动/地点拼一句 caption，调用兼容 OpenAI /images/generations 的服务生成日常自拍
// 未配置 / 生成失败 → 统一返回 HTTP 200 的 fallback（用本地立绘兜底），前端逻辑保持简单
import { getSetting, boolSetting } from '@/lib/db';
import { ensureLife, getActivity, getLocation, getHealth } from '@/lib/life';
import { getPersona } from '@/lib/relationship';
import { errMsg } from '@/lib/utils';
import { withRequestCompanion } from '@/lib/companion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FALLBACK_IMG = '/splash-girl.jpg';

/** 按当前活动/地点，拼一句自然的中文 caption（只说正在发生的事，不编造） */
function buildCaption(): { caption: string; activity: string; location: string } {
  let activityType = 'idle';
  let activity = '发呆';
  let location = '家';
  let illness = 'none';
  try {
    ensureLife();
    const a = getActivity();
    const l = getLocation();
    activityType = String(a.activity_type || 'idle');
    activity = String(a.current_activity || '');
    location = String(l.current_location || '');
    illness = String(getHealth().illness || 'none');
  } catch {
    /* 读取失败就用默认值，不阻断 */
  }

  // 生病优先：不装作状态很好
  if (illness && illness !== 'none') {
    return { caption: `（有点不舒服，素颜将就着看看…）`, activity, location };
  }

  const tail = activity ? `，${activity}` : '';
  const map: Record<string, string> = {
    sleep: '（刚睡醒，头发乱糟糟的，还没完全清醒）',
    morning: '（刚爬起来洗漱好，素颜也想给你看看）',
    meal: `（刚吃了点东西，心情不错${tail}）`,
    commute: '（正在路上，随手拍一张给你）',
    class: '（刚下课回来，头发还有点乱）',
    study: `（在图书馆待了一下午${tail}）`,
    work: '（刚忙完，偷偷拍给你看）',
    shower: '（刚洗完澡，头发还是湿的）',
    out: `（在${location || '外面'}逛，顺便拍给你看）`,
    leisure: `（窝着发呆${tail}，随手来一张）`,
    bed: '（躺床上了，有点想睡又想跟你说话）',
    rest: '（午休刚醒，还懒懒的）',
    chores: `（刚收拾完${tail}，累瘫了）`,
    idle: '（没在忙什么，就想着给你看看）',
  };
  const caption = map[activityType] || `（随手拍一张，记一下现在${tail}）`;
  return { caption, activity: activity || '待着', location: location || '家' };
}

/** 组织一段"她身份 + 当前场景 + 日常自拍、柔和真实"的生成提示词 */
function buildPrompt(opts: { activity: string; location: string }): string {
  const persona = (() => {
    try {
      return getPersona();
    } catch {
      return null;
    }
  })();
  const name = String(persona?.agent_name || '').trim();
  const story = String(persona?.self_story || '').trim();
  const who = name ? `名叫「${name}」的女孩` : '一个温柔自然的年轻女孩';
  const storyLine = story ? `她的身份背景：${story}。` : '';
  return (
    `${who}的一张日常自拍。${storyLine}` +
    `她此刻在「${opts.location}」，正在${opts.activity}。` +
    '手机前置自拍视角，柔和自然的室内/生活光线，暖色调，真实的皮肤质感，' +
    '淡妆或素颜，生活化的背景，氛围放松亲近，像是随手发给恋人的照片。' +
    '写实摄影风格，画质清晰，不要夸张的滤镜或姿态。'
  );
}

export async function POST(req: Request) {
  // T02 收尾 D2：caption/prompt 依赖该伴侣的 persona / 活动 / 地点
  return withRequestCompanion(req, async () => {
  const { caption, activity, location } = buildCaption();

  const enabled = boolSetting('img_enabled', false);
  const baseUrl = String(getSetting('img_base_url') || '').replace(/\/+$/, '');
  const apiKey = String(getSetting('img_api_key') || '');
  const model = String(getSetting('img_model') || '') || 'gpt-image-1';

  // 未启用 / 缺地址 / 缺 Key → 直接用本地立绘兜底
  if (!enabled || !baseUrl || !apiKey || !/^https?:\/\//.test(baseUrl)) {
    return Response.json({ fallback: true, image: FALLBACK_IMG, caption });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        prompt: buildPrompt({ activity, location }),
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn('[photo] 图片服务返回', res.status, detail.slice(0, 160));
      return Response.json({ fallback: true, image: FALLBACK_IMG, caption: '（她今天不太想拍照…）' });
    }
    const json: { data?: Array<{ b64_json?: string; url?: string }> } | null = await res.json().catch(() => null);
    const item = json?.data?.[0];
    // 兼容只返回 url 的情况
    if (item?.b64_json) {
      return Response.json({ ok: true, image: `data:image/png;base64,${item.b64_json}`, caption });
    }
    if (item?.url) {
      return Response.json({ ok: true, imageUrl: String(item.url), caption });
    }
    return Response.json({ fallback: true, image: FALLBACK_IMG, caption: '（她今天不太想拍照…）' });
  } catch (e) {
    console.warn('[photo] 生成失败', errMsg(e));
    return Response.json({ fallback: true, image: FALLBACK_IMG, caption: '（她今天不太想拍照…）' });
  } finally {
    clearTimeout(timer);
  }
  });
}