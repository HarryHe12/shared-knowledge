#!/usr/bin/env node
// CLI 问答入口：node librarian/scripts/answer-cli.mjs "问题"
// 环境变量：KB_URL / KB_LLM_*

import {KnowledgeBase} from '../../collector/src/kb.mjs';
import {LLM} from '../../collector/src/llm.mjs';
import {answerQuestion} from './answer.mjs';

async function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('用法：node librarian/scripts/answer-cli.mjs "你的问题"');
    process.exit(2);
  }
  const kb = new KnowledgeBase(process.env.KB_URL);
  const llm = new LLM();
  const answer = await answerQuestion(kb, llm, question);
  console.log(answer);
}

main().catch((err) => {
  // answerQuestion 自身永不抛异常，这里是连接级兜底
  console.error('问答失败：' + (err?.message ?? err));
  process.exitCode = 0;
});
