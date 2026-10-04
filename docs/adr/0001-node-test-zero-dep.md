# ADR 0001：测试用 Node 内置 test runner（零新增依赖）

## 背景
项目此前完全没有测试。工程机制补全要求「先造验证回路，覆盖一条最核心路径」，并优先考虑与体量匹配的方案。
本项目的一个核心特征是「零原生依赖，用户双击 启动.cmd 即用」，安装负担越轻越好。

## 决策
用 `node --test`（Node ≥22.13 自带）作为测试框架，配合一条 20 行的解析钩子
（tests/_ts-hooks.mjs）让 Node 直接运行 `src` 下的 `.ts`（type stripping）；不引入 Vitest/Jest。

## 理由
- 零新增依赖：不增加用户 `npm install` 的体积与失败面；与项目「自带能力优先」的约束一致。
- 覆盖的核心路径（`humanizeReply` 及其纯逻辑依赖链 actions/stickers/utils）不需要 DOM 与模块 mock，
  Node 原生 runner 完全够用。
- 测试可在网络受限环境运行（不下载任何东西），对本地单人 + AI 协作场景最稳。

## 影响
- 测试文件写 `.ts`，import 源码时**必须带 `.ts` 扩展名**（Node 原生运行要求）；
  源码内部的无扩展名相对导入由测试钩子补全，源码本身不改。
- `npm run test` 即全量测试；`npm run verify` = typecheck + test + build。
- 若未来需要组件测试 / DOM 环境，再评估引入 Vitest（需另开 ADR）。

## 替代方案
- Vitest / Jest：生态成熟，但新增依赖 + 配置成本高于当前体量收益；暂不采用。
- Playwright E2E：浏览器体量过大；当前用 `npm run smoke`（只读接口冒烟）替代。