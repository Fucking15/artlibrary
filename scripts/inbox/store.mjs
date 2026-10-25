/**
 * The inbox: crawled candidates live here until a human or the screener decides.
 *
 * Storage is append-friendly JSON Lines under data/inbox/ (git-ignored — this is working
 * material, not the knowledge base). Nothing in this file may write into data/registry/:
 * admitting a source to the registry stays a deliberate, reviewed act.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const INBOX = path.join(ROOT, 'data', 'inbox');
const CANDIDATES = path.join(INBOX, 'candidates.jsonl');
const TOMBSTONES = path.join(INBOX, 'tombstones.jsonl');
const RUNS = path.join(INBOX, 'runs');

export const STATUSES = ['new', 'awaiting_review', 'approved', 'rejected', 'deleted', 'dropped'];
export const VERDICTS = ['T', 'S', 'F'];
/** 知识库只收能落进六维的技法/学术材料；不进这六个维度的，一律 out_of_scope。 */
export const SCOPE_DIMENSIONS = ['period', 'lineage', 'comparison', 'material', 'composition', 'subject_matter'];
/** A/B are trusted enough to enter the pool on the screener's word; C/D/E need a human. */
export const AUTO_CLASSES = new Set(['A', 'B']);

export function fingerprintOf({ url, adapter, title }) {
  const basis = (url ?? '').trim() || `${adapter ?? ''}|${title ?? ''}`;
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

export function ensureDirs() {
  fs.mkdirSync(RUNS, { recursive: true });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeLines(file, rows) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export const readCandidates = () => readLines(CANDIDATES);
export const readTombstones = () => readLines(TOMBSTONES);

export function writeCandidates(rows) {
  writeLines(CANDIDATES, rows);
}

/**
 * Append new candidates, skipping anything already known by fingerprint — including
 * anything the screener once deleted as F. A deleted lie must not crawl back in next week.
 */
export function addCandidates(items, runId) {
  const rows = readCandidates();
  const known = new Set(rows.map((row) => row.fingerprint));
  const buried = new Set(readTombstones().map((row) => row.fingerprint));
  const added = [];
  const skipped = [];
  for (const item of items) {
    const fingerprint = item.fingerprint ?? fingerprintOf(item);
    if (known.has(fingerprint) || buried.has(fingerprint)) {
      skipped.push({ fingerprint, title: item.title });
      continue;
    }
    known.add(fingerprint);
    added.push({
      id: `cand.${fingerprint}`,
      run_id: runId,
      fingerprint,
      class: item.class,
      kind: item.kind,
      lang: item.lang ?? 'other',
      title: String(item.title ?? '').slice(0, 300),
      excerpt: String(item.excerpt ?? '').slice(0, 900),
      url: item.url ?? '',
      publisher: String(item.publisher ?? '').slice(0, 160),
      authors: item.authors ?? [],
      published: item.published ?? null,
      adapter: item.adapter,
      aggregator: item.aggregator === true,
      query: item.query ?? '',
      retrieved_at: new Date().toISOString(),
      status: 'new',
      verdict: null,
      verdict_at: null,
      verdict_by: null,
      reason_zh: null,
      reviewer: null,
      reviewed_at: null,
      review_note_zh: null,
    });
  }
  writeCandidates([...rows, ...added]);
  return { added, skipped };
}

export function updateCandidate(id, patch) {
  const rows = readCandidates();
  const index = rows.findIndex((row) => row.id === id);
  if (index === -1) return null;
  rows[index] = { ...rows[index], ...patch, updated_at: new Date().toISOString() };
  writeCandidates(rows);
  return rows[index];
}

export function buryCandidate(candidate, { by, reason, kind = 'absurd' }) {
  ensureDirs();
  fs.appendFileSync(
    TOMBSTONES,
    `${JSON.stringify({
      id: candidate.id,
      fingerprint: candidate.fingerprint,
      url: candidate.url,
      title: candidate.title,
      class: candidate.class,
      adapter: candidate.adapter,
      kind: kind === 'out_of_scope' ? 'out_of_scope' : 'absurd',
      deleted_by: by,
      reason_zh: reason,
      deleted_at: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
}

/**
 * Not a lie, just not our subject: biography gossip, auction prices, exhibition openings,
 * same-name collisions. Removed like F (and fingerprinted so it stays out), but counted apart.
 */
export function dropCandidate(candidate, { by, reason }) {
  buryCandidate(candidate, { by, reason, kind: 'out_of_scope' });
}

export function writeRunReport(run) {
  ensureDirs();
  const file = path.join(RUNS, `${run.run_id.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  return file;
}

export function listCandidates({ status, klass, verdict, limit = 500 } = {}) {
  const statuses = Array.isArray(status) ? status : status ? [status] : null;
  return readCandidates()
    .filter((row) => (statuses ? statuses.includes(row.status) : true))
    .filter((row) => (klass ? row.class === klass : true))
    .filter((row) => (verdict ? row.verdict === verdict : true))
    .slice(0, limit);
}

export function inboxStats() {
  const rows = readCandidates();
  const by = (key) =>
    rows.reduce((acc, row) => {
      const value = row[key] ?? 'null';
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {});
  const tombstones = readTombstones();
  return {
    total: rows.length,
    by_status: by('status'),
    by_class: by('class'),
    by_verdict: by('verdict'),
    tombstones: tombstones.length,
    absurd: tombstones.filter((row) => (row.kind ?? 'absurd') !== 'out_of_scope').length,
    out_of_scope: tombstones.filter((row) => row.kind === 'out_of_scope').length,
    last_run: latestRun(),
  };
}

export function latestRun() {
  if (!fs.existsSync(RUNS)) return null;
  const files = fs
    .readdirSync(RUNS)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(RUNS, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS, files[0].name), 'utf8'));
  } catch {
    return null;
  }
}
