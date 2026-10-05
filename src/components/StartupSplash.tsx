'use client';

// 启动动画：打开应用后停留在此画面无限循环播放，点击任意位置进入聊天
import { useEffect, useState } from 'react';

const LINES = ['正在醒来…', '在理头发…', '在想你…'];

export default function StartupSplash() {
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  const [line, setLine] = useState(0);

  useEffect(() => {
    if (leaving) return; // 动画结束后停止空转
    const cyc = setInterval(() => setLine((v) => (v + 1) % LINES.length), 1600);
    return () => clearInterval(cyc);
  }, [leaving]);

  // 收尾：优先监听淡出动画的 animationend；再兜底一个超时（后台标签页/低端机掉帧、
  // 或 prefers-reduced-motion 关掉动画时 animationend 不会触发），保证覆盖层一定会消失。
  useEffect(() => {
    if (!leaving) return;
    const b = setTimeout(() => setGone(true), 1200);
    return () => clearTimeout(b);
  }, [leaving]);

  if (gone) return null;

  return (
    <div
      className={`splash ${leaving ? 'splash-leave' : ''}`}
      style={leaving ? { pointerEvents: 'none' } : undefined}
      onClick={() => setLeaving(true)}
      onAnimationEnd={(e) => {
        // 只认覆盖层自己（排除子元素冒泡）上淡出动画的结束，立即移除
        if (leaving && e.target === e.currentTarget && e.animationName === 'splash-out') setGone(true);
      }}
      tabIndex={0}
      role="button"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
          e.preventDefault();
          setLeaving(true);
        }
      }}
    >
      <div className="splash-aurora" aria-hidden>
        <span className="splash-glow splash-glow-a" />
        <span className="splash-glow splash-glow-b" />
        <span className="splash-glow splash-glow-c" />
      </div>
      <div className="splash-petals" aria-hidden>
        {Array.from({ length: 14 }).map((_, i) => (
          <span
            key={i}
            className={`splash-petal ${i % 2 ? 'splash-petal-r' : ''}`}
            style={{
              left: `${3 + i * 7}%`,
              width: `${10 + (i % 3) * 4}px`,
              height: `${8 + (i % 3) * 3}px`,
              animationDelay: `${-(i % 7) * 1.1}s`,
              animationDuration: `${6.5 + (i % 5) * 1.1}s`,
            }}
          />
        ))}
      </div>
      <div className="splash-sparkles" aria-hidden>
        {Array.from({ length: 12 }).map((_, i) => (
          <span
            key={i}
            className="splash-sparkle"
            style={{
              left: `${6 + ((i * 137) % 88)}%`,
              top: `${8 + ((i * 89) % 74)}%`,
              animationDelay: `${-(i % 6) * 0.7}s`,
              animationDuration: `${2.6 + (i % 4) * 0.8}s`,
            }}
          />
        ))}
      </div>
      <div className="splash-stage">
        <div className="splash-photo" aria-hidden>
          <span className="splash-halo" />
          <img src="/splash-girl.jpg" alt="" draggable={false} />
        </div>
        <h1 className="splash-title">她 · 虚拟女友</h1>
        <p className="splash-sub">{LINES[line]}</p>
      </div>
      <p className="splash-hint">
        <span className="splash-hint-dot" />
        点击任意位置进入聊天
        <span className="splash-hint-dot" />
      </p>
    </div>
  );
}