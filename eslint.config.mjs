// ESLint 扁平配置（flat config）
// 说明：本项目为 Next.js 15 + React 19 + TypeScript 单体应用。
// 之所以引入 ESLint，是为了补上「已知技术债」里长期缺失的静态检查门禁。
// 注意：lint 独立运行（见 next.config.mjs 的 eslint.ignoreDuringBuilds），不与 next build 耦合。

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next@15.5 尚未提供 flat config 原生导出，
// 因此用 FlatCompat 桥接其 eslintrc 版配置（next/core-web-vitals）。
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default tseslint.config(
  // 忽略：构建产物、依赖、用户隐私数据、静态资源、Next 自动生成的类型声明。
  {
    ignores: ['.next/**', 'node_modules/**', 'data/**', 'public/**', 'next-env.d.ts'],
  },

  // 1) ESLint 官方推荐规则
  js.configs.recommended,

  // 2) TypeScript 推荐规则（含 @typescript-eslint/parser）
  ...tseslint.configs.recommended,

  // 3) Next.js core-web-vitals（经 FlatCompat 桥接）
  ...compat.extends('next/core-web-vitals'),

  // 4) 全局运行环境：既有浏览器端（React 组件），也有 Node 端（API 路由 / 脚本 / 测试）
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },

  // 5) 针对本项目的规则调整：抓真问题，但不被风格噪音淹没
  {
    rules: {
      // 禁止显式 any（2026-10-05 已全仓清零，见 ADR-0004；不要用 eslint-disable 绕过）
      '@typescript-eslint/no-explicit-any': 'error',

      // 未使用变量报错；以 _ 开头的参数/变量视为「有意忽略」
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // 本项目有意使用原生 <img>（本地资源、无需 next/image 优化），关闭该告警
      '@next/next/no-img-element': 'off',

      // 中文文案中大量出现英文单引号等字符，react/no-unescaped-entities 会在中文语境下
      // 大面积误报且无实际价值（React 并不会因此出错），故关闭。
      'react/no-unescaped-entities': 'off',

      // React 19 / Next 15 的 App Router 下无需在每个组件文件显式 import React，
      // 该规则属于旧式 JSX 变换时代的产物，对本项目长期误报，关闭。
      'react/react-in-jsx-scope': 'off',
    },
  },
);