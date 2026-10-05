# ADR 0004：引入 ESLint 门禁、启用 noUncheckedIndexedAccess、不引入 Prettier

## 背景
「已知技术债」清单中三项长期挂账，此前因网络不可用无法引入依赖：
1. ESLint / Prettier 未引入（门禁只有 tsc + node:test + build）。
2. `noUncheckedIndexedAccess` 未开启（评估过会给现有代码带来大量改动）。
3. 缺少 CI（依赖网络与 GitHub 推送能力）。

2026-10-05 网络恢复（npm registry 可达、GitHub 可访问），用户要求「还清技术债」。

## 决策
### 1. 引入 ESLint（进入 verify 门禁）
- 版本组合：`eslint@9`（flat config）+ `typescript-eslint` + `eslint-config-next`（经 `@eslint/eslintrc` 的 FlatCompat 桥接 Next 15 的 eslintrc 版配置）。均为 devDependencies，不影响运行时与部署。
- 关键规则：`@typescript-eslint/no-explicit-any` = error（现存 310 处已全部清零）；`@typescript-eslint/no-unused-vars` = error（`^_` 前缀豁免）；关闭中文语境下大面积误报或无实际价值的规则（`react/no-unescaped-entities`、`no-img-element`、`react/react-in-jsx-scope`）。
- lint **独立运行**（`next.config.mjs` 设 `eslint.ignoreDuringBuilds`），不与 `next build` 耦合，避免 Next 对 flat config 的集成差异；`npm run verify` 已包含 lint。
- CI（`.github/workflows/verify.yml`）在 push/PR 时跑与本地一致的全部门禁（typecheck / lint / test / check:cycles / check:migrations / build）。

### 2. 启用 `noUncheckedIndexedAccess`
- 实测 115 处错误，逐文件修复：绝大多数是「前文已有判界/兜底，但类型系统无法证明」的索引访问，统一用非空断言 `!`（零行为变化）；少数用语义等价的 `??` 兜底。修复后全量测试（44 个）通过。
- 今后新代码请主动做越界防护，不要为省事关掉该开关。

### 3. 不引入 Prettier
- 评估结论：高成本、低收益。全仓约 1.5 万行、60+ 文件，一次性格式化会产生巨大 diff，污染 git 历史与逐行追溯；本项目是单人 + AI 协作，格式一致性已由 AI 按固定风格产出保证；正确性问题已由 ESLint 覆盖。
- 保留再评估条件：若未来出现多人协作或外部贡献，再写新 ADR 引入。

## 理由
- 静态检查能拦住的错误（未使用变量、隐式 any、hooks 依赖）此前只能在运行期暴露；引入后成为 CI/本地的硬门禁。
- 索引越界是历史上真实出过问题的类（数组/正则捕获组/映射键）；该开关把这类风险从"运行时才知道"提前到"编译期"。
- Prettier 的格式化收益（视觉一致性）在本项目实际协作模式下不成立，不足以抵消 diff 噪音。

## 影响
- 提交前必须跑 `npm run verify`（现在含 lint），失败即不许提交。
- 依赖数量增加 6 个 devDependencies（不进生产依赖，不影响 `npm start` 与桌面部署；桌面只需 `npm install` 一次）。
- 单文件超过 600 行需要拆分（本次已把 9 个超长文件拆成「桶 + 子模块」，数据文件 `src/lib/db-migrations.ts` 除外，见 AGENTS.md 第 6 节）。

## 替代方案
- **Biome / oxlint**：更快的替代，但生态与 Next 集成成熟度低于 ESLint，且同样需要新增依赖；选型时优先官方生态（eslint-config-next）。
- **只开 tsc 不开 lint**：无法覆盖未使用变量、hooks 依赖、any 策略等 lint 专属问题，等于把技术债继续挂着。
- **Prettier 渐进式引入（只格式化新文件）**：会造成"新旧两套格式"的长期割裂，比不引入更混乱。