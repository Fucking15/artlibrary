#!/usr/bin/env node
/**
 * AI screening in PTC mode (prompt → tool call → result → next prompt).
 *
 * Two questions, in this order — scope first, reliability second:
 *
 *   1. 范围：这条材料能不能支撑「时期 / 师从与影响 / 对比与创新 / 材料 / 画面构成 / 题材」
 *      六个维度之一的技法判断？不能 → drop（直接筛掉，不进库、不占人工）。
 *   2. 可靠性：留下的再判 T / S / F。F 是"荒诞不可信"，drop 是"不是我们的题"，
 *      两者都从 inbox 移除并写指纹，但分别记账。
 *
 *   T  reliable    — checkable, specific, consistent with the knowledge base
 *   S  unverified  — plausible but nothing pins it down yet
 *   F  absurd      — fabricated, sensational, self-contradictory, or AI slop; deleted on the spot
 *   drop           — out of scope: 生平八卦、拍卖价、展览开幕、文创、同名撞车、纯书目信息
 *
 *   node scripts/inbox/screen.mjs                 # screen everything still "new"
 *   node scripts/inbox/screen.mjs --limit 10      # cap this run
 *   node scripts/inbox/screen.mjs --rescreen      # 用新口径重过「待审」队列（含已判过的）
 *   node scripts/inbox/screen.mjs --dry           # decide, report, change nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  AUTO_CLASSES,
  ROOT,
  SCOPE_DIMENSIONS,
  addCandidates,
  buryCandidate,
  dropCandidate,
  listCandidates,
  readCandidates,
  updateCandidate,
  VERDICTS,
} from './store.mjs';
import { clip, fetchText, pageText } from './net.mjs';

const ARGS = process.argv.slice(2);
const LIMIT = Number(ARGS[ARGS.indexOf('--limit') + 1]) || 12;
const DRY = ARGS.includes('--dry');
const TRACE = ARGS.includes('--trace');
const RESCREEN = ARGS.includes('--rescreen');
const ALL = ARGS.includes('--all');

const MODEL = process.env.TK_SCREEN_MODEL ?? 'deepseek-flash';
const API = process.env.DEEPSEEK_URL ?? 'https://api.deepseek.com/chat/completions';

function readKey() {
  if (process.env.DEEPSEEK_KEY) return process.env.DEEPSEEK_KEY.trim();
  const file = path.join(ROOT, '..', '_tools', '.deepseek.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return '';
}

const KB = (() => {
  const file = path.join(ROOT, 'site', 'data', 'index.json');
  if (!fs.existsSync(file)) return { dossiers: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { dossiers: [] };
  }
})();

const KB_CLAIMS = (KB.dossiers ?? []).flatMap((dossier) =>
  Object.entries(dossier.dimensions ?? {}).flatMap(([dim, value]) =>
    (value.claims ?? []).map((claim) => ({
      dim,
      statement: claim.statement_zh ?? claim.reason_zh ?? '',
      medium: claim.medium ?? [],
      notApplicable: claim.not_applicable === true,
    })),
  ),
);

/* ------------------------------------------------------------------ tools */

const state = { read: new Set(), classified: new Map(), rounds: 0, calls: 0 };

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_candidate',
      description: 'Read one candidate in full (title, excerpt, url, publisher, class). Call this before classifying it.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'candidate id, e.g. cand.1f2e3d4c5b6a' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_kb',
      description: 'Search the existing knowledge base (Schiele, 1911–1914, 6 dimensions) for statements related to a topic. Use it to check whether a candidate contradicts or duplicates what is already recorded.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Chinese or English keywords' },
          limit: { type: 'integer', description: 'max results, default 6' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description: 'Download the candidate URL and return the first ~3000 characters of readable text. Use it when the excerpt alone is ambiguous, or when you suspect the page does not actually contain what the snippet says.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'classify',
      description:
        'Verdict for one IN-SCOPE candidate (it can support a technique claim under one of the six dimensions). Must be called exactly once per candidate, after read_candidate. F is destructive: the candidate is deleted and never re-admitted.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['T', 'S', 'F'] },
          dimensions: {
            type: 'array',
            items: { type: 'string', enum: ['period', 'lineage', 'comparison', 'material', 'composition', 'subject_matter'] },
            description: 'Which of the six dimensions this material can support (at least one).',
          },
          reason_zh: {
            type: 'string',
            description: 'One or two sentences in Chinese: which dimension it serves and what makes it T/S/F. For F, name the specific flaw.',
          },
        },
        required: ['id', 'verdict', 'dimensions', 'reason_zh'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drop',
      description:
        'Out of scope: the material cannot support any technique claim under the six dimensions (biography gossip, auction prices, exhibition openings, merchandise, same-name collision, bare bibliographic record). Removed and never re-admitted. Most candidates should end here.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason_zh: { type: 'string', description: '一句中文说清为什么与技法/六维无关（至少 12 字）。' },
        },
        required: ['id', 'reason_zh'],
      },
    },
  },
];

