// 本地开发服务器：
//   1. 托管静态页面（index.html + src/）
//   2. /api/claude —— 把浏览器的请求转交给本机已登录的 Claude Code（`claude -p`），
//      这样无需 API Key，直接用你的 Claude 订阅测试。
// 只监听 127.0.0.1；/api 请求必须带自定义请求头 X-Rigger，其他网站无法跨域调用。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5179);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// Windows 命令行上限约 32K 字符，过长的 system prompt 改为放进用户消息
const MAX_SYSTEM_ARG = 20000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// CLI 的 stream-json 输入只接收一条用户消息，这里把多轮历史压平成一条：
// 早期轮次只保留文字，最后一条用户消息保留图片等全部内容块。
function flattenMessages(messages, systemOverflow) {
  const toText = (content) =>
    typeof content === 'string'
      ? content
      : content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1);
  const blocks = [];
  if (systemOverflow) blocks.push({ type: 'text', text: `<system>\n${systemOverflow}\n</system>` });
  if (history.length) {
    const transcript = history
      .map((m) => `[${m.role === 'user' ? '用户' : '助手'}]\n${toText(m.content)}`)
      .join('\n\n');
    blocks.push({ type: 'text', text: `<conversation_history>\n${transcript}\n</conversation_history>` });
  }
  const lastContent = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
  blocks.push(...lastContent);
  return { type: 'user', message: { role: 'user', content: blocks } };
}

async function handleClaude(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
    return;
  }
  const { system = '', messages = [], model = 'claude-opus-5-5', effort = 'high' } = payload;
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'messages 的最后一条必须是 user' }));
    return;
  }

  const overflow = system.length > MAX_SYSTEM_ARG;
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--effort', effort,
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', overflow ? '你是一个严格遵循 <system> 标签内指令的助手。' : system || 'You are a helpful assistant.',
  ];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const child = spawn(CLAUDE_BIN, args, { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let finished = false;
  let stderr = '';
  let buf = '';
  let text = '';

  res.on('close', () => { if (!finished) child.kill(); });

  child.on('error', (e) => {
    finished = true;
    send('error', { message: `无法启动 Claude Code（${CLAUDE_BIN}）：${e.message}。请确认已安装并登录 claude。` });
    res.end();
  });

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
          send('delta', { text: ev.delta.text });
        } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
          send('status', { phase: 'thinking' });
        }
      } else if (msg.type === 'result') {
        finished = true;
        if (msg.is_error) {
          send('error', { message: msg.result || msg.subtype || 'Claude Code 返回错误' });
        } else {
          send('done', {
            text: msg.result ?? text,
            usage: msg.usage,
            cost: msg.total_cost_usd,
            // modelUsage 里可能还有 Claude Code 的辅助小模型调用，取输出最多的那个
            model: Object.entries(msg.modelUsage || {})
              .sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0))[0]?.[0] || model,
          });
        }
        res.end();
      }
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  child.on('close', (code) => {
    if (finished) return;
    finished = true;
    send('error', { message: `Claude Code 退出（code ${code}）${stderr ? '：' + stderr.slice(-800) : ''}` });
    res.end();
  });

  const userMsg = flattenMessages(messages, overflow ? system : '');
  child.stdin.write(JSON.stringify(userMsg) + '\n');
  child.stdin.end();
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || /[\\/]\.|node_modules/.test(path.relative(ROOT, file))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not file');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    // 自定义头会触发 CORS 预检，而这里不响应预检 → 其他源无法调用你的订阅
    if (!req.headers['x-rigger']) { res.writeHead(403); res.end('Forbidden'); return; }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, provider: 'claude-code', bin: CLAUDE_BIN }));
      return;
    }
    if (url.pathname === '/api/claude' && req.method === 'POST') return handleClaude(req, res);
    res.writeHead(404); res.end('Not found');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  return serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI 骨骼绑定器已启动：http://localhost:${PORT}`);
  console.log(`本地订阅模式通过 "${CLAUDE_BIN} -p" 调用 Claude Code（需已登录）。`);
});
