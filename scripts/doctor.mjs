// 环境自检（doctor）：一条命令检查本机运行条件，缺什么直接说怎么补。
// 用法：npm run doctor
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';

const MIN_NODE = [22, 13];
const results = [];
/** status：pass=通过 / warn=提示（不影响退出码） / fail=失败；fix：失败时的修复建议；note：附加说明 */
const add = (name, status, fix = '', note = '') => results.push({ name, status, fix, note });
const ok = (name, pass, fix = '', passNote = '') => add(name, pass ? 'pass' : 'fail', fix, passNote);

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

// 4) 数据目录：真实检查"能否创建/写入"（只写一个 0 字节临时文件，写完立即删除）。
//    红线：绝不读写 girlfriend.db，也不在 data/ 留下任何东西。
{
  let status = 'pass';
  let note = '';
  let fix = '';
  const probe = `data/.doctor-probe-${process.pid}.tmp`;
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(probe, '');
    note = existsSync('data') ? '可创建、可写入' : '';
  } catch (e) {
    status = 'fail';
    note = '';
    fix = `data 目录无法创建/写入：${e?.message || e}（请检查磁盘权限或剩余空间）`;
  } finally {
    try {
      if (existsSync(probe)) unlinkSync(probe); // 确保不留下临时文件
    } catch {
      /* 清理失败不影响判定，但会在下方 note 里体现为可写 */
    }
  }
  add('data 目录可读写', status, fix, note);
}

// 5) 端口 3000（被占用不算失败——可能已有实例在运行，只是提示；用 warn 如实呈现）
const portBusy = await new Promise((resolve) => {
  const s = connect({ port: 3000, host: '127.0.0.1', timeout: 800 });
  s.on('connect', () => {
    s.destroy();
    resolve(true);
  });
  s.on('error', () => resolve(false));
  s.on('timeout', () => {
    s.destroy();
    resolve(false);
  });
});
if (portBusy) {
  add('端口 3000', 'warn', '', '已有服务在运行（如果你没在用它，可能是别的程序占用）');
} else {
  add('端口 3000', 'pass', '', '空闲');
}

// 输出
const ICON = { pass: '✔', warn: '⚠', fail: '✘' };
console.log('=== 环境自检（doctor）===');
for (const r of results) {
  const line = `${ICON[r.status]} ${r.name}${r.note ? `（${r.note}）` : ''}`;
  const fix = r.status === 'fail' && r.fix ? `\n    → ${r.fix}` : '';
  console.log(line + fix);
}
const passes = results.filter((r) => r.status === 'pass').length;
const warns = results.filter((r) => r.status === 'warn').length;
const fails = results.filter((r) => r.status === 'fail').length;
console.log(`\n结论：通过 ${passes} 项，警告 ${warns} 项，失败 ${fails} 项。`);
if (fails) console.log('请先按上方 ✘ 的提示修复后再启动（⚠ 仅提示，不影响启动）。');
else console.log(warns ? '可以启动（⚠ 项请自行确认）。' : '全部通过，可以启动。');
process.exit(fails ? 1 : 0);