function scoreClaim(query, statement) {
  const q = query.toLowerCase();
  const hay = statement.toLowerCase();
  let score = 0;
  for (const token of q.split(/[\s,，、]+/).filter(Boolean)) {
    if (token.length >= 2 && hay.includes(token)) score += 3;
  }
  // crude Chinese bigram overlap — enough to surface the right dimension
  const cjk = q.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < cjk.length; i += 1) {
    if (hay.includes(cjk.slice(i, i + 2))) score += 1;
  }
  return score;
}

async function runTool(name, args) {
  state.calls += 1;
  if (name === 'read_candidate') {
    const row = readCandidates().find((item) => item.id === args.id);
    if (!row) return { error: `unknown candidate ${args.id}` };
    state.read.add(row.id);
    return {
      id: row.id,
      class: row.class,
      kind: row.kind,
      lang: row.lang,
      title: row.title,
      excerpt: row.excerpt,
      url: row.url,
      publisher: row.publisher,
      aggregator: row.aggregator === true,
      authors: row.authors,
      published: row.published,
      adapter: row.adapter,
    };
  }

  if (name === 'search_kb') {
    const limit = Math.min(Number(args.limit) || 6, 12);
    const hits = KB_CLAIMS.map((claim) => ({ ...claim, score: scoreClaim(String(args.query ?? ''), claim.statement) }))
      .filter((claim) => claim.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((claim) => ({ dim: claim.dim, medium: claim.medium, statement: clip(claim.statement, 180) }));
    return { query: args.query, results: hits, note: hits.length ? undefined : '没有相关条目' };
  }

  if (name === 'fetch_page') {
    const target = String(args.url ?? '');
    const known = readCandidates().find((row) => row.url === target);
    if (known?.aggregator || /news\.google\.com\/rss\/articles/.test(target)) {
      return {
        error: 'aggregator_link',
        hint: '这是 Google News 聚合跳转链接，抓不到正文。请按标题与 RSS 摘要判断；拿不准给 S，不要因为读不到正文就判 F。',
      };
    }
    const res = await fetchText(target, { timeout: 15_000 });
    if (!res.ok) return { error: res.error, url: args.url };
    return { url: args.url, contentType: res.contentType, text: clip(pageText(res.text, known?.title ?? ''), 3000) };
  }

  if (name === 'classify') {
    const id = String(args.id ?? '');
    const verdict = String(args.verdict ?? '').toUpperCase();
    if (!state.read.has(id)) return { error: `read_candidate(${id}) must be called first` };
    if (!VERDICTS.includes(verdict)) return { error: `bad verdict ${verdict}` };
    const dims = Array.isArray(args.dimensions) ? args.dimensions.filter((dim) => SCOPE_DIMENSIONS.includes(dim)) : [];
    if (!dims.length) return { error: 'classify 至少要给一个 dimensions（period/lineage/comparison/material/composition/subject_matter）；六维都套不上就该用 drop' };
    if (verdict === 'F' && String(args.reason_zh ?? '').trim().length < 20) {
      return { error: 'an F verdict needs a concrete reason (至少 20 字)，写清楚它错在哪' };
    }
    if (state.classified.has(id)) return { error: `${id} already classified` };
    state.classified.set(id, { verdict, dimensions: [...new Set(dims)], reason_zh: String(args.reason_zh ?? '').trim() });
    return { ok: true, id, verdict, dimensions: dims };
  }

  if (name === 'drop') {
    const id = String(args.id ?? '');
    const reason = String(args.reason_zh ?? '').trim();
    if (!state.read.has(id)) return { error: `read_candidate(${id}) must be called first` };
    if (reason.length < 12) return { error: 'drop 要写清原因（至少 12 字）' };
    if (state.classified.has(id)) return { error: `${id} already judged` };
    state.classified.set(id, { drop: true, reason_zh: reason });
    return { ok: true, id, dropped: true };
  }

  return { error: `unknown tool ${name}` };
}

/* -------------------------------------------------------------- prompting */

const SYSTEM = `你是「技法图谱」的入库过滤员。这个库只收一类材料：**能支撑埃贡·席勒（Egon Schiele, 1890–1918）绘画技法与创作条件的、学术性且可核对**的判断，而且必须能落进六个维度之一：

- 时期 period（分期、风格演变的时间锚点）
- 师从与影响 lineage（他跟谁学、受谁影响、影响了谁）
- 对比与创新 comparison（与同代人或前人的具体差异）
- 材料 material（颜料、纸、笔、底子、尺寸、工具）
- 画面构成 composition（构图、线条、形体、空间、色彩处理）
- 题材 subject_matter（画什么、为什么画、母题来源）

## 第一步：范围（先做这一步，大多数材料到这里就该结束）

判 drop 的典型：生平八卦与情史、心理疾病轶事、拍卖成交价与市场行情、展览开幕与票务新闻、博物馆失窃/诉讼/归还争议、文创与周边、音乐剧与影视、同名撞车（同名的人、花、程序库）、只有书名与出版信息的纯书目条目、纯图像转载没有技术描述。

例外要看清：馆藏对象页或者作品全集条目，即使只有几行字，只要给出年代、尺寸、材料、题记这类可核对的技术信息，就算 material 维度，留下。

## 第二步：可靠性（只对留下的材料判）

T 可靠：具体、可核对（有明确出处、对象页或页码），与库里已有条目不冲突。
S 未证实：听起来可能但缺少可核对的位置（没有页码、没有对象页、只有转述），或与库内条目无法互相印证。
F 荒诞不可信：编造的名言/画作/展览、明显的 AI 生成垃圾、营销软文、阴谋论、自相矛盾、把席勒和无关人物硬凑的故事、色情或猎奇标题党。F 会被直接删除且不再回收，判 F 必须写清楚具体破绽。

## 工作方式

1. 先用 read_candidate 读，不要凭标题下判断。
2. 判断范围：套不上六维 → 立刻 drop，不要 classify，也不要客气地给 S。
3. 留下的，涉及技法或史实的用 search_kb 看库里怎么说，冲突就降级或判 F。
4. 摘要含糊、像标题党、或你怀疑页面根本没有这段内容的，用 fetch_page 打开看。
5. classify 必须带 dimensions（至少一个），reason_zh 说清它服务哪一维、依据是什么。
6. 每条只能被 drop 或 classify 一次。不确定可靠性时给 S，但不确定范围时按"不相关"处理——宁可漏收，不要污染技法库。
7. 标了 aggregator: true 的条目是 Google News 聚合链接，fetch_page 抓不到正文——按标题与摘要判断，别反复抓；只有标题、没有任何技法信息的，直接 drop。`;

function userPrompt(batch) {
  const rows = batch.map(
    (row) =>
      `- id=${row.id} class=${row.class} kind=${row.kind} lang=${row.lang}${row.aggregator ? ' aggregator=true' : ''}\n  title: ${row.title}\n  url: ${row.url || '(none)'}\n  publisher: ${row.publisher || '(none)'}  year: ${row.published ?? '?'}\n  excerpt: ${clip(row.excerpt, 260)}`,
  );
  return `本轮 ${batch.length} 条候选：\n\n${rows.join('\n')}\n\n逐条 read_candidate → （必要时 search_kb / fetch_page）→ 不相干的 drop，相干的 classify。全部判完后回复一句总结。`;
}

async function callModel(messages, key) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.1,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`model ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/* ------------------------------------------------------------------ main */

async function main() {
  // 按类别轮流取：A/B 走自动通道，C/D/E 才是人工要看的，别让前者把额度吃光。
  const statuses = ALL
    ? ['new', 'awaiting_review', 'approved']
    : RESCREEN
      ? ['new', 'awaiting_review']
      : ['new'];
  const pool = listCandidates({ status: statuses });
  if (RESCREEN) console.log(`重新过筛：${pool.length} 条（含已判待审）按新口径重判。`);
  const byClass = new Map();
  for (const row of pool) {
    if (!byClass.has(row.class)) byClass.set(row.class, []);
    byClass.get(row.class).push(row);
  }
  const order = ['C', 'D', 'E', 'A', 'B'];
  const pending = [];
  while (pending.length < LIMIT) {
    let took = false;
    for (const klass of order) {
      const bucket = byClass.get(klass);
      if (bucket?.length) {
        pending.push(bucket.shift());
        took = true;
        if (pending.length >= LIMIT) break;
      }
    }
    if (!took) break;
  }
  if (!pending.length) {
    console.log('inbox 里没有待审候选。先跑 node scripts/inbox/weekly.mjs');
    return;
  }
  const key = readKey();
  if (!key) {
    console.error('缺少 DEEPSEEK_KEY（或 _tools/.deepseek.key），无法做 AI 初筛。');
    process.exit(2);
  }

  const batchSize = 6;
  let approved = 0;
  let queued = 0;
  let deleted = 0;
  let dropped = 0;

  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize);
    state.read.clear();
    state.classified.clear();

    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt(batch) },
    ];
    let nudges = 0;

    for (let round = 0; round < 14; round += 1) {
      state.rounds += 1;
      const payload = await callModel(messages, key);
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error('模型没有返回 message');
      messages.push(message);

      const calls = message.tool_calls ?? [];
      if (TRACE) {
        const names = calls.map((call) => `${call.function?.name}(${clip(call.function?.arguments ?? '', 60)})`);
        console.error(`  trace: round ${round + 1} → ${names.length ? names.join(', ') : 'no tool calls'} | classified ${state.classified.size}/${batch.length}`);
      }
      if (!calls.length) {
        // The model likes to wrap up with prose while candidates are still unjudged; ask again
        // instead of leaving the batch half-done.
        const missing = batch.map((row) => row.id).filter((id) => !state.classified.has(id));
        if (!missing.length || nudges >= 3) break;
        nudges += 1;
        if (TRACE) console.error(`  trace: nudge ${nudges} → ${missing.join(', ')}`);
        messages.push({
          role: 'user',
          content: `还有 ${missing.length} 条没有判断：${missing.join('、')}。请立刻对它们逐个处理——范围外的调 drop，范围内的调 classify，不要输出其他文字。`,
        });
        continue;
      }

      for (const call of calls) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments ?? '{}');
        } catch {
          args = {};
        }
        const result = await runTool(call.function?.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }

      if (state.classified.size >= batch.length) break;
    }

    for (const row of batch) {
      const verdict = state.classified.get(row.id);
      if (!verdict) {
        console.log(`  … ${row.id} 未判定，留待下轮`);
        continue;
      }
      if (DRY) {
        console.log(
          `  [dry] ${row.id} ${verdict.drop ? 'drop' : verdict.verdict} ${clip(verdict.reason_zh, 90)}`,
        );
        if (verdict.drop) dropped += 1;
        else if (verdict.verdict === 'F') deleted += 1;
        else if (AUTO_CLASSES.has(row.class)) approved += 1;
        else queued += 1;
        continue;
      }
      if (verdict.drop) {
        dropCandidate(row, { by: `ai:${MODEL}`, reason: verdict.reason_zh });
        updateCandidate(row.id, {
          status: 'dropped',
          verdict: null,
          verdict_at: new Date().toISOString(),
          verdict_by: `ai:${MODEL}`,
          reason_zh: verdict.reason_zh,
        });
        dropped += 1;
        continue;
      }
      if (verdict.verdict === 'F') {
        buryCandidate(row, { by: `ai:${MODEL}`, reason: verdict.reason_zh });
        updateCandidate(row.id, {
          status: 'deleted',
          verdict: 'F',
          verdict_at: new Date().toISOString(),
          verdict_by: `ai:${MODEL}`,
          reason_zh: verdict.reason_zh,
        });
        deleted += 1;
        continue;
      }
      const auto = AUTO_CLASSES.has(row.class);
      updateCandidate(row.id, {
        status: auto ? 'approved' : 'awaiting_review',
        verdict: verdict.verdict,
        dimensions: verdict.dimensions ?? [],
        verdict_at: new Date().toISOString(),
        verdict_by: `ai:${MODEL}`,
        reason_zh: verdict.reason_zh,
      });
      if (auto) approved += 1;
      else queued += 1;
    }
  }

  console.log('');
  console.log(
    `初筛完成：${approved} 条 A/B 自动入库 · ${queued} 条等待人工审核（C/D/E） · ${deleted} 条判 F 已删除 · ${dropped} 条与技法/学术无关已筛除 · 工具调用 ${state.calls} 次`,
  );
  if (!DRY && queued > 0) console.log('打开 http://localhost:4321/examine 审核。');
}

main().catch((error) => {
  console.error('screening failed:', error?.message ?? error);
  process.exit(1);
});
