#!/usr/bin/env node
/**
 * MediaCrawler bridge for the weekly inbox.
 *
 *   node scripts/inbox/mediacrawler.mjs --check
 *   node scripts/inbox/mediacrawler.mjs --list
 *   node scripts/inbox/mediacrawler.mjs --run --platform xhs --keywords "埃贡·席勒,席勒 素描"
 *
 * MediaCrawler itself is an interactive Python/Playwright project (QR login, Chrome CDP).
 * This script only launches it and points its JSONL output at data/inbox/mediacrawler/;
 * weekly.mjs's `mediacrawler` adapter then reads that output as class-E candidates.
 *
 * Prerequisites (see docs/inbox.zh.md):
 *   - MediaCrawler checkout, default _tools/MediaCrawler (or TK_MEDIACRAWLER_DIR)
 *   - Python 3.11 + uv, Chrome >= 144 for CDP, a logged-in account for the platform
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WORKSPACE = path.resolve(REPO, '..');
const MC_DIR = path.resolve(process.env.TK_MEDIACRAWLER_DIR ?? path.join(WORKSPACE, '_tools', 'MediaCrawler'));
const MC_DATA = path.resolve(process.env.TK_MEDIACRAWLER_DATA ?? path.join(MC_DIR, 'data'));
const MC_DROP = path.resolve(process.env.TK_MEDIACRAWLER_DROP ?? path.join(REPO, 'data', 'inbox', 'mediacrawler'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PLATFORMS = new Set(['xhs', 'dy', 'ks', 'bili', 'wb', 'tieba', 'zhihu']);

function jsonlFiles(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      jsonlFiles(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function describe() {
  const files = [...new Set([...jsonlFiles(MC_DROP), ...jsonlFiles(MC_DATA)])];
  console.log('MediaCrawler bridge');
  console.log(`  checkout : ${MC_DIR} (${fs.existsSync(path.join(MC_DIR, 'main.py')) ? 'main.py found' : 'missing'})`);
  console.log(`  its data : ${MC_DATA} (${jsonlFiles(MC_DATA).length} jsonl)`);
  console.log(`  drop     : ${MC_DROP} (${jsonlFiles(MC_DROP).length} jsonl)`);
  console.log(`  adapter  : class E · notes/评论 → screen → /examine`);
  console.log(`  python   : ${process.env.TK_MEDIACRAWLER_PYTHON ?? 'python'}`);
  console.log(`  platforms: ${[...PLATFORMS].join(', ')}`);
  if (files.length) {
    for (const file of files.slice(0, 12)) {
      let lines = 0;
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
      } catch {
        /* ignore */
      }
      console.log(`  - ${path.relative(REPO, file)}  (${lines} rows)`);
    }
    if (files.length > 12) console.log(`  … ${files.length - 12} more`);
  } else {
    console.log('  (还没有导出；先运行 --run，或把已有 MediaCrawler JSONL 放进 drop)');
  }
}

function run() {
  if (!fs.existsSync(path.join(MC_DIR, 'main.py'))) {
    console.error(`MediaCrawler 不在 ${MC_DIR}。先 clone 到该目录，或设置 TK_MEDIACRAWLER_DIR。`);
    process.exit(2);
  }
  const platform = String(value('platform', 'xhs')).toLowerCase();
  if (!PLATFORMS.has(platform)) {
    console.error(`不支持的平台：${platform}（可选 ${[...PLATFORMS].join(', ')}）`);
    process.exit(2);
  }
  const keywords = String(value('keywords', '埃贡·席勒,席勒 素描,席勒 绘画'));
  const notes = String(value('notes', process.env.TK_MEDIACRAWLER_NOTES ?? '10'));
  const comments = String(value('comments', 'no')); // 内容帖为主；评论开 yes 才抓
  const login = String(value('lt', 'qrcode'));
  fs.mkdirSync(MC_DROP, { recursive: true });

  const python = process.env.TK_MEDIACRAWLER_PYTHON ?? '';
  let command = python || 'python';
  let prefix = [];
  if (!python) {
    const uv = spawnSync('uv', ['--version'], { stdio: 'ignore', windowsHide: true });
    if (uv.status === 0) {
      command = 'uv';
      prefix = ['run'];
    }
  }

  const cli = [
    ...prefix,
    'main.py',
    '--platform', platform,
    '--lt', login,
    '--type', 'search',
    '--keywords', keywords,
    '--save_data_option', 'jsonl',
    '--save_data_path', MC_DROP,
    '--crawler_max_notes_count', notes,
    '--get_comment', comments,
    '--headless', 'no',
  ];

  console.log(`\n运行 MediaCrawler · ${platform} · keywords=${keywords}`);
  console.log(`输出目录：${MC_DROP}\n`);
  const result = spawnSync(command, cli, {
    cwd: MC_DIR,
    stdio: 'inherit',
    env: { ...process.env },
    windowsHide: false,
  });
  if (result.error) {
    console.error(`启动失败：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`MediaCrawler 退出码 ${result.status}（登录/风控/浏览器未就绪都会这样）`);
    process.exit(result.status ?? 1);
  }
  console.log('\n完成。下一步：node scripts/inbox/weekly.mjs --only=mediacrawler');
}

if (flag('help')) {
  console.log(`用法：
  node scripts/inbox/mediacrawler.mjs --check
  node scripts/inbox/mediacrawler.mjs --list
  node scripts/inbox/mediacrawler.mjs --run --platform xhs --keywords "埃贡·席勒,席勒 素描" [--notes=10] [--comments=no]

环境变量：
  TK_MEDIACRAWLER_DIR     默认 _tools/MediaCrawler
  TK_MEDIACRAWLER_DATA    默认 <DIR>/data
  TK_MEDIACRAWLER_DROP    默认 artlibrary/data/inbox/mediacrawler
  TK_MEDIACRAWLER_MAX     周检最多收录多少条，默认 40
  TK_MEDIACRAWLER_INCLUDE_COMMENTS=1  连评论 JSONL 一起读（默认只读 contents）`);
} else if (flag('run')) {
  run();
} else if (flag('list')) {
  for (const file of [...new Set([...jsonlFiles(MC_DROP), ...jsonlFiles(MC_DATA)])]) {
    console.log(path.relative(REPO, file));
  }
} else {
  describe();
}
