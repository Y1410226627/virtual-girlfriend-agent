// 世界模拟与生活系统：她有自己的作息、身体、心理、位置、活动与日常事件
// 设计要点：连续性优先（一切由"流逝了多少时间"推导，不随机跳变）、独立生活、逐步揭露、状态影响对话
//
// 本文件是桶文件（barrel）：实现已拆分到以下子模块，对外 API 全部从这里再导出。
// 依赖方向（无环）：core ← events ← sim；core ← shared ← {sim, arc, prompt}
export * from './life-core';
export * from './life-events';
export * from './life-shared';
export * from './life-sim';
export * from './life-arc';
export * from './life-prompt';