# AGENTS.md —— 给 AI 协作者的工程规则（本项目专用）

> 任何 AI（或人）在修改本仓库前，先读完本文件。这里写的是「这个项目怎么做改动」；
> 产品说明见 README.md，决策记录见 docs/adr/。

## 0. 项目定位
- 「她 · 虚拟女友」：本地运行的 Next.js 15 + React 19 + TypeScript 单体应用；数据存本地 SQLite（node:sqlite，零原生依赖，不用装数据库）。
- 单体、单包、单部署单元；这是**应用**不是库——不需要语义化版本、变更日志、发布流水线。
- 维护者是零编程基础的用户 + AI 协作，**没有专职运维**：所有机制以「本地一条命令可验证」为准。

## 1. 不可触碰的红线（最高优先级）
1. **用户数据是隐私**：`data/` 与 `.env.local` 是用户资产。绝不查看、打印、提交或外传其内容；需要测试时必须在**空白库**（删除 `data/girlfriend.db*` 后重启自动重建）中进行，绝不拿真实库做实验。
2. **数据库迁移只允许加表、加列**：迁移写在 `src/lib/db.ts` 的 MIGRATIONS 末尾追加，**绝不修改历史条目、绝不 DROP 业务数据**；破坏性变更必须拆成两步（先双写过渡）。
3. **不破坏用户自定义**：用户改过的记忆、人设、数值、偏好、聊天记录不得被「顺手优化」覆盖或回退。
4. **不上报任何数据**：不接第三方统计 / 错误上报（Sentry 等一律不要），所有数据留在本机。

## 2. 可用命令（改完必须自证）
| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（端口 3000） |
| `npm run build` / `npm start` | 生产构建 / 启动 |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run test` | Node 原生测试（tests/，零新增依赖） |
| `npm run verify` | **提交前必须全绿**：typecheck + test + build |
| `npm run doctor` | 环境自检（Node 版本 / 依赖 / .env / 端口） |
| `npm run smoke` | 对运行中的服务做只读接口冒烟（默认 3000） |
| `npm run check:cycles` | src/lib 模块循环依赖检查 |
| `npm run check:migrations` | 迁移安全检查：破坏性操作（DROP/DELETE/UPDATE 无 WHERE）必须有 `-- safe:` 说明 |

> 说明：npm scripts 里已用 `NEXT_TELEMETRY_DISABLED=1` 关闭 Next.js 的匿名遥测（本机隐私优先，见 ADR-0002）；请不要移除。

## 3. 工作方式
1. **先给计划，再改代码**；一次只做一个主题，小步可回滚。
2. 改完必须跑 `npm run verify` 并贴出结果；失败就修，**不许跳过、不许伪造**。
3. 不删除业务逻辑、不做大爆炸重构；新代码对旧数据向后兼容。
4. 新增依赖前先回答「四问」：解决什么问题？现有依赖/标准库为何不行？体积与维护活跃度？能否用少量本地代码实现？——**默认答案为「不新增」**。
5. 加新功能必须带测试（tests/ 下，参考现有用例风格）；修 bug 优先补一个能复现的用例。
6. 信息不足先问，不要猜。
7. 改完代码按第 5 节同步部署。

## 4. 架构与边界
- 目录：`src/app`（页面 + API 路由）、`src/components`（通用 UI）、`src/lib`（引擎与各系统）。
- 依赖方向：`app/components → lib`，禁止反向；lib 模块之间保持单向（`npm run check:cycles` 保证无环）。
- `src/lib/db.ts` 是唯一数据库入口；**所有写操作必须走事务**（`tx()`）并落在 lib 服务层——API 路由不得直接写 SQL（已全部收敛，违反由 `npm run check:cycles` 与代码审查把关）。
- 提示词中枢在 `src/lib/prompts.ts`；她的回复落库前必过 `src/lib/humanize.ts`（人味层）。
- 页面经 `/api/*` 访问数据；组件不得直接 import db。

## 5. 部署流程（本机工作区 → 桌面运行目录 → GitHub 副本）
1. 本工作区改好并 `npm run verify` 全绿。
2. 同步到桌面运行目录 `D:\桌面\虚拟女友`（robocopy，排除 `node_modules/.next/data/.git`，排除 `.env.local*`、`*.bak-*`、`*.tsbuildinfo`），在桌面目录 `npm run build`。
3. 同步到开源副本 `D:\桌面\虚拟女友-开源版`，然后**必须**运行 `node _sanitize_for_github.mjs`（清洗真实 Key / 内网地址，幂等）；其复扫输出必须为「干净 ✓」——**不要把任何内网地址 / Key 片段写进文档、注释或提交信息**（关键词清单只维护在脚本里）；副本绝不允许出现 `data/`、`.env.local*`、`*.bak-*`。
4. 副本 git 提交（单主题提交，说明「改了什么、为什么」）。
5. 用户数据目录永远不参与任何同步。

## 6. 已知技术债（允许存在，但不许恶化）
- ESLint / Prettier 未引入（等网络环境允许后评估；当前门禁 = tsc + node:test + build）。
- API 路由写操作已全部收敛到 lib 服务层（2026-10-05 完成，18 处 dbRun → 服务函数）；路由层只剩 `tx()` 事务包裹与 `dbAll`/`dbGet` 只读查询。
- `any` 使用约 280 处（多为页面组件的宽松类型）：新代码尽量写准确类型，老代码逐步替换。
- 超长文件（>450 行）9 个：`src/app/page.tsx`、`src/lib/life.ts`、`src/app/settings/page.tsx`、`src/lib/db.ts`、`src/lib/llm.ts`、`src/app/world/page.tsx`、`src/lib/analysis.ts`、`src/lib/prompts.ts`、`src/lib/memory.ts`——列 P2 拆分清单，不强行一次拆完。
- 时间/随机数使用点较多（可测性）：新代码优先把「现在时间」作为参数传入，便于测试。
- TypeScript 严格化：`strict` 已开；`noUncheckedIndexedAccess` 经评估会给现有代码带来 115 处改动（20+ 文件），按「小步、逐目录推进」原则**暂未开启**——启用前需要单独一批修复 + 全量测试。新代码请主动做数组越界防护（如 `arr[0]!` 仅在确证非空时使用，或显式判空）。

## 7. 关键决策记录（ADR）
- 位置：`docs/adr/`（格式与用法见其 README）。
- 引入依赖、改架构边界、改数据策略等重大决策，必须补一份 ADR 并在提交信息里引用编号。