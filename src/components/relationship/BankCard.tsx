'use client';

import { Card } from '@/components/ui';
import type { RelationshipData } from './shared';

export function BankCard({ bank }: { bank?: RelationshipData['bank'] }) {
  return (
    <Card
      title={`情感银行账户（存入 ${bank?.stats?.deposits ?? 0} / 支出 ${bank?.stats?.withdrawals ?? 0}）`}
    >
      <p className="dim mb-3 leading-relaxed">
        每一次关心、共情、幽默都是存款；敷衍、忽视、越界是取款。余额 &gt;30 她更愿意表达爱意，&lt;-20 会更谨慎，&lt;-50 进入低潮。
      </p>
      <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
        {(bank?.recent || []).map((e) => (
          <div key={e.id} className="flex items-center justify-between rounded-2xl border line surf px-3.5 py-2">
            <div className="min-w-0">
              <div className="text-xs font-medium ink-1">{e.behavior}</div>
              <div className="dim truncate">{e.reason}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className={`text-sm font-semibold ${e.delta > 0 ? 'acc' : 'text-sky-500'}`}>
                {e.delta > 0 ? '+' : ''}
                {e.delta}
              </div>
              <div className="text-[10px] ink-3">余额 {e.balance_after}</div>
            </div>
          </div>
        ))}
        {(bank?.recent || []).length === 0 ? <p className="dim">还没有流水。</p> : null}
      </div>
    </Card>
  );
}