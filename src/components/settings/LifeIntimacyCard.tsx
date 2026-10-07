'use client';

import Link from 'next/link';
import { Card } from '@/components/ui';
import { withCompanionQuery } from '@/components/chat/companion-query';
import type { SaveFn, SetFieldFn } from './shared';

export function LifeIntimacyCard({
  form,
  set,
  save,
  saving,
  companionId,
}: {
  form: Record<string, string>;
  set: SetFieldFn;
  save: SaveFn;
  saving: boolean;
  /** 当前伴侣：让「她的世界 / 亲密设置」入口保留当前伴侣上下文 */
  companionId: number;
}) {
  return (
    <Card title="她的生活与亲密">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="label">生活系统（你不在时她也在生活）</label>
          <select className="input" value={form.life_enabled ?? 'true'} onChange={(e) => set('life_enabled', e.target.value)}>
            <option value="true">开启（推荐）</option>
            <option value="false">关闭（她只在聊天时存在）</option>
          </select>
        </div>
        <div>
          <label className="label">生理周期</label>
          <select className="input" value={form.cycle_enabled ?? 'true'} onChange={(e) => set('cycle_enabled', e.target.value)}>
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </div>
        <div>
          <label className="label">亲密内容与同意</label>
          <p className="dim">分级与偏好揭露在亲密页统一管理。</p>
          <Link href={withCompanionQuery('/intimacy', companionId)} className="btn-ghost mt-2">打开亲密设置</Link>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => save(['life_enabled', 'cycle_enabled'], '已保存，立即生效')} disabled={saving}>
          保存
        </button>
        <Link href={withCompanionQuery('/world', companionId)} className="btn-ghost">
          她的世界 →
        </Link>
        <Link href={withCompanionQuery('/intimacy', companionId)} className="btn-ghost">
          亲密设置 →
        </Link>
      </div>
      <p className="dim mt-2 leading-relaxed">
        生活系统会让她的健康、心情、位置、活动随时间自然推进（她在你不在时也过日子），回来时能自然分享。
        亲密表达受关系阶段和所选分级影响；三级可以更成熟、更直白地表达，但仍保持非露骨。
      </p>
    </Card>
  );
}