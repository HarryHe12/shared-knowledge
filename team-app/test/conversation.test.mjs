import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAnswer, renderAnswerPrompt} from '../src/conversation.mjs';

const evidence = [{id: 'rec-a', text: '冷柜周二修', author: '小李', occurred_at: '2026-10-28T02:00:00Z'},
  {id: 'rec-b', text: '报价1800', author: '小王', occurred_at: '2026-10-29T02:00:00Z'}];

test('[n] 编号映射为引用并从正文去掉，合并编号与全角括号都识别', () => {
  const result = parseAnswer('冷柜周二修 [1]，报价1800【2】。两件事都定了［1，2］', evidence);
  assert.equal(result.answer, '冷柜周二修，报价1800。两件事都定了');
  assert.deepEqual(result.citations, ['rec-a', 'rec-b']);
  assert.equal(result.quality, 'supported');
});

test('越界或无关的方括号数字原样保留，不算引用', () => {
  const result = parseAnswer('3号桌在【5】号位置 [9]', evidence);
  assert.equal(result.answer, '3号桌在【5】号位置 [9]');
  assert.deepEqual(result.citations, []);
  assert.equal(result.quality, 'unsupported');
});

test('兼容旧 JSON 输出；引用不在资料里时拒绝', () => {
  assert.deepEqual(parseAnswer(JSON.stringify({answer: '周二修', citations: ['rec-a']}), evidence).citations, ['rec-a']);
  assert.throws(() => parseAnswer(JSON.stringify({answer: '编的', citations: ['nope']}), evidence), {status: 503});
  assert.throws(() => parseAnswer('   ', evidence), {status: 503});
});

test('提示词按人和日期呈现资料，没有内部字段；没资料时明说', () => {
  const prompt = renderAnswerPrompt({question: '冷柜啥时候修', today: '2026-11-01', evidence,
    history: [{role: 'user', text: '在吗'}, {role: 'assistant', text: '在的'}]});
  assert.match(prompt, /\[1\] 小李 · 2026-10-28：冷柜周二修/);
  assert.match(prompt, /同事：在吗\n你：在的/);
  assert.ok(!prompt.includes('rec-a'));
  assert.match(renderAnswerPrompt({question: '你好', evidence: []}), /暂时没找到/);
});
