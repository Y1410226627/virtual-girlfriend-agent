'use client';

import { Card } from '@/components/ui';
import type { LifeData, PostFn } from './shared';

export function ProfileCard({
  profile,
  busy,
  post,
  editProfile,
  setEditProfile,
  pf,
  setPf,
}: {
  profile: LifeData['profile'];
  busy: boolean;
  post: PostFn;
  editProfile: boolean;
  setEditProfile: React.Dispatch<React.SetStateAction<boolean>>;
  pf: Record<string, string>;
  setPf: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  return (
    <Card
      title={`她的档案（已告诉你的 ${profile.revealedCount} 项）`}
      right={
        <button className="btn-ghost" onClick={() => { setEditProfile((v) => !v); setPf({}); }}>
          {editProfile ? '收起' : '填写 / 修改'}
        </button>
      }
    >
      <div className="space-y-2">
        {profile.fields.map((f) => (
          <div key={f.field} className="flex items-start justify-between gap-3 rounded-2xl border line surf px-3.5 py-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium ink-2">{f.label}</div>
              <div className="mt-0.5 text-xs leading-relaxed">
                {f.value ? (
                  f.revealed ? (
                    <span className="ink-1">{f.value}</span>
                  ) : (
                    <span className="ink-3">她还有些事没告诉你</span>
                  )
                ) : (
                  <span className="ink-3">（还没设定）</span>
                )}
              </div>
            </div>
            {f.value ? (
              <button
                className="btn-ghost shrink-0 !py-1 text-xs"
                disabled={busy}
                onClick={() => post({ action: f.revealed ? 'hide_field' : 'reveal_field', field: f.field }, f.revealed ? '已设为"未告诉"' : '已设为"已经知道"')}
              >
                {f.revealed ? '设为未说' : '设为已说'}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <p className="dim mt-3 leading-relaxed">
        没告诉你的信息，她不会说出口——但会在关系变深时自然透露（融合期可以说脆弱，承诺期才会说小秘密）。
        你在这里把内容填上，她就会按这个设定生活。
      </p>

      {editProfile ? (
        <div className="mt-4 rounded-2xl border line surf p-3.5">
          <div className="grid gap-2.5 md:grid-cols-2">
            {profile.fields.map((f) => (
              <div key={f.field}>
                <label className="label">{f.label}</label>
                <input
                  className="input"
                  defaultValue={f.value}
                  placeholder={`她的${f.label}`}
                  onChange={(e) => setPf((s) => ({ ...s, [f.field]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <button
            className="btn mt-3"
            disabled={busy}
            onClick={() => post({ action: 'set_profile', ...pf }, '已更新她的设定')}
          >
            保存她的设定
          </button>
        </div>
      ) : null}
    </Card>
  );
}