// 冒烟测试：对"正在运行的服务"做一轮核心接口检查（只读，不改任何数据）。
// 用法：npm run smoke                        （默认 http://localhost:3000）
//       node scripts/smoke.mjs http://localhost:3100
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');

const endpoints = [
  ['/api/state', (j) => !!j && typeof j === 'object' && !!j.relationship],
  ['/api/settings', (j) => !!j && typeof j === 'object'],
  ['/api/life', (j) => !!j && typeof j === 'object'],
  ['/api/story', (j) => !!j && typeof j === 'object'],
  ['/api/memories?limit=1', (j) => !!j && Array.isArray(j.memories)],
  ['/api/messages?limit=1', (j) => !!j && Array.isArray(j.messages)],
  ['/api/relationship', (j) => !!j && typeof j === 'object'],
];

let fail = 0;
console.log(`=== 冒烟测试（${base}）===`);
for (const [path, check] of endpoints) {
  try {
    const res = await fetch(base + path, { cache: 'no-store' });
    const j = await res.json().catch(() => null);
    const pass = res.ok && check(j);
    console.log(`${pass ? '✔' : '✘'} ${path}（HTTP ${res.status}）`);
    if (!pass) fail++;
  } catch (e) {
    console.log(`✘ ${path}：${e?.message || e}`);
    fail++;
  }
}
console.log(fail === 0 ? '\n冒烟通过：服务运行正常。' : `\n有 ${fail} 项未通过。`);
process.exit(fail ? 1 : 0);