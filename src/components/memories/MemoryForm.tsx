'use client';

import { Card } from '@/components/ui';
import { clampImportance } from './shared';
import type { NewMem } from './shared';

export function MemoryForm({
  newMem,
  setNewMem,
  act,
  setToast,
  setCreating,
}: {
  newMem: NewMem;
  setNewMem: React.Dispatch<React.SetStateAction<NewMem>>;
  act: (body: Record<string, unknown>, msg?: string) => Promise<boolean>;
  setToast: React.Dispatch<React.SetStateAction<string | null>>;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <div className="px-5 pt-4 md:px-8">
      <Card title="添加一条记忆">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">类型</label>
            <select className="input" value={newMem.type} onChange={(e) => setNewMem((s) => ({ ...s, type: e.target.value }))}>
              <option value="semantic">事实（稳定偏好/信息）</option>
              <option value="episodic">事件（具体发生过的事）</option>
              <option value="emotional">情绪（他的状态）</option>
              <option value="relationship">关系（你们的进展）</option>
            </select>
          </div>
          <div>
            <label className="label">重要度（0-10，越重要越不容易遗忘）</label>
            <input
              className="input"
              type="number"
              min={0}
              max={10}
              value={newMem.importance}
              onChange={(e) => setNewMem((s) => ({ ...s, importance: e.target.value === '' ? s.importance : Number(e.target.value) }))}
            />
          </div>
        </div>
        <div className="mt-3">
          <label className="label">内容</label>
          <textarea
            className="textarea"
            rows={2}
            placeholder="例如：他喜欢冰美式，讨厌香菜"
            value={newMem.content}
            onChange={(e) => setNewMem((s) => ({ ...s, content: e.target.value }))}
          />
        </div>
        <button
          className="btn mt-3"
          onClick={async () => {
            if (!newMem.content.trim()) {
              setToast('内容不能为空');
              return;
            }
            const ok = await act(
              { action: 'create', ...newMem, importance: clampImportance(newMem.importance) },
              '记住了'
            );
            if (ok) {
              setNewMem({ type: 'semantic', content: '', importance: 7, emotion: '' });
              setCreating(false);
            }
          }}
        >
          保存
        </button>
      </Card>
    </div>
  );
}