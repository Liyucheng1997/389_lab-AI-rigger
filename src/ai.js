// AI 调用层：两种通道，同一个接口 callClaude()
//   local —— 走本地 server.mjs → Claude Code（你的订阅），仅本机开发时可用
//   api   —— 浏览器直接调用 Anthropic API（用户自己的 API Key），可部署为纯静态网站
import Anthropic from '@anthropic-ai/sdk';

const SETTINGS_KEY = 'rigger.settings.v1';
const APIKEY_KEY = 'rigger.apikey.v1';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（推荐）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（更快）' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1（最强，较贵）' },
];
// 支持 fallbacks: "default" 的模型（安全分类器误拒时由服务端自动换模型续答）
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-5']);

function safeGet(store, key) {
  try { return store.getItem(key); } catch { return null; }
}
function safeSet(store, key, value) {
  try { value == null ? store.removeItem(key) : store.setItem(key, value); } catch { /* 隐私模式等 */ }
}

export const settings = {
  provider: 'local',
  model: 'claude-opus-5-5',
  effort: 'high',
  rememberKey: false,
  apiKey: '',
};

export function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(safeGet(localStorage, SETTINGS_KEY) || '{}'));
  } catch { /* ignore */ }
  settings.apiKey = safeGet(localStorage, APIKEY_KEY) || safeGet(sessionStorage, APIKEY_KEY) || '';
  return settings;
}

export function saveSettings() {
  const { apiKey, ...rest } = settings;
  safeSet(localStorage, SETTINGS_KEY, JSON.stringify(rest));
  // Key 默认只保存在本次会话；勾选“记住”才写入 localStorage
  safeSet(localStorage, APIKEY_KEY, settings.rememberKey && apiKey ? apiKey : null);
  safeSet(sessionStorage, APIKEY_KEY, apiKey || null);
}

let localAvailable = null;
export async function detectLocal() {
  // 本地桥接只会跑在本机；部署到 GitHub Pages 等站点时不去探测，避免控制台 404
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return (localAvailable = false);
  try {
    const r = await fetch('/api/health', { headers: { 'X-Rigger': '1' } });
    localAvailable = r.ok && (await r.json()).ok === true;
  } catch {
    localAvailable = false;
  }
  return localAvailable;
}
export const isLocalAvailable = () => localAvailable;

/**
 * @param {object} p
 * @param {string} p.system
 * @param {Anthropic.MessageParam[]} p.messages
 * @param {(delta: string, full: string) => void} [p.onText]
 * @param {(phase: string) => void} [p.onStatus]
 * @param {AbortSignal} [p.signal]
 * @param {string} [p.effort]
 * @param {number} [p.maxTokens]
 * @returns {Promise<{text: string, info: string}>}
 */
export async function callClaude(p) {
  const provider = settings.provider === 'local' && localAvailable ? 'local' : 'api';
  return provider === 'local' ? callLocal(p) : callApi(p);
}

async function callLocal({ system, messages, onText, onStatus, signal, effort }) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rigger': '1' },
    body: JSON.stringify({ system, messages, model: settings.model, effort: effort || settings.effort }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`本地服务错误 ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /^event: (.*)$/m.exec(raw)?.[1];
      const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
      if (!ev || !dataLine) continue;
      const data = JSON.parse(dataLine);
      if (ev === 'delta') {
        full += data.text;
        onText?.(data.text, full);
      } else if (ev === 'status') {
        onStatus?.(data.phase);
      } else if (ev === 'error') {
        throw new Error(data.message);
      } else if (ev === 'done') {
        const cost = data.cost != null ? ` · 折合 $${data.cost.toFixed(3)}（订阅内）` : '';
        return { text: data.text || full, info: `本地订阅 · ${data.model}${cost}` };
      }
    }
  }
  if (full) return { text: full, info: '本地订阅' };
  throw new Error('本地服务连接中断');
}

async function callApi({ system, messages, onText, onStatus, signal, effort, maxTokens = 64000 }) {
  if (!settings.apiKey) throw new Error('请先在“设置”里填写 Anthropic API Key');
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model: settings.model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: effort || settings.effort },
    // system 固定不变，开启缓存：多轮编排时重复部分按缓存价计费
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (FALLBACK_MODELS.has(settings.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const stream = client.beta.messages.stream(params, { signal });
  let full = '';
  stream.on('streamEvent', (ev) => {
    if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') onStatus?.('thinking');
  });
  stream.on('text', (delta) => {
    full += delta;
    onText?.(delta, full);
  });
  let msg;
  try {
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('API Key 无效（401）');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('API Key 没有权限访问该模型（403）');
    if (e instanceof Anthropic.RateLimitError) throw new Error('触发限流（429），请稍后再试');
    if (e instanceof Anthropic.APIError) throw new Error(`API 错误 ${e.status ?? ''}：${e.message}`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') {
    throw new Error(`模型拒绝了该请求${msg.stop_details?.explanation ? '：' + msg.stop_details.explanation : ''}`);
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const u = msg.usage;
  const cached = u.cache_read_input_tokens ? ` · 缓存命中 ${u.cache_read_input_tokens}` : '';
  const truncated = msg.stop_reason === 'max_tokens' ? ' · ⚠ 输出被截断' : '';
  return { text, info: `API · ${msg.model} · 输入 ${u.input_tokens} / 输出 ${u.output_tokens}${cached}${truncated}` };
}

/** 从回复中取出最后一个 ```json 代码块并解析 */
export function extractJson(text) {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
    try { return JSON.parse(c.replace(/,\s*([}\]])/g, '$1').replace(/\/\/[^\n]*/g, '')); } catch { /* next */ }
  }
  return null;
}

/** 去掉回复里的 JSON 代码块，只保留说明文字 */
export function stripJson(text) {
  return text.replace(/```(?:json)?\s*\n[\s\S]*?(```|$)/g, '').trim();
}
