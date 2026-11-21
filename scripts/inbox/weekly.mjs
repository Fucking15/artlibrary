#!/usr/bin/env node
/**
 * weekly.mjs — 每周一次的全网检索（席勒）。
 *
 *   node scripts/inbox/weekly.mjs                # 正式跑，写 data/inbox
 *   node scripts/inbox/weekly.mjs --dry          # 只看能收到什么，不落盘
 *   node scripts/inbox/weekly.mjs --class=E      # 只跑某一类
 *   node scripts/inbox/weekly.mjs --only=hn,crossref
 *   node scripts/inbox/weekly.mjs --limit=3      # 每源每条查询的上限
 *
 * 收进来的东西一律是候选，不是证据：AI 初筛（screen.mjs）判 T/S/F，C/D/E 还要人审。
 */
import { ADAPTERS, QUERIES } from './adapters.mjs';
import { addCandidates, inboxStats, writeRunReport } from './store.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const dry = flag('dry');
const limit = Number(value('limit', '4')) || 4;
const only = String(value('only', ''))
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const klass = String(value('class', '')).trim().toUpperCase();

const picked = ADAPTERS.filter((adapter) => {
  if (klass && adapter.class !== klass) return false;
  if (only.length && !only.includes(adapter.id)) return false;
  return true;
});

if (!picked.length) {
  console.error(`没有匹配的适配器（class=${klass || '*'} only=${only.join(',') || '*'}）`);
  process.exit(2);
}

const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const collected = [];
const adapters = [];

console.log(`\n席勒周检 · ${runId}${dry ? ' · 演练（不落盘）' : ''}\n`);
console.log(`源 ${picked.length} 个，每次查询上限 ${limit} 条，中英各 ${QUERIES.en.length}/${QUERIES.zh.length} 条查询\n`);

for (const adapter of picked) {
  const queries = adapter.terms ?? QUERIES[adapter.lang] ?? QUERIES.en;
  const record = { id: adapter.id, class: adapter.class, ok: true, queries: 0, fetched: 0, error: null, note: null };
  const started = Date.now();

  for (const query of queries) {
    record.queries += 1;
    let result;
    try {
      // 单个源最多给 45 秒，挂死就跳过，别拖垮整轮。
      result = await Promise.race([
        adapter.run(query, limit),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'adapter timeout', items: [] }), 45_000)),
      ]);
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error), items: [] };
    }
    if (!result.ok) {
      record.ok = false;
      record.error = result.error;
      continue;
    }
    if (result.note) record.note = result.note;
    for (const entry of result.items ?? []) {
      if (!entry.title || !entry.url) continue;
      collected.push({ ...entry, run_id: runId });
      record.fetched += 1;
    }
    // 轻一点：每个源每条查询之间停一下，别把人家打疼。
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  record.ms = Date.now() - started;
  adapters.push(record);
  const mark = record.ok ? '✓' : '✗';
  const note = record.ok ? (record.note ? ` (${record.note})` : '') : ` (${record.error})`;
  console.log(`${mark} ${adapter.id.padEnd(16)} ${adapter.class}  ${String(record.fetched).padStart(3)} 条  ${record.ms}ms${note}`);
}

let added = [];
let skippedCount = 0;
if (!dry) {
  const result = addCandidates(collected, runId);
  added = result.added;
  skippedCount = result.skipped.length;
  writeRunReport({ run_id: runId, at: new Date().toISOString(), adapters, fetched: collected.length, added: added.length, skipped: skippedCount });
}

const stats = inboxStats();
const byClass = {};
for (const entry of collected) byClass[entry.class] = (byClass[entry.class] ?? 0) + 1;

console.log(`\n收到 ${collected.length} 条 · 新增 ${dry ? '(演练未写)' : added.length} 条 · 重复跳过 ${dry ? '-' : skippedCount} 条`);
console.log(`分类：${Object.entries(byClass).map(([key, count]) => `${key} ${count}`).join(' · ') || '无'}`);
console.log(`库内现状：待初筛 ${stats.by_status?.new ?? 0} · 待审 ${stats.by_status?.awaiting_review ?? 0} · 已入库 ${stats.by_status?.approved ?? 0} · 已删 ${stats.tombstones ?? 0}`);

if (!dry) {
  console.log(`\n下一步：node scripts/inbox/screen.mjs    （AI 初筛，F 自动删除）`);
  console.log(`然后： http://localhost:4321/examine    （人审 C/D/E）\n`);
}
