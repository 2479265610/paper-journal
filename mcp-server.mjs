#!/usr/bin/env node
/**
 * 纸间 · MCP Server（stdio）
 * 让支持 MCP 的 AI 客户端（WorkBuddy / Claude Desktop / Cursor 等）直接操作纸间：
 * 写日记、读日记、搜索、统计。
 *
 * 接入配置（客户端 JSON）：
 *   { "command": "node", "args": ["<仓库路径>/mcp-server.mjs"] }
 *
 * 依赖：纸间应用在线（桌面 exe，或浏览器开着 http://localhost:8787）。
 *      本服务器只是协议转换，数据始终在纸间里。
 * 环境变量 PJ_API 可指定纸间 API 地址（默认自动探测 8787/8791/8792）。
 */

import http from 'node:http';

const API_BASES = process.env.PJ_API
  ? [process.env.PJ_API]
  : ['http://127.0.0.1:8787', 'http://127.0.0.1:8791', 'http://127.0.0.1:8792'];

let apiBase = null;
let baseCheckedAt = 0;

async function apiBase_() {
  if (apiBase && Date.now() - baseCheckedAt < 15000) return apiBase;
  for (const b of API_BASES) {
    try {
      const r = await fetch(b + '/api/ping', { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.agent) { apiBase = b; baseCheckedAt = Date.now(); return b; }
      }
    } catch { /* 下一个 */ }
  }
  throw new Error('纸间不在线：请先打开纸间（桌面 exe，或浏览器打开 http://localhost:8787）');
}

async function api(op, args) {
  const base = await apiBase_();
  const r = await fetch(base + '/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, args: args || {} }),
    signal: AbortSignal.timeout(30000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    throw new Error(j.error || ('HTTP ' + r.status));
  }
  return j.data;
}

/* ── Markdown 轻量转 HTML（与纸间正文白名单匹配） ── */
function md2html(md) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let ul = false, ol = false, quote = false, code = false;
  const buf = [];
  const close = () => {
    if (ul) { out.push('</ul>'); ul = false; }
    if (ol) { out.push('</ol>'); ol = false; }
    if (quote) { out.push('</blockquote>'); quote = false; }
  };
  for (const raw of lines) {
    if (code) {
      if (/^```/.test(raw.trim())) { out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>'); code = false; buf.length = 0; }
      else buf.push(raw);
      continue;
    }
    const t = raw.trim();
    if (/^```/.test(t)) { close(); code = true; continue; }
    if (!t) { close(); continue; }
    let m;
    if ((m = t.match(/^(#{1,4})\s+(.*)/))) {
      close();
      const l = Math.min(m[1].length + 1, 4);
      out.push(`<h${l}>${inline(m[2])}</h${l}>`);
      continue;
    }
    if (/^>\s?/.test(t)) {
      if (!quote) { close(); out.push('<blockquote>'); quote = true; }
      out.push('<p>' + inline(t.replace(/^>\s?/, '')) + '</p>');
      continue;
    }
    if ((m = t.match(/^[-*]\s+(.*)/))) {
      if (quote) { out.push('</blockquote>'); quote = false; }
      if (!ul) { close(); out.push('<ul>'); ul = true; }
      out.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    if ((m = t.match(/^\d+[.)]\s+(.*)/))) {
      if (quote) { out.push('</blockquote>'); quote = false; }
      if (!ol) { close(); out.push('<ol>'); ol = true; }
      out.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    close();
    out.push('<p>' + inline(t) + '</p>');
  }
  close();
  if (code) out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
  return out.join('\n');
}

/* ── MCP 工具定义 ── */
const TOOLS = [
  {
    name: 'write_diary',
    description: '在纸间写一篇日记。body_markdown 支持 # 标题、**粗体**、*斜体*、- 列表、> 引用、``` 代码块。写完后立刻出现在用户的日记本里。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '日记标题（可空字符串表示无题）' },
        body_markdown: { type: 'string', description: '日记正文（Markdown）' },
        book_title: { type: 'string', description: '写入哪本日记本（按名称匹配，缺省写入默认本子）' },
        day: { type: 'string', description: '日记日期 YYYY-MM-DD，缺省为今天' },
        mood: { type: 'string', description: '心情 emoji，可选' },
        weather: { type: 'string', description: '天气 emoji，可选' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组，可选' }
      },
      required: ['title', 'body_markdown']
    }
  },
  {
    name: 'append_to_diary',
    description: '往某一篇已有日记的末尾追加内容（Markdown）。',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: '日记条目 id（list_entries 返回的 id）' },
        body_markdown: { type: 'string', description: '要追加的正文（Markdown）' }
      },
      required: ['entry_id', 'body_markdown']
    }
  },
  {
    name: 'list_books',
    description: '列出纸间里所有的日记本（名称、类型、篇数）。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_entries',
    description: '列出日记条目（默认最近 20 篇）：日期、标题、摘要、id。',
    inputSchema: {
      type: 'object',
      properties: {
        book_title: { type: 'string', description: '按日记本名称过滤，可选' },
        limit: { type: 'number', description: '返回条数，默认 20，最大 100' }
      }
    }
  },
  {
    name: 'read_entry',
    description: '读取某一篇日记的全文（纯文本）。',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'string' } },
      required: ['entry_id']
    }
  },
  {
    name: 'search_diary',
    description: '全文搜索日记（标题、正文、标签）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: '默认 10' }
      },
      required: ['query']
    }
  },
  {
    name: 'diary_stats',
    description: '纸间统计：总篇数、记录天数、连续记录天数、日记本数量。',
    inputSchema: { type: 'object', properties: {} }
  }
];

