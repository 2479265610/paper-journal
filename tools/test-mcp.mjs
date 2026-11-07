#!/usr/bin/env node
/**
 * MCP 端到端测试：
 *   1. 先启动纸间（桌面 exe / electron，或浏览器开 http://localhost:8787）
 *   2. node tools/test-mcp.mjs
 * 流程：spawn mcp-server.mjs → initialize → tools/list → diary_stats → write_diary → list_entries 验证
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const proc = spawn(process.execPath, [path.join(root, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const waitMsg = (pred, label, ms = 25000) => new Promise((resolve, reject) => {
  const onData = (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (pred(m)) { proc.stdout.off('data', onData); resolve(m); return; }
      } catch { /* 忽略非 JSON 行 */ }
    }
  };
  proc.stdout.on('data', onData);
  setTimeout(() => { proc.stdout.off('data', onData); reject(new Error(label + ' 超时')); }, ms);
});

const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
const ok = [];
const fail = (m) => { console.error('✗ ' + m); proc.kill(); process.exit(1); };
const pass = (m) => { console.log('✓ ' + m); ok.push(m); };

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } } });
  const init = await waitMsg(m => m.id === 1, 'initialize');
  pass('initialize · ' + init.result.serverInfo.name);

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tl = await waitMsg(m => m.id === 2, 'tools/list');
  pass('tools/list · ' + tl.result.tools.map(t => t.name).join(', '));

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'diary_stats', arguments: {} } });
  const cs = await waitMsg(m => m.id === 3, 'diary_stats');
  if (cs.result.isError) fail('diary_stats: ' + cs.result.content[0].text);
  pass('diary_stats · ' + cs.result.content[0].text.split('\n')[0]);

  const md = '# 由 AI 写下\n\n这是 **MCP 端到端测试** 写入的一篇。\n- 要点一\n- 要点二\n> 引用一句';
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_diary', arguments: { title: 'AI 自检日记', body_markdown: md, tags: ['ai测试'] } } });
  const cw = await waitMsg(m => m.id === 4, 'write_diary');
  if (cw.result.isError) fail('write_diary: ' + cw.result.content[0].text);
  const idMatch = cw.result.content[0].text.match(/id: ([\w-]+)/);
  if (!idMatch) fail('write_diary 返回里没有 id');
  pass('write_diary · ' + cw.result.content[0].text);

  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_entry', arguments: { entry_id: idMatch[1] } } });
  const cr = await waitMsg(m => m.id === 5, 'read_entry');
  if (cr.result.isError) fail('read_entry: ' + cr.result.content[0].text);
  if (!cr.result.content[0].text.includes('MCP 端到端测试')) fail('读回的内容不含写入的文本');
  pass('read_entry · 内容一致');

  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'search_diary', arguments: { query: 'MCP 端到端测试' } } });
  const cse = await waitMsg(m => m.id === 6, 'search_diary');
  if (!cse.result.content[0].text.includes('AI 自检日记')) fail('搜索没找到刚写入的日记');
  pass('search_diary · 命中');

  console.log('\nMCP 端到端测试：' + ok.length + ' 项全部通过');
  proc.kill();
  process.exit(0);
} catch (e) {
  fail(e.message);
}
