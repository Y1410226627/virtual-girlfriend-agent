// 测试入口钩子：注册 TS 相对导入补全（用法：node --import ./tests/node-ts-resolver.mjs --test tests/）
import { register } from 'node:module';

register('./_ts-hooks.mjs', import.meta.url);