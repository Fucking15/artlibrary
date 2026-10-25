/**
 * Minimal HTTP helpers for the crawler.
 *
 * The point is not to be clever, it is to fail in a way the run report can explain:
 * every call returns either data or a reason string, nothing throws past the adapter.
 */
const UA = process.env.TK_UA ?? 'technique-kb-crawler/0.1 (local research mirror; contact: local)';

export async function fetchText(url, { timeout = 12_000, headers = {}, retries = 1 } = {}) {
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: '*/*', ...headers },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      const text = await res.text();
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      return { ok: true, status: res.status, text, contentType: res.headers.get('content-type') ?? '' };
    } catch (error) {
      lastError = String(error?.cause?.code ?? error?.name ?? error?.message ?? error);
    }
  }
  return { ok: false, error: lastError };
}

export async function fetchJson(url, options = {}) {
  const res = await fetchText(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  if (!res.ok) return res;
  try {
    return { ok: true, status: res.status, data: JSON.parse(res.text) };
  } catch {
    return { ok: false, error: 'not json' };
  }
}

/** Strip tracking noise so the same article found twice dedupes to one candidate. */
export function cleanUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|spm|from)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return String(raw ?? '').trim();
  }
}

/**
 * 整页 HTML 去掉导航的可靠办法是先用结构：优先取 `<main>`，没有就取 `<article>`。
 * 博物馆与新闻站的正文都在这些容器里，站点头部/页脚（开放时间、菜单、cookie 条）在外面。
 * 找不到容器才退回整页——宁可留噪音，也不能把正文切没。
 */
export function mainHtml(html) {
  const source = String(html ?? '');
  if (!source) return source;
  const pick = (tag) => {
    const blocks = [...source.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'))].map((m) => m[0]);
    if (!blocks.length) return '';
    return blocks.reduce((best, block) => (block.length > best.length ? block : best), '');
  };
  for (const tag of ['main', 'article']) {
    const block = pick(tag);
    if (block && block.length >= 800) return block;
  }
  return source;
}

/**
 * 从整页 HTML 里取正文，按「能不能对上标题」来决定信谁。
 *
 * 为什么不能无条件用 `<main>`：新闻站的 `<main>` 里常常塞着比正文更长的推荐位
 * （NZZ 那页最大的 `<article>` 就是另一篇讲阿尔萨斯抗议的稿子），一刀切会把正文换成别人的文章。
 * 所以先拿 `<main>`/`<article>` 试，只有文本里出现了标题才认；对不上就退回整页（前面再削导航）。
 */
export function pageText(html, hint = '') {
  const source = String(html ?? '');
  if (!source) return '';
  const wanted = String(hint ?? '').trim().toLowerCase().slice(0, 24);
  const blocks = [];
  for (const tag of ['main', 'article']) {
    const matches = [...source.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'))];
    for (const match of matches) blocks.push(match[0]);
  }
  blocks.sort((a, b) => b.length - a.length);
  for (const block of blocks.slice(0, 6)) {
    const text = trimChrome(stripTags(block));
    if (text.length < 400) continue;
    if (wanted && !text.toLowerCase().includes(wanted)) continue;
    return text;
  }
  return trimChrome(stripTags(source));
}

export function stripTags(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Long texts are clipped at a sentence-ish boundary; the full page stays at `url`. */
export function clip(text, max = 600) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return `${(stop > max * 0.6 ? cut.slice(0, stop + 1) : cut).trim()}…`;
}

/**
 * 网页正文前面通常压着一层导航（「跳至内容 / 主导航 / Zum Inhalt springen / Skip to content …」）。
 * 直接把这层拿去做翻译或初筛，模型会先读一堆菜单，还会把菜单词写进摘要。
 * 做法：只看开头一段窗口，把这段里出现的导航标记找出来，从最后一个标记之后的第一句开始取。
 * 找不到标记就原样返回——宁可留点噪音，也不要把正文切掉。
 */
const NAV_MARKERS = [
  '跳至内容',
  '跳转到主要内容',
  '主导航',
  '主菜单',
  'skip to content',
  'skip to main content',
  'jump to content',
  'zum inhalt springen',
  'zum hauptinhalt',
  'aller au contenu',
  'allier au contenu',
  'passer au contenu',
  'ir al contenido',
  'saltar al contenido',
  'vai al contenuto',
  'main menu',
  'open menu',
  'toggle menu',
  'startseite',
  'feuilleton',
  'anmelden',
  'newsletter',
  'cookie',
];

export function trimChrome(text, { window = 1200 } = {}) {
  const value = String(text ?? '').trim();
  if (!value) return value;
  const head = value.slice(0, window).toLowerCase();
  let cut = 0;
  for (const marker of NAV_MARKERS) {
    const at = head.lastIndexOf(marker);
    if (at === -1) continue;
    const after = at + marker.length;
    if (after > cut) cut = after;
  }
  if (!cut) return value;
  const tail = value.slice(Math.min(cut, value.length));
  const boundary = tail.search(/[。！？.!?]\s/);
  const start = boundary === -1 ? 0 : boundary + 1;
  const trimmed = tail.slice(start).trim();
  // 切完要有足够长的正文，否则说明标记命中的是正文里的词，退回原文。
  return trimmed.length >= 240 ? trimmed : value;
}

