# AGENTS.md —— 给 AI 协作者的工程规则（本项目专用）

> 任何 AI（或人）在修改本仓库前，先读完本文件。这里写的是「这个项目怎么做改动」；
> 产品说明见 README.md，决策记录见 docs/adr/。

## 0. 项目定位
- 「她 · 虚拟女友」：本地运行的 Next.js 15 + React 19 + TypeScript 单体应用；数据存本地 SQLite（node:sqlite，零原生依赖，不用装数据库）。
- 单体、单包、单部署单元；这是**应用**不是库——不需要语义化版本、变更日志、发布流水线。
- 维护者是零编程基础的用户 + AI 协作，**没有专职运维**：所有机制以「本地一条命令可验证」为准。

## 1. 不可触碰的红线（最高优先级）
1. **用户数据是隐私**：`data/` 与 `.env.local` 是用户资产。绝不查看、打印、提交或外传其内容；需要测试时必须在**空白库**（删除 `data/girlfriend.db*` 后重启自动重建）中进行，绝不拿真实库做实验。
2. **数据库迁移只允许加表、加列**：迁移写在 `src/lib/db-migrations.ts` 的 MIGRATIONS 末尾追加，**绝不修改历史条目、绝不 DROP 业务数据**；破坏性变更必须拆成两步（先双写过渡）。`npm run check:migrations` 会拦截未说明理由的破坏性操作。
3. **不破坏用户自定义**：用户改过的记忆、人设、数值、偏好、聊天记录不得被「顺手优化」覆盖或回退。
4. **不上报任何数据**：不接第三方统计 / 错误上报（Sentry 等一律不要），所有数据留在本机。

