// 循环依赖检测：静态扫描 src/lib 的顶层 import（相对路径与 @/lib alias），DFS 找环。
// 用法：npm run check:cycles   （发现环 → 退出码 1）
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LIB = path.resolve('src/lib');
const files = readdirSync(LIB).filter((f) => f.endsWith('.ts') && !f.includes('.bak'));
const graph = new Map();

for (const f of files) {
  const src = readFileSync(path.join(LIB, f), 'utf8');
  const deps = [];
  const re = /^import[^'"]*['"](\.[^'"]+|@\/lib\/[^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    let spec = m[1];
    if (spec.startsWith('@/lib/')) spec = './' + spec.slice('@/lib/'.length);
    let target = spec.replace(/^\.\//, '');
    if (!target.endsWith('.ts')) target += '.ts';
    if (files.includes(target)) deps.push(target);
  }
  graph.set(f, deps);
}

const cycles = [];
const state = new Map(); // 0=未访问 1=栈中 2=完成
const stack = [];
function dfs(node) {
  state.set(node, 1);
  stack.push(node);
  for (const d of graph.get(node) || []) {
    const s = state.get(d) ?? 0;
    if (s === 1) {
      const start = stack.indexOf(d);
      cycles.push([...stack.slice(start), d].join(' → '));
    } else if (s === 0) {
      dfs(d);
    }
  }
  stack.pop();
  state.set(node, 2);
}
for (const f of files) if ((state.get(f) ?? 0) === 0) dfs(f);

const edges = [...graph.values()].reduce((n, d) => n + d.length, 0);
if (cycles.length) {
  console.log('✘ 发现循环依赖：');
  for (const c of [...new Set(cycles)]) console.log('  ' + c);
  process.exit(1);
} else {
  console.log(`✔ 无循环依赖（扫描 ${files.length} 个模块、${edges} 条依赖边）`);
}