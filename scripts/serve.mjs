#!/usr/bin/env node
/**
 * Zero-dependency preview server for site/.  npm run preview
 *
 * Besides the three static files it exposes POST /api/ai, which forwards a chat request to
 * DeepSeek and keeps the key on this side of the browser. Put the key in the environment
 * (preview.cmd reads it from _tools\.deepseek.key); without it the endpoint answers
 * {"ok":false,"error":"no-key"} and the page falls back to asking the reader for a key.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleExamineApi } from './inbox/examine-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.env.PORT ?? 4321);
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MAX_BODY = 512 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

async function handleAi(request, response) {
  const key = process.env.DEEPSEEK_KEY;
  if (!key) {
    sendJson(response, 503, { ok: false, error: 'no-key', hint: 'set DEEPSEEK_KEY before starting the server' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, error: 'bad-json', detail: String(error.message ?? error) });
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    sendJson(response, 400, { ok: false, error: 'no-messages' });
    return;
  }

  try {
    const upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: body.model ?? 'deepseek-chat',
        messages: messages.slice(0, 8),
        temperature: 0.2,
        max_tokens: 900,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      sendJson(response, 502, { ok: false, error: 'upstream', status: upstream.status, detail });
      return;
    }

    const payload = await upstream.json();
    sendJson(response, 200, {
      ok: true,
      content: payload?.choices?.[0]?.message?.content ?? '',
      model: payload?.model ?? 'deepseek-chat',
      usage: payload?.usage ?? null,
    });
  } catch (error) {
    sendJson(response, 502, { ok: false, error: 'fetch-failed', detail: String(error?.message ?? error) });
  }
}

const LANG_NAMES = { zh: '简体中文', en: 'English', de: 'Deutsch', fr: 'français' };

/** 文档页的「AI 翻译」：把当前这一页的中文条目翻成读者选的语言，逐条对应返回。 */
async function handleTranslate(request, response) {
  const key = process.env.DEEPSEEK_KEY;
  if (!key) {
    sendJson(response, 503, { ok: false, error: 'no-key', hint: 'set DEEPSEEK_KEY before starting the server' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, error: 'bad-json', detail: String(error.message ?? error) });
    return;
  }

  const target = LANG_NAMES[body.target] ? body.target : 'en';
  const items = Array.isArray(body.items)
    ? body.items
        .filter((item) => item && typeof item.text === 'string' && item.text.trim())
        .slice(0, 16)
        .map((item) => ({ key: String(item.key).slice(0, 80), text: item.text.slice(0, 600) }))
    : [];
  if (!items.length) {
    sendJson(response, 400, { ok: false, error: 'no-items' });
    return;
  }

  const messages = [
    {
      role: 'system',
      content: `你是艺术史文献的翻译。把每一条 text 忠实翻成${LANG_NAMES[target]}，只翻译，不解释、不增删、不加小标题。
人名、地名、机构名、作品名保留原文，并在译文后用括号给出通行译名（若原文已是该语言则不必）。
只输出 JSON，不要代码块、不要任何前后文字：{"items":[{"key":"原样返回","text":"译文"}]}`,
    },
    { role: 'user', content: JSON.stringify({ target: LANG_NAMES[target], items }) },
  ];

  const call = async (model, maxTokens) => {
    const upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}: ${(await upstream.text()).slice(0, 200)}`);
    const payload = await upstream.json();
    return { content: payload?.choices?.[0]?.message?.content ?? '', model: payload?.model ?? model };
  };

  try {
    let result;
    try {
      result = await call(body.model ?? 'deepseek-chat', 2400);
    } catch (error) {
      result = await call(body.model ?? 'deepseek-chat', 2400); // 一次重试：网络抖动比模型错更常见
    }
    const cleaned = result.content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      sendJson(response, 502, { ok: false, error: 'bad-model-json', detail: cleaned.slice(0, 200) });
      return;
    }
    const out = Array.isArray(parsed?.items)
      ? parsed.items
          .filter((item) => item && typeof item.key === 'string' && typeof item.text === 'string')
          .map((item) => ({ key: item.key, text: item.text }))
      : [];
    if (!out.length) {
      sendJson(response, 502, { ok: false, error: 'bad-model-json', detail: cleaned.slice(0, 200) });
      return;
    }
    sendJson(response, 200, { ok: true, target, model: result.model, items: out });
  } catch (error) {
    sendJson(response, 502, { ok: false, error: 'fetch-failed', detail: String(error?.message ?? error) });
  }
}

http
  .createServer((request, response) => {
    const url = decodeURIComponent((request.url ?? '/').split('?')[0]);

    if (url === '/api/ai') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      handleAi(request, response);
      return;
    }

    if (url === '/api/translate') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      handleTranslate(request, response);
      return;
    }

    if (url.startsWith('/api/examine/')) {
      handleExamineApi(request, response, url);
      return;
    }

    const target = path.join(ROOT, url === '/' ? 'index.html' : url === '/examine' ? 'examine.html' : url);
    if (!target.startsWith(ROOT)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(target, (error, body) => {
      if (error) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      response.writeHead(200, { 'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream' }).end(body);
    });
  })
  .listen(PORT, () => {
    const key = process.env.DEEPSEEK_KEY ? '已配置' : '未配置（页面会要求读者自己填）';
    console.log(`http://localhost:${PORT}   DeepSeek key: ${key}`);
  });
