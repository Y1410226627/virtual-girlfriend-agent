'use client';

// 启动动画：打开应用时短暂出现的开场画面（点击任意处可跳过）
import { useEffect, useState } from 'react';

const LINES = ['正在醒来…', '在理头发…', '在想你…'];

export default function StartupSplash() {
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  const [line, setLine] = useState(0);

  useEffect(() => {
    const cyc = setInterval(() => setLine((v) => (v + 1) % LINES.length), 950);
    const a = setTimeout(() => setLeaving(true), 3000);
    return () => {
      clearInterval(cyc);
      clearTimeout(a);
    };
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const b = setTimeout(() => setGone(true), 850);
    return () => clearTimeout(b);
  }, [leaving]);

  if (gone) return null;

  return (
    <div
      className={`splash ${leaving ? 'splash-leave' : ''}`}
      onClick={() => setLeaving(true)}
      aria-hidden
    >
      <div className="splash-petals">
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className={`splash-petal ${i % 2 ? 'splash-petal-r' : ''}`}
            style={{
              left: `${4 + i * 10}%`,
              animationDelay: `${-(i % 5) * 0.9}s`,
              animationDuration: `${5.2 + (i % 4) * 0.9}s`,
            }}
          />
        ))}
      </div>
      <div className="splash-stage">
        <div className="splash-photo">
          <img src="/splash-girl.jpg" alt="" draggable={false} />
        </div>
        <h1 className="splash-title">她 · 虚拟女友</h1>
        <p className="splash-sub">{LINES[line]}</p>
      </div>
      <p className="splash-skip">点一下跳过</p>
    </div>
  );
}