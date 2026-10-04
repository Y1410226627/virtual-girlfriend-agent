// 测试基建：Node 原生 TS 运行（type stripping）不支持无扩展名的相对导入，
// 这里补一条解析钩子：'./actions' → './actions.ts'（仅影响测试进程，不改源码）
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    try {
      return await next(specifier + '.ts', context);
    } catch {
      /* 继续按原样解析（可能是 js 或目录） */
    }
  }
  return next(specifier, context);
}