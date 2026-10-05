// 测试基建：Node 原生 TS 运行（type stripping）不支持无扩展名的相对导入，
// 也不解析 tsconfig 的 "@/*" 路径别名；这里补两条解析钩子（仅影响测试进程，不改源码）：
//   './actions' -> './actions.ts'
//   '@/lib/engine' -> '<repo>/src/lib/engine.ts'
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

export async function resolve(specifier, context, next) {
  // tsconfig paths: "@/*" -> "./src/*"（让测试可以直接调用 app 路由导出的处理函数）
  if (specifier.startsWith('@/')) {
    const base = path.join(SRC, specifier.slice(2));
    for (const candidate of [base + '.ts', base + '.tsx', base]) {
      try {
        return await next(pathToFileURL(candidate).href, context);
      } catch {
        /* 试下一个候选 */
      }
    }
    return next(specifier, context);
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    try {
      return await next(specifier + '.ts', context);
    } catch {
      /* 继续按原样解析（可能是 js 或目录） */
    }
  }
  return next(specifier, context);
}