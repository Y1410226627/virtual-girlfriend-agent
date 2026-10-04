// 环境自检（doctor）：一条命令检查本机运行条件，缺什么直接说怎么补。
// 用法：npm run doctor
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';

const MIN_NODE = [22, 13];
const results = [];
/** passNote：通过时显示在括号里；fix：失败时显示的修复建议 */
const ok = (name, pass, fix = '', passNote = '') => results.push({ name, pass, fix, passNote });

// 1) Node 版本
const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
ok('Node.js 版本 ≥ 22.13', nodeOk, '请到 https://nodejs.org 安装新版后重试', `当前 v${process.versions.node}`);

// 2) 依赖与锁文件
ok('package-lock.json 存在（依赖锁定）', existsSync('package-lock.json'), '这个文件不要删除');
ok('node_modules 已安装', existsSync('node_modules'), '先运行 npm install');

// 3) 模型配置文件
const envFile = existsSync('.env.local') ? '.env.local' : existsSync('.env') ? '.env' : null;
ok('.env.local（或 .env）存在', !!envFile, '复制 .env.example 为 .env.local 并填入模型接口', envFile ? `使用 ${envFile}` : '');
if (envFile) {
  const raw = readFileSync(envFile, 'utf8');
  const has = (k) => new RegExp(`^\\s*${k}\\s*=\\s*\\S`, 'm').test(raw);
  ok('LLM_BASE_URL 已设置', has('LLM_BASE_URL'), `在 ${envFile} 里填写模型接口地址`, '已设置');
  ok('LLM_API_KEY 已设置', has('LLM_API_KEY'), `在 ${envFile} 里填写 API Key`, '已设置');
}

// 4) 数据目录（只检查存在性，不做任何写入）
ok('data 目录', true, '', existsSync('data') ? '已存在' : '首次启动自动创建');

// 5) 端口 3000（被占用不算失败——可能已有实例在运行，只是提示）
const portFree = await new Promise((resolve) => {
  const s = connect({ port: 3000, host: '127.0.0.1', timeout: 800 });
  s.on('connect', () => {
    s.destroy();
    resolve(false);
  });
  s.on('error', () => resolve(true));
  s.on('timeout', () => {
    s.destroy();
    resolve(true);
  });
});
ok('端口 3000', true, '', portFree ? '空闲' : '已有服务在运行（若不需要请先关闭）');

// 输出
console.log('=== 环境自检（doctor）===');
for (const r of results) {
  if (r.pass) {
    console.log(`✔ ${r.name}${r.passNote ? `（${r.passNote}）` : ''}`);
  } else {
    console.log(`✘ ${r.name}${r.fix ? `\n    → ${r.fix}` : ''}`);
  }
}
const failed = results.filter((r) => !r.pass).length;
console.log(failed === 0 ? '\n结论：全部通过，可以启动。' : `\n结论：有 ${failed} 项需要注意（见上方 ✘）。`);
process.exit(failed ? 1 : 0);