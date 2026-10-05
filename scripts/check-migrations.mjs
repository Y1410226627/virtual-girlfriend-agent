// 迁移安全检查：扫描 src/lib/db-migrations.ts 的 MIGRATIONS，强制"只加表、加列"规则。
// 破坏性操作（DROP TABLE / DELETE FROM / UPDATE 无 WHERE / DROP COLUMN）必须用 -- safe: <理由> 注释说明。
// 用法：npm run check:migrations   （违规 → 退出码 1）
import { readFileSync } from 'node:fs';

const DB_FILE = 'src/lib/db-migrations.ts';
const src = readFileSync(DB_FILE, 'utf8');

// 提取 MIGRATIONS 数组里的每个 { version, name, sql: `...` } 条目
// 用正则匹配 version:N, name:'...', sql:`...`（sql 里可能含换行）
const migrations = [];
const re = /version:\s*(\d+)\s*,\s*name:\s*'([^']+)'\s*,\s*sql:\s*`([\s\S]*?)`\s*,?\s*\}/g;
let m;
while ((m = re.exec(src)) !== null) {
  migrations.push({ version: Number(m[1]), name: m[2], sql: m[3] });
}

if (migrations.length === 0) {
  console.log('✘ 未解析到任何迁移（正则可能需要更新）');
  process.exit(1);
}

// 版本单调性校验：版本号必须严格递增，且与数组顺序一致。
// 为什么需要：迁移按数组顺序逐条执行；若版本号乱序或重复，会造成"已应用"判定错乱、
// 迁移被跳过或重复执行，是难以察觉的数据风险。这里做静态兜底。
const versionIssues = [];
for (let i = 1; i < migrations.length; i++) {
  if (migrations[i].version <= migrations[i - 1].version) {
    versionIssues.push(
      `第 ${i + 1} 条 v${migrations[i].version}（${migrations[i].name}）不大于第 ${i} 条 v${migrations[i - 1].version}（${migrations[i - 1].name}）`
    );
  }
}
if (versionIssues.length) {
  console.log(`=== 迁移安全检查（${DB_FILE}）===`);
  console.log(`✘ 迁移版本号必须严格递增且与数组顺序一致，发现 ${versionIssues.length} 处问题：`);
  for (const v of versionIssues) console.log(`  ${v}`);
  console.log('\n修复方式：调整版本号使数组自上而下严格递增（历史条目的版本号不可修改，新条目取最大值 +1）。');
  process.exit(1);
}

// 破坏性操作模式（SQL 关键字，不区分大小写）
const destructivePatterns = [
  { name: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { name: 'DELETE FROM', re: /\bDELETE\s+FROM\b/i },
  { name: 'DROP COLUMN', re: /\bALTER\s+TABLE\b[^\n]*\bDROP\s+COLUMN\b/i },
  // UPDATE ... SET 但后面没有 WHERE（跨行也算没有 WHERE）
  { name: 'UPDATE 无 WHERE', re: /\bUPDATE\b[\s\S]*?\bSET\b(?:(?!\bWHERE\b)[\s\S])*?(?=;|\n\n|$)/i },
];

function hasSafeAnnotation(sql) {
  // 在 SQL 里找 -- safe: 开头的注释（可以在任意行）
  return /--\s*safe\s*:/i.test(sql);
}

const violations = [];
for (const mig of migrations) {
  const safe = hasSafeAnnotation(mig.sql);
  for (const pat of destructivePatterns) {
    if (pat.re.test(mig.sql)) {
      if (!safe) {
        violations.push({ version: mig.version, name: mig.name, op: pat.name });
      }
    }
  }
}

console.log(`=== 迁移安全检查（${DB_FILE}）===`);
console.log(`扫描到 ${migrations.length} 条迁移（v${migrations[0]?.version} ~ v${migrations.at(-1)?.version}）`);

if (violations.length === 0) {
  console.log('✔ 全部迁移符合"只加不删"规则（破坏性操作均有 -- safe: 说明）');
  process.exit(0);
}

console.log(`✘ 发现 ${violations.length} 处破坏性操作缺少 -- safe: 说明：`);
for (const v of violations) {
  console.log(`  v${v.version} ${v.name}：${v.op}`);
}
console.log('\n修复方式：在该迁移的 sql 模板字符串里加一行 -- safe: <理由>');
console.log('（历史迁移如已执行且确需删除，可注明理由；新迁移原则上只允许加表加列）');
process.exit(1);
