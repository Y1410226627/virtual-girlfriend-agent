'use client';

// 全局错误边界：页面渲染出错时不再白屏，给用户一个重试入口。
// （只显示人类可读的信息，不展示堆栈；错误详情写进浏览器控制台供排查）
import { useEffect } from 'react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[页面错误]', error?.message || error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-3xl" aria-hidden>
        🫧
      </div>
      <div className="text-base font-medium ink-1">页面出了点小问题</div>
      <p className="dim max-w-sm">你的数据没有受影响。可以先点下面重试；如果反复出现，刷新一下页面再试。</p>
      <button className="btn" onClick={() => reset()}>
        重试
      </button>
    </div>
  );
}