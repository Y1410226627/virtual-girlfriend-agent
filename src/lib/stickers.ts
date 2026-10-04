// 表情包：双方都能发，她也能"看懂"你发的
// 存库格式统一为 [[sticker:id]]，界面渲染成表情包卡片，注入模型时换成可读描述
export interface Sticker {
  id: string;
  emoji: string;
  caption: string;
  /** 给模型看的含义（她会"看懂"你发的） */
  meaning: string;
  tags: string[];
}

export const STICKERS: Sticker[] = [
  { id: 'hug', emoji: '🫂', caption: '要抱抱', meaning: '想被抱一下，撒娇求安慰', tags: ['撒娇', '安慰', '亲密'] },
  { id: 'love', emoji: '🫶', caption: '想你啦', meaning: '表达想念和喜欢', tags: ['想念', '甜'] },
  { id: 'shy', emoji: '😳', caption: '别看我啦', meaning: '被夸/被撩到，害羞', tags: ['害羞', '被夸'] },
  { id: 'cry', emoji: '😭', caption: '我不管我委屈', meaning: '委屈、想被哄', tags: ['委屈', '难过', '求哄'] },
  { id: 'angry', emoji: '😤', caption: '哼！', meaning: '假装生气、想要他哄', tags: ['生气', '赌气'] },
  { id: 'sleepy', emoji: '😪', caption: '困了', meaning: '累了想睡，可能想被关心', tags: ['累', '晚安'] },
  { id: 'cheer', emoji: '✊', caption: '你可以的', meaning: '给他打气、支持他', tags: ['鼓励'] },
  { id: 'pat', emoji: '🤲', caption: '摸摸你', meaning: '安慰他、心疼他', tags: ['安慰', '心疼'] },
  { id: 'speechless', emoji: '😑', caption: '……', meaning: '无语、被雷到、哭笑不得', tags: ['无语', '吐槽'] },
  { id: 'panic', emoji: '🫠', caption: '救命', meaning: '手忙脚乱、快撑不住了', tags: ['慌', '崩溃'] },
  { id: 'laugh', emoji: '🤣', caption: '哈哈哈哈', meaning: '被逗笑，心情很好', tags: ['开心', '被逗笑'] },
  { id: 'star', emoji: '🤩', caption: '好喜欢你', meaning: '非常喜欢、崇拜、心动', tags: ['喜欢', '心动'] },
  { id: 'mute', emoji: '😶', caption: '不想说话', meaning: '闹小别扭、不想理人', tags: ['别扭', '冷淡'] },
  { id: 'eat', emoji: '🍜', caption: '吃饭了没', meaning: '关心他有没有好好吃饭', tags: ['关心', '日常'] },
  { id: 'miss', emoji: '🥺', caption: '你好久没找我了', meaning: '失落、被冷落了，想被在意', tags: ['失落', '求关注'] },
  { id: 'celebrate', emoji: '🎉', caption: '太好了', meaning: '替他高兴、庆祝', tags: ['开心', '庆祝'] },
];

const TOKEN_RE = /\[\[\s*(?:sticker|表情包)\s*[:：]?\s*([a-z_]+)\s*\]\]/gi;

export function stickerById(id: string): Sticker | undefined {
  return STICKERS.find((s) => s.id === String(id).toLowerCase());
}

export function formatStickerToken(id: string): string {
  return `[[sticker:${id}]]`;
}

export function hasSticker(text: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(String(text || ''));
}

/** 提取文本里的第一个表情包 id */
export function firstStickerId(text: string): string | null {
  TOKEN_RE.lastIndex = 0;
  const m = TOKEN_RE.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}

/** 把表情包 token 换成给模型看的自然语言描述（她"看懂"你发的表情包） */
export function renderContentForModel(text: string): string {
  const src = String(text || '');
  return src.replace(TOKEN_RE, (_m, id: string) => {
    const s = stickerById(id);
    if (!s) return '（一个表情包）';
    return `（他发来一个表情包：${s.emoji}「${s.caption}」，意思是${s.meaning}）`;
  });
}

/** 注入回复 Prompt：可用表情包清单 + 使用规则 */
export function stickerPromptBlock(opts: { scene: string; stage: number; mood: string }): string {
  const list = STICKERS.map((s) => `${formatStickerToken(s.id)} = ${s.emoji}「${s.caption}」（${s.meaning}）`).join('\n');
  const sceneRule =
    opts.scene === 'online'
      ? '你们现在在线上聊天，表情包是常用表达：情绪到了、或想撒娇又不想多说时，可以只发一个表情包。'
      : '你们现在线下相处，少用表情包（那更像隔着手机做的事）；除非你是在把手机上的表情包拿给他看。';
  return `【表情包】你可以发一个表情包来表达情绪（尤其是不想多说话的时候）。格式：单独一行写 ${formatStickerToken('hug')} 这种，我会渲染成表情包。
可用的表情包：
${list}
使用规则：
- ${sceneRule}
- 一次最多发一个；不要连续两条消息都发表情包；表情包可以单独成条，也可以跟在台词后面。
- 他发来的表情包你能看懂（会变成上面的说明文字），像真人一样自然回应，不要复述"你发了一个表情包"。`;
}