/* ── 工具实现 ── */
async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'write_diary': {
      const r = await api('entries.write', {
        title: args.title || '',
        bodyHtml: md2html(args.body_markdown || ''),
        bookTitle: args.book_title || '',
        day: args.day || '',
        mood: args.mood || '',
        weather: args.weather || '',
        tags: Array.isArray(args.tags) ? args.tags.slice(0, 12) : []
      });
      return `已写入日记《${r.title || '无题'}》（${r.day}，${r.words} 字，id: ${r.id}）`;
    }
    case 'append_to_diary': {
      const r = await api('entries.append', {
        id: args.entry_id,
        bodyHtml: md2html(args.body_markdown || '')
      });
      return `已追加到《${r.title || '无题'}》（现共 ${r.words} 字）`;
    }
    case 'list_books': {
      const r = await api('books.list', {});
      if (!r.books.length) return '还没有日记本。';
      return '日记本：\n' + r.books.map(b =>
        `- ${b.title}（${b.kind === 'html' ? '网页书 · ' + b.count + ' 个文件' : b.count + ' 篇'}，id: ${b.id}）`
      ).join('\n');
    }
    case 'list_entries': {
      const r = await api('entries.list', {
        bookTitle: args.book_title || '',
        limit: Math.min(Number(args.limit) || 20, 100)
      });
      if (!r.entries.length) return '没有找到日记条目。';
      return `共 ${r.total} 篇，最近 ${r.entries.length} 篇：\n` + r.entries.map(e =>
        `- [${e.day}] ${e.title || '无题'}（${e.words} 字，id: ${e.id}）\n  ${e.excerpt}`
      ).join('\n');
    }
    case 'read_entry': {
      const r = await api('entries.read', { id: args.entry_id });
      return `[${r.day}] ${r.title || '无题'}\n\n${r.text || '（空）'}`;
    }
    case 'search_diary': {
      const r = await api('entries.search', {
        q: args.query || '',
        limit: Math.min(Number(args.limit) || 10, 50)
      });
      if (!r.entries.length) return `没有找到与「${args.query}」相关的日记。`;
      return `找到 ${r.total} 篇：\n` + r.entries.map(e =>
        `- [${e.day}] ${e.title || '无题'}（id: ${e.id}）\n  ${e.excerpt}`
      ).join('\n');
    }
    case 'diary_stats': {
      const r = await api('stats', {});
      return `纸间统计：${r.entries} 篇日记，覆盖 ${r.days} 天，连续记录 ${r.streak} 天，共 ${r.books} 本${r.htmlBooks ? `（含 ${r.htmlBooks} 本网页书）` : ''}。`;
    }
    default:
      throw new Error('未知工具: ' + name);
  }
}

/* ── MCP stdio（JSON-RPC 2.0，换行分帧） ── */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function result(id, r) { send({ jsonrpc: '2.0', id, result: r }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch(e => {
      if (msg && msg.id != null) error(msg.id, -32603, String(e.message || e));
    });
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (id == null) return;   // 通知
  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: params && params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'paper-journal', version: '1.1.0' }
      });
      return;
    case 'tools/list':
      result(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      try {
        const text = await callTool(params.name, params.arguments);
        result(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        result(id, {
          content: [{ type: 'text', text: '调用失败：' + (e.message || e) }],
          isError: true
        });
      }
      return;
    }
    case 'ping':
      result(id, {});
      return;
    default:
      error(id, -32601, '未知方法: ' + method);
  }
}

process.stdin.on('end', () => process.exit(0));
process.stderr.write('[paper-journal MCP] 已启动。纸间需在线（桌面 exe 或 http://localhost:8787）。\n');