## 2. 可用命令（改完必须自证）
| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（端口 3000） |
| `npm run build` / `npm start` | 生产构建 / 启动 |
| `npm run start:lan` | 局域网模式启动（绑定 0.0.0.0，配合 `ACCESS_PIN` 使用；「启动.cmd」走的就是它，手机同网可访问） |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run lint` | ESLint（no-explicit-any / no-unused-vars 为 error，见 ADR-0004） |
| `npm run test` | Node 原生测试（tests/，零新增依赖） |
| `npm run verify` | **提交前必须全绿**：typecheck + lint + test + check:cycles + check:migrations + build |
| `npm run doctor` | 环境自检（Node 版本 / 依赖 / .env / 端口） |
| `npm run smoke` | 对运行中的服务做只读接口冒烟（默认 3000） |
| `npm run check:cycles` | src/lib 模块循环依赖检查 |
| `npm run check:migrations` | 迁移安全检查：破坏性操作（DROP/DELETE/UPDATE 无 WHERE）必须有 `-- safe:` 说明 |

> 说明：npm scripts 里已用 `NEXT_TELEMETRY_DISABLED=1` 关闭 Next.js 的匿名遥测（本机隐私优先，见 ADR-0002）；请不要移除。
> CI：`.github/workflows/verify.yml` 在 push/PR 时跑与本地一致的全部门禁（网络恢复后启用，见 ADR-0004）。

## 3. 工作方式
1. **先给计划，再改代码**；一次只做一个主题，小步可回滚。
2. 改完必须跑 `npm run verify` 并贴出结果；失败就修，**不许跳过、不许伪造**。
3. 不删除业务逻辑、不做大爆炸重构；新代码对旧数据向后兼容。
4. 新增依赖前先回答「四问」：解决什么问题？现有依赖/标准库为何不行？体积与维护活跃度？能否用少量本地代码实现？——**默认答案为「不新增」**。
5. 加新功能必须带测试（tests/ 下，参考现有用例风格）；修 bug 优先补一个能复现的用例。
6. 信息不足先问，不要猜。
7. 改完代码按第 5 节同步部署。

## 4. 架构与边界
- 目录：`src/app`（页面 + API 路由）、`src/components`（通用 UI；`chat/`、`settings/`、`world/` 等子目录放页面私有组件）、`src/lib`（引擎与各系统）。
- 依赖方向：`app/components → lib`，禁止反向；lib 模块之间保持单向（`npm run check:cycles` 保证无环）。
- `src/lib/db.ts` 是唯一数据库入口；**所有写操作必须走事务**（`tx()`）并落在 lib 服务层——API 路由不得直接写 SQL（已全部收敛，违反由 `npm run check:cycles` 与代码审查把关）。表结构迁移单独放在 `src/lib/db-migrations.ts`。
- 大模块采用「桶 + 子模块」结构（2026-10-05 拆分，见 ADR-0004）：`life.ts`、`llm.ts`、`personality.ts`、`analysis.ts`、`memory.ts`、`prompts.ts` 是**桶文件**（`export *` 再导出），实际实现按职责在同级子文件里；**改代码时去对应子文件，不要往桶里加逻辑**。子文件之间只允许单向依赖，且绝不能 import 桶自身（会成环）。
- 提示词中枢在 `src/lib/prompts.ts`（块拼接在 `prompt-blocks.ts`）；她的回复落库前必过 `src/lib/humanize.ts`（人味层）。
- 页面经 `/api/*` 访问数据；组件不得直接 import db。
- **单文件行数**：超过 450 行列入观察（优先拆分），超过 600 行必须拆分（追加式数据文件如 `db-migrations.ts` 除外）。

## 5. 部署流程（本机工作区 → 桌面运行目录 → GitHub 副本）
1. 本工作区改好并 `npm run verify` 全绿。
2. 同步到运行目录 `D:\虚拟女友`（robocopy，排除 `node_modules/.next/data/.git`，排除 `.env.local*`、`*.bak-*`、`*.tsbuildinfo`），在该目录 `npm run build`。
3. 同步到开源副本 `D:\虚拟女友-开源版`（robocopy 额外排除 `_sanitize_for_github.mjs`——脚本含关键词清单，**绝不进副本、绝不提交**），然后在**真实项目目录**运行 `node _sanitize_for_github.mjs`（默认清洗副本、幂等、含兜底横扫：敏感串随代码搬家后仍能清到）；其复扫输出必须为「干净 ✓」——**不要把任何内网地址 / Key 片段写进文档、注释或提交信息**（关键词清单只维护在脚本里）；副本绝不允许出现 `data/`、`.env.local*`、`*.bak-*`、`_sanitize_for_github.mjs`。
4. 副本 git 提交（单主题提交，说明「改了什么、为什么」）。
5. 用户数据目录永远不参与任何同步。

> **现状备注（2026-10-31，项目已迁回 D 盘）**：`D:\虚拟女友` 目前就是「真实项目/运行目录」（最新代码在这里开发与运行）；上面第 3~4 步已由 `同步开源版.cmd`（内部 `node sync-open-source.mjs "提交说明"`）自动化：镜像复制 + 脱敏 + 隐私终检 + 自动提交 + 推送，一条命令替代原来的手工 robocopy/sanitize/commit。旧路径 `E:\虚拟女友` / `D:\桌面\...` 均已失效（开机自启快捷方式与清洗脚本已改指 D 盘）。**以 D 盘为准。**
> 手机访问：`启动.cmd` 已内置局域网模式（`start:lan`）+ 访问口令（PIN 保存在 `data\access-pin.txt`，只在本机、不入库不入提交），启动窗口会直接打印手机访问地址；开机自启由「启动」文件夹里的快捷方式负责。

## 6. 技术债台账（动态更新；已还清的保留一行记录，避免复辟）
- ✅ **ESLint 已引入**（2026-10-05，ADR-0004）：flat config + Next 桥接；`no-explicit-any` / `no-unused-vars` 为 error，随 `npm run verify` 门禁执行。**Prettier 经评估不引入**（全仓重排 diff 噪音大、单人+AI 场景收益低），理由见 ADR-0004。
- ✅ **API 路由写操作已全部收敛到 lib 服务层**（2026-10-05，18 处 dbRun → 服务函数）；路由层只剩 `tx()` 事务包裹与 `dbAll`/`dbGet` 只读查询。
- ✅ **`any` 已清零**（2026-10-05，310 处 → 0）：全仓精确类型化（行接口 / 请求体类型 / `errMsg` 统一异常取消息 / `parseJsonLoose` 返回 `unknown`）。lint 会拦截新增 any，**不要用 `eslint-disable` 绕过**。
- ✅ **超长文件已全部拆分**（2026-10-05，ADR-0004）：9 个长文件 → 桶 + 子模块（如 `life.ts` 拆为 life-core/events/sim/shared/arc/prompt 六个子模块；三个页面各拆出 `components/<页面>/` 组件目录）；当前唯一 >450 行的代码文件是 `src/lib/db-migrations.ts`（追加式 SQL 数据文件，**刻意保持单文件单数组**，见红线 1.2）。
- ⏳ **时间/随机数可测性**（长期约定，非待办）：新代码优先把「现在时间」作为参数传入（参考 `parseExpectedEnd(text, from)`），便于写确定性测试；老代码不强制回改。
- ✅ **TypeScript 严格化完成**（2026-10-05）：`noUncheckedIndexedAccess` 已启用（115 处修复，零行为变化）。**不要关闭此开关**；新代码请主动做数组越界防护（`arr[0]!` 仅在确证非空时使用，或显式判空）。
- ✅ **回合/生成/操作账本落地**（2026-10-06，ADR-0005）：新增 conversation_turns / message_generations / analysis_jobs / turn_operations 四表（v12）；服务端会话锁 `withConversationLock`；`prepareTurn` 去副作用、成功后才 `commitTurn`；重新生成 = 同 turn 新 generation；分析任务落库持久化 + generation 版本校验（取消"队列满静默丢弃"）；删除/撤回优先按账本精确回滚（旧数据保留推断式兜底）。**改聊天链路前先读 `src/lib/turn.ts` 与 ADR-0005**。
- ✅ **质量层落地**（2026-10-06）：回复校验层（低分自动重答一次，`src/lib/reply-validator.ts`）；记忆事实键 `memories.fact_key` 主判 + 向量辅助；`affect_state`（此刻情绪）与长期指标分家；主动消息做自我暴露抽取（她自己的话进她自己的记忆/计划）；提示词分层 + 数据块 `<DATA>` 包裹。
- ✅ **本地安全边界**（2026-10-06，ADR-0005）：dev/start 默认只监听 `127.0.0.1`；设置 `ACCESS_PIN` 才启用 middleware 门禁；已保存 Key 绑定保存时 host（换地址不携带旧 Key）；GET 路由只读化，后台推进走 `POST /api/tick` + scheduler。
- ✅ **多模态与陪伴感**（2026-10-06，参考开源同类项目补全）：语音输入（自配 OpenAI 兼容 ASR，`/api/asr`）、发图给她看（多模态消息 + `data/uploads` + 视觉不可用自动降级，`/api/uploads/[name]`）、触摸互动（`/api/interact` + `src/lib/interactions.ts`，冷却与每日上限）、心动指数（`src/lib/doki.ts`）、主动消息回应率分寸感（`proactive.ts`，仪式/纪念日豁免）。上传图片属用户隐私：`data/uploads/` 已加入 .gitignore，且 `data/` 整体不参与任何同步。
- ✅ **本地知识库**（2026-10-28，参考 AstrBot `knowledge_base` 的 dense/sparse 融合思路）：v17 新增 `kb_docs` / `kb_chunks` / `kb_chunk_embeddings` 三表；`src/lib/knowledge.ts` 负责切块（按句，≤420 字）+ 向量复用（`embed`，未配接口时自动本地哈希）+ 混合检索（余弦 0.7 + 字二元组 0.3）；`prepareTurn` 按他此刻的话检索 ≤3 段、注入系统提示词（`<DATA>` 包裹），无资料或异常时零回归；设置页「知识库」卡片支持粘贴或读入 `.txt/.md`（≤30 篇、单篇 ≤6 万字），删除时级联清理块与向量。**资料属用户隐私：只存本机数据库，不上传、不参与任何同步。**
- ✅ **提醒**（2026-10-28，参考 AstrBot cron + 工具意图）：v18 新增 `reminders` 表；在聊天里说「提醒我 20 分钟后… / 明天早上 8 点…」→ **本地确定性解析**（`src/lib/reminder-parse.ts`，不依赖模型）→ 回复成功后才落库（按用户消息幂等，重新生成不重复）→ 调度器 `tickReminders` 到点用她的口吻发一条（不占主动消息额度；生成失败保持 pending，下轮重试）；系统提示词注入"自然答应"提示；设置页「提醒」卡片可查看/取消。支持相对时间、今天/明天/后天/周几、上午/下午/晚上与默认时刻；时间不确定时不误报。
- ✅ **本地向量后端（2026-10-28）**：`embedding_base_url` / `embedding_model` 可独立于聊天接口配置（已有三态 Key 与 host 绑定保护）；推荐本机 Ollama + `qwen3-embedding:0.6b`（1024 维、免费不限量、数据不出本机），仓库内 `嵌入服务.cmd` 负责拉起服务/首次拉取模型；换模型后用 `POST /api/settings {action:"rebuild_embeddings"}` 重算全部记忆向量（v17 的 KB 向量同源，换模型后旧向量自动失效、按需重算）；向量服务不可用时自动回退本地哈希向量（`embeddingMode()` 可见），不影响聊天。
- ✅ **四套配色皮肤**（2026-10-31，参考开源同类项目 ai-girlfriend 的换肤）：`src/lib/skins.ts` + `globals.css` 的 `html[data-skin]` 覆盖（樱粉暖阳/暗夜紫火/薄荷奶咖/雾蓝海盐，均适配浅色/深色）；设置页「外观」切换，**只存本机 localStorage**（不进数据库、不参与同步）；`layout.tsx` 的初始化脚本在渲染前应用，避免闪色；用户气泡/进度条/导航未读点/阶段条改走主题变量（不再硬编码玫瑰色）。新增 `tests/skins.test.ts`。
- ⏳ **共享世界规范化拆表**：事务化读改写已消除丢更新；若未来需要逐条查询/统计再拆表，必须走"双写过渡"。
- ⏳ **事件驱动架构（Turn/Event → projections）**：账本已提供事实源；各模块目前仍以"读当前状态"为主，按需演进。
- ⏳ **对话质量自动评测基准**：现有单测覆盖行为正确性；100~300 场景的对话质量回归（topic/intent/emotion 命中）留待专项。
- ⏳ **prompt token 压缩**：上下文已分层并标注优先级，未做体积压缩。
- ✅ **GitHub push 已打通**（2026-10-06）：`origin` 为 SSH（git@github.com），命令行 `git push` 可直接推送；推送后 CI（`.github/workflows/verify.yml`）自动跑与本地一致的全部门禁。若再遇网络阻断，优先检查代理/加速器，而不是改用其它通道。

## 7. 关键决策记录（ADR）
- 位置：`docs/adr/`（格式与用法见其 README）。
- 引入依赖、改架构边界、改数据策略等重大决策，必须补一份 ADR 并在提交信息里引用编号。