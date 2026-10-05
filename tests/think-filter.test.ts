// 思考标签过滤 + 流式安全上限回归（llm-stream.ts）
// 隐私：import 链会带上 db，但只有"超长流"用例才写入独立的临时库；绝不触碰 data/ 下的真实数据。
// 注意：这里同样不写标签字面量，全部用字符码拼出来（与源码一致，避免被任何"清洗"环节吃掉）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-think-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const streamMod = await import('../src/lib/llm-stream.ts');
const dbMod = await import('../src/lib/db.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 未打开 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

/* 用字符码拼标签，避免源码标签字面量被"清洗" */
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const tag = (name: string, closing = false): string => `${LT}${closing ? '/' : ''}${name}${GT}`;

/** 把一串分片依次喂给 filterThinkDelta，返回最终展示文本 */
function feed(pieces: string[]): string {
  const state: { inThink: boolean; pending?: string; thoughtLen?: number } = { inThink: false };
  let out = '';
  for (const p of pieces) out += streamMod.filterThinkDelta(state, p);
  return out;
}

/* ------------------------------------------------------------------ */
/* P1-18 第一层：白名单标签跨 chunk 过滤（原有行为不回归 + 变体扩展）    */
/* ------------------------------------------------------------------ */
test('thinking / think / redacted_thinking 原有行为不回归', () => {
  assert.equal(feed([tag('thinking'), '我在想', tag('thinking', true), '你好呀']), '你好呀');
  assert.equal(feed([tag('think'), '想', tag('think', true), '嗨']), '嗨');
  assert.equal(feed([tag('redacted_thinking'), 'x', tag('redacted_thinking', true), 'ok']), 'ok');
});

test('reasoning / analysis / reflection / thought / chain_of_thought 跨 chunk 不泄露', () => {
  // 闭合标签被切在 chunk 边界
  assert.equal(feed([tag('reasoning'), '推理中…', LT + '/re', 'asoning' + GT, '答案。']), '答案。');
  assert.equal(feed([tag('analysis'), '内部', tag('analysis', true), '外面']), '外面');
  assert.equal(
    feed([tag('reflection'), 'a', tag('reflection', true), 'b', tag('thought'), 'c', tag('thought', true), 'd']),
    'bd'
  );
  assert.equal(feed([tag('chain_of_thought'), 'x', tag('chain_of_thought', true), 'y']), 'y');
});

test('大小写不敏感 + 标签可带属性 + 中文标签', () => {
  assert.equal(feed([`${LT}Reasoning ${GT}`, 'X', `${LT}/Reasoning ${GT}`, 'Hi']), 'Hi');
  assert.equal(feed([tag('思考'), '内部', tag('思考', true), '嗨']), '嗨');
});

test('正常文本（数学符号 / 单个 "<"）不被误删', () => {
  const math = '3 ' + LT + ' 4 对吗？';
  assert.equal(feed([math]), math);
  const normal = '我 ' + LT + '你' + GT + ' 呀。';
  assert.equal(feed([normal]), normal);
});

/* ------------------------------------------------------------------ */
/* P1-18 第二层：cleanContent 成对未知标签块兜底                        */
/* ------------------------------------------------------------------ */
test('cleanContent：成对出现的未知标签块整块删除', () => {
  assert.equal(streamMod.cleanContent(tag('scratchpad') + '推理过程' + tag('scratchpad', true) + '好呀。'), '好呀。');
  assert.equal(streamMod.cleanContent(tag('reasoning') + '秘密' + tag('reasoning', true) + '你好'), '你好');
});

test('cleanContent：单个 "<" / 未配对标签不误删', () => {
  const math = 'a ' + LT + ' b 且 3' + LT + '4';
  assert.equal(streamMod.cleanContent(math), math);
  const lone = 'a' + LT + 'y' + GT + 'c';
  assert.equal(streamMod.cleanContent(lone), lone);
});

/* ------------------------------------------------------------------ */
/* P1-17 累计缓冲上限：超长增量流 → 截断并正常收尾，不 OOM              */
/* ------------------------------------------------------------------ */
test('超长增量流：达到上限即截断并正常收尾（不抛错、有告警）', async () => {
  dbMod.setSetting('llm_base_url', 'http://127.0.0.1:9/v1');
  dbMod.setSetting('llm_api_key', 'test-key');
  dbMod.setSetting('llm_model', 'test-model');

  const origFetch = globalThis.fetch;
  const origWarn = console.warn;
  const warns: string[] = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '));
  };

  const perLine = '啊'.repeat(2000);
  const maxLines = 1000; // 潜在总量 2,000,000 字，远超 512K 上限
  let pulled = 0;
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= maxLines) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: perLine } }] })}\n\n`)
        );
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  try {
    let deltaChars = 0;
    const out = await streamMod.chatStream(
      [{ role: 'user', content: 'hi' }],
      (t) => {
        deltaChars += t.length;
      },
      { maxTokens: 100 }
    );
    assert.ok(out.length > 0, `截断后仍应返回非空文本，实际 ${out.length}`);
    assert.ok(out.length >= 520000 && out.length <= 530000, `应在上限附近截断，实际 ${out.length}`);
    assert.ok(deltaChars > 0, '应至少回吐过增量');
    assert.ok(pulled < maxLines, `应在消费完整流前就停止，实际 pull ${pulled}`);
    assert.ok(
      warns.some((w) => w.includes('上限')),
      `应打印一条截断告警，实际 ${JSON.stringify(warns)}`
    );
  } finally {
    globalThis.fetch = origFetch;
    console.warn = origWarn;
  }
});