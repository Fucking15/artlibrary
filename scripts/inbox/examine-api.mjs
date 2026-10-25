/**
 * HTTP surface of the /examine console.
 *
 *   GET  /api/examine/state       queue + counts + last crawl report
 *   POST /api/examine/decision    { id, decision: approve|reject|delete, tag?, note? }
 *   POST /api/examine/gloss       { id, force? } → 译成中文 + 只总结与席勒有关的部分（结果缓存在条目上）
 *   POST /api/examine/screen      run the AI screener once and return its log tail
 *
 * Auth: if EXAMINE_TOKEN is set (or _tools/.examine.token exists), every call must send
 * `x-examine-token`. Without a configured token the endpoints only answer loopback requests —
 * the console is a local editorial tool, not a public admin panel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, buryCandidate, inboxStats, latestRun, listCandidates, readCandidates, updateCandidate } from './store.mjs';
import { glossCandidate } from './gloss.mjs';

const REPO = path.resolve(ROOT);
const TOKEN_FILE = path.join(REPO, '..', '_tools', '.examine.token');

function configuredToken() {
  if (process.env.EXAMINE_TOKEN) return process.env.EXAMINE_TOKEN.trim();
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  return '';
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
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

function authorize(request) {
  const expected = configuredToken();
  if (expected) {
    const given = String(request.headers['x-examine-token'] ?? '');
    return given && given === expected ? { ok: true } : { ok: false, error: 'bad-token' };
  }
  if (!isLoopback(request)) return { ok: false, error: 'loopback-only' };
  return { ok: true };
}

let screening = null;

function runScreener() {
  if (screening) return screening;
  screening = new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'scripts', 'inbox', 'screen.mjs'), '--limit', '24'], {
      cwd: REPO,
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('close', (code) => {
      screening = null;
      resolve({ code, output: out.slice(-4000) });
    });
    child.on('error', (error) => {
      screening = null;
      resolve({ code: -1, output: String(error?.message ?? error) });
    });
  });
  return screening;
}

export async function handleExamineApi(request, response, url) {
  const auth = authorize(request);
  if (!auth.ok) {
    sendJson(response, 401, { ok: false, error: auth.error });
    return true;
  }

  if (url === '/api/examine/state' && request.method === 'GET') {
    const queue = listCandidates({ status: 'awaiting_review' });
    const recent = readCandidates()
      .filter((row) => row.status === 'approved' && row.verdict)
      .sort((a, b) => String(b.verdict_at ?? '').localeCompare(String(a.verdict_at ?? '')))
      .slice(0, 30);
    // 筛除的东西不参与审核，但要能翻账：人得看得见 AI 把什么扔掉了。
    const dropped = readCandidates()
      .filter((row) => row.status === 'dropped')
      .sort((a, b) => String(b.verdict_at ?? '').localeCompare(String(a.verdict_at ?? '')))
      .slice(0, 30);
    sendJson(response, 200, {
      ok: true,
      auth: configuredToken() ? 'token' : 'loopback',
      stats: inboxStats(),
      queue,
      recent,
      dropped,
      last_run: latestRun(),
      screening: screening ? 'running' : 'idle',
    });
    return true;
  }

  if (url === '/api/examine/decision' && request.method === 'POST') {
    let body;
    try {
      body = await readBody(request);
    } catch {
      sendJson(response, 400, { ok: false, error: 'bad-json' });
      return true;
    }
    const id = String(body.id ?? '');
    const decision = String(body.decision ?? '');
    const row = readCandidates().find((item) => item.id === id);
    if (!row) {
      sendJson(response, 404, { ok: false, error: 'unknown-id' });
      return true;
    }
    const tag = ['T', 'S', 'F'].includes(String(body.tag ?? '').toUpperCase()) ? String(body.tag).toUpperCase() : null;
    const note = String(body.note ?? '').slice(0, 600);
    const reviewer = String(body.reviewer ?? 'local-editor').slice(0, 80);
    const stamp = new Date().toISOString();

    if (decision === 'approve') {
      updateCandidate(id, {
        status: 'approved',
        verdict: tag ?? row.verdict ?? 'S',
        verdict_by: `human:${reviewer}`,
        verdict_at: stamp,
        reviewer,
        reviewed_at: stamp,
        review_note_zh: note,
      });
      sendJson(response, 200, { ok: true, id, status: 'approved' });
      return true;
    }

    if (decision === 'reject') {
      updateCandidate(id, {
        status: 'rejected',
        reviewer,
        reviewed_at: stamp,
        review_note_zh: note,
        verdict: tag ?? row.verdict,
      });
      sendJson(response, 200, { ok: true, id, status: 'rejected' });
      return true;
    }

    if (decision === 'delete') {
      buryCandidate(row, { by: `human:${reviewer}`, reason: note || '人工判定为荒诞不可信' });
      updateCandidate(id, {
        status: 'deleted',
        verdict: 'F',
        verdict_by: `human:${reviewer}`,
        verdict_at: stamp,
        reviewer,
        reviewed_at: stamp,
        review_note_zh: note || '人工判定为荒诞不可信',
      });
      sendJson(response, 200, { ok: true, id, status: 'deleted' });
      return true;
    }

    sendJson(response, 400, { ok: false, error: 'unknown-decision' });
    return true;
  }

  if (url === '/api/examine/gloss' && request.method === 'POST') {
    let body;
    try {
      body = await readBody(request);
    } catch {
      sendJson(response, 400, { ok: false, error: 'bad-json' });
      return true;
    }
    const row = readCandidates().find((item) => item.id === String(body.id ?? ''));
    if (!row) {
      sendJson(response, 404, { ok: false, error: 'unknown-id' });
      return true;
    }
    try {
      const result = await glossCandidate(row, { force: body.force === true });
      sendJson(response, 200, result);
    } catch (error) {
      const code = error?.code ?? 'gloss-failed';
      const status = code === 'no-key' ? 503 : 502;
      sendJson(response, status, { ok: false, error: code, detail: String(error?.message ?? '').slice(0, 300) });
    }
    return true;
  }

  if (url === '/api/examine/screen' && request.method === 'POST') {
    if (screening) {
      sendJson(response, 409, { ok: false, error: 'already-running' });
      return true;
    }
    const result = await runScreener();
    sendJson(response, 200, { ok: result.code === 0, ...result });
    return true;
  }

  sendJson(response, 404, { ok: false, error: 'unknown-endpoint' });
  return true;
}
