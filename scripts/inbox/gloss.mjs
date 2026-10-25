/**
 * 一键「译 · 摘」：把一条候选材料译成中文，并且只总结与埃贡·席勒有关的部分。
 *
 * 为什么单独成文件：这是 /examine 里唯一一处「读原文并写中文」的调用，规则比接口本身重要——
 * 翻译要忠实、总结只留席勒、与席勒无关就明说、不许补材料里没有的页码与引文。
 * 结果缓存回候选条目（gloss 字段），同一张卡不重复花钱。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, updateCandidate } from './store.mjs';
import { clip, fetchText, pageText } from './net.mjs';

const REPO = path.resolve(ROOT);
const KEY_FILE = path.join(REPO, '..', '_tools', '.deepseek.key');
const ENDPOINT = process.env.DEEPSEEK_URL ?? 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.TK_GLOSS_MODEL ?? 'deepseek-flash';
const MAX_BODY = 1600;
const MAX_TOKENS = 2400;

function apiKey() {
  if (process.env.DEEPSEEK_KEY) return process.env.DEEPSEEK_KEY.trim();
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  return '';
}

const SYSTEM = `你是《技法图谱》的编辑助理，读者是研究埃贡·席勒（Egon Schiele, 1890–1918）绘画技法与史料的中文编辑。

任务：1) 把这条材料译成中文；2) 只总结与席勒有关的部分。

规则：
- 译文只译材料开头（至多 4 段、合计约 800 字），末尾用「……」表示后面省略；**不要为了译完整篇而删减摘要**。
- 译文忠实，专有名词保留原文，首次出现写成「中文（原文）」；不要润色成通稿。
- 摘要只写与席勒本人、其作品、技法、材料、生平、展览、接受史有关的内容。与席勒无关的人物、机构八卦、无关话题，一律不写。
- 若整条材料与席勒无关（最常见的是同名撞车：另一位同名者、同名的月季品种、同名的程序库或用户名），
  把 relevant 设为 false，并在 summary_zh 里用一句话说清它到底是什么、是怎么被误抓进来的。
- 不许编造材料里没有的事实、页码、图版号或引文。材料只够说一半，就写「材料只提到……，不足以判断……」。
- key_facts 至多 4 条，每条不超过 40 字，只放能在材料里指认的事实；caveat_zh 写需要人工核对的点，没有就留空。
- 全部用中文，不要 markdown 标题。

只输出 JSON，不要代码块：
{"title_zh":"","translation_zh":"","summary_zh":"","relevant":true,"key_facts":[],"caveat_zh":""}`;

function userPrompt(row, text, source) {
  return `条目
class: ${row.class}  kind: ${row.kind}  lang: ${row.lang}
标题: ${row.title}
出版方: ${row.publisher || '(未知)'}  年份: ${row.published ?? '(未知)'}
URL: ${row.url || '(无)'}
原文来源: ${source === 'page' ? '已抓到网页正文（节选）' : '只有数据库摘要，未抓到正文'}

材料正文：
"""
${text}
"""`;
}

function parseJson(raw) {
  const cleaned = String(raw ?? '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('bad-model-json');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function ask(key, messages, maxTokens = MAX_TOKENS) {
  const send = async (withJsonMode) => {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    return res;
  };

  let res = await send(true);
  if (res.status === 400) res = await send(false); // 有的兼容端点不认 response_format
  const text = await res.text();
  if (!res.ok) throw new Error(`upstream-${res.status}: ${text.slice(0, 200)}`);
  const payload = JSON.parse(text);
  const choice = payload.choices?.[0] ?? {};
  return {
    content: String(choice.message?.content ?? ''),
    finish: String(choice.finish_reason ?? ''),
  };
}

async function collect(row) {
  if (row.aggregator) return { source: 'excerpt', text: clip(row.excerpt, MAX_BODY) };
  if (!row.url) return { source: 'excerpt', text: clip(row.excerpt, MAX_BODY) };
  const res = await fetchText(row.url, { timeout: 15_000, retries: 0 });
  if (!res.ok) return { source: 'excerpt', text: clip(row.excerpt, MAX_BODY) };
  if (!/text\/html|text\/plain|application\/xhtml|application\/xml/i.test(res.contentType ?? '')) {
    return { source: 'excerpt', text: clip(row.excerpt, MAX_BODY) };
  }
  const body = clip(pageText(res.text, row.title), MAX_BODY);
  if (body.length < 200) return { source: 'excerpt', text: clip(row.excerpt, MAX_BODY) };
  // 标题是正文的位置坐标：藏品页/文章页标题出现在哪，正文就从哪开始（前面那截是营业时间、菜单之类）。
  const focus = String(row.title ?? '').split(/[—|｜·]/)[0].trim().slice(0, 40);
  let text = body;
  if (focus.length >= 12) {
    const at = body.toLowerCase().indexOf(focus.toLowerCase());
    if (at > 80) text = body.slice(at);
  }
  return { source: 'page', text: clip(text, MAX_BODY) };
}

/**
 * @returns {Promise<{ok: true, gloss: object, cached: boolean}>}
 */
export async function glossCandidate(row, { force = false } = {}) {
  if (!force && row.gloss && row.gloss.summary_zh) {
    return { ok: true, gloss: row.gloss, cached: true };
  }

  const key = apiKey();
  if (!key) {
    const error = new Error('no-key');
    error.code = 'no-key';
    throw error;
  }

  const { source, text } = await collect(row);
  if (!text || text.length < 40) {
    const error = new Error('not-enough-text');
    error.code = 'not-enough-text';
    throw error;
  }

  const build = (text) => [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt(row, text, source) },
  ];

  // 长外文页会被 max_tokens 截断：截断时 JSON 的尾巴没了（甚至 content 直接是空字符串），
  // 报出来就是 bad-model-json，人会误以为是模型不会写 JSON。所以按长度阶梯重试，
  // 取第一个能解析出 JSON 的结果；全失败才算真失败。
  const ladder = [text.slice(0, 1200), text.slice(0, 700), text.slice(0, 420)];
  let parsed = null;
  let lastRaw = '';
  let tried = 0;
  for (const candidate of ladder) {
    if (!candidate || candidate.length < 40) continue;
    if (tried > 0 && candidate === ladder[tried - 1]) continue;
    tried += 1;
    const answer = await ask(key, build(candidate), MAX_TOKENS);
    lastRaw = answer.content;
    try {
      parsed = parseJson(answer.content);
      break;
    } catch {
      // 截断了就再短一点重来
    }
  }

  if (!parsed) {
    const error = new Error(tried > 1 ? 'too-long' : 'bad-model-json');
    error.code = tried > 1 ? 'too-long' : 'bad-model-json';
    error.raw = lastRaw.slice(0, 400);
    throw error;
  }

  const facts = Array.isArray(parsed.key_facts)
    ? parsed.key_facts.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 4)
    : [];

  const gloss = {
    title_zh: String(parsed.title_zh ?? '').trim(),
    translation_zh: String(parsed.translation_zh ?? '').trim(),
    summary_zh: String(parsed.summary_zh ?? '').trim(),
    relevant: parsed.relevant !== false,
    key_facts: facts,
    caveat_zh: String(parsed.caveat_zh ?? '').trim(),
    model: MODEL,
    source,
    at: new Date().toISOString(),
  };

  if (!gloss.summary_zh) {
    const error = new Error('empty-summary');
    error.code = 'empty-summary';
    throw error;
  }

  updateCandidate(row.id, { gloss });
  return { ok: true, gloss, cached: false };
}
