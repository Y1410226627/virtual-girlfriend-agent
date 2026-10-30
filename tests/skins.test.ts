import test from 'node:test';
import assert from 'node:assert/strict';
import { SKINS, DEFAULT_SKIN, isSkinId, skinName } from '../src/lib/skins';

test('皮肤列表：四套、id 唯一、都有名称与色板', () => {
  assert.equal(SKINS.length, 4);
  assert.equal(new Set(SKINS.map((s) => s.id)).size, SKINS.length);
  for (const s of SKINS) {
    assert.ok(s.name.length > 0, '皮肤名称不应为空');
    assert.ok(s.dot.startsWith('linear-gradient'), '色板应是渐变');
  }
});

test('isSkinId 只接受合法 id', () => {
  assert.equal(isSkinId(DEFAULT_SKIN), true);
  for (const s of SKINS) assert.equal(isSkinId(s.id), true);
  assert.equal(isSkinId('pink'), false);
  assert.equal(isSkinId(''), false);
  assert.equal(isSkinId(null), false);
  assert.equal(isSkinId(1), false);
});

test('skinName 对未知值回退到默认名称', () => {
  assert.equal(skinName('sakura'), '樱粉暖阳');
  assert.ok(skinName('bogus' as never).length > 0);
});
