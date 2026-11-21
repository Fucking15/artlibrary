/**
 * Source adapters for the weekly Schiele sweep.
 *
 * Every adapter returns the same flat shape, so store.mjs and screen.mjs never learn a
 * platform's quirks:
 *
 *   { class, kind, lang, title, url, publisher, published, excerpt, adapter, query }
 *
 * class = which pipeline the source belongs to (A scholarly / B institutional / C secondary /
 * D book / E comment thread). Rules for what each class may be are enforced in
 * scripts/validate.mjs, not here — an adapter only has to be honest about where it looked.
 *
 * Nothing here writes the knowledge base. Everything lands in data/inbox/candidates.jsonl
 * and waits for the screener.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanUrl, clip, fetchJson, fetchText, stripTags } from './net.mjs';

const MAILTO = process.env.TK_MAILTO ?? 'technique-kb@example.org';
/** Several sites reject the crawler UA; a plain browser UA is the honest cost of reading public pages. */
const BROWSER_UA =
  process.env.TK_BROWSER_UA ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/* MediaCrawler（https://github.com/NanmiCoder/MediaCrawler）是一个需要登录态的 Python/Playwright
   采集器，不适合塞进 45 秒的无头周检。这里的边界是「读它的导出」：
   - 先按 docs/inbox.zh.md 手动跑 MediaCrawler，JSONL 落到 _tools/MediaCrawler/data 或本仓库的
     data/inbox/mediacrawler；
   - 周检只读这些 JSONL，把命中席勒的帖子/评论变成 E 类候选，交给 screen + /examine。
   MediaCrawler 的登录、二维码、风控与平台条款都由使用者自己处理。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');
const MC_DIR = path.resolve(process.env.TK_MEDIACRAWLER_DIR ?? path.join(WORKSPACE_ROOT, '_tools', 'MediaCrawler'));
const MC_DATA = path.resolve(process.env.TK_MEDIACRAWLER_DATA ?? path.join(MC_DIR, 'data'));
const MC_DROP = path.resolve(process.env.TK_MEDIACRAWLER_DROP ?? path.join(REPO_ROOT, 'data', 'inbox', 'mediacrawler'));
const MC_INCLUDE_COMMENTS = process.env.TK_MEDIACRAWLER_INCLUDE_COMMENTS === '1';
const MC_MAX = Number(process.env.TK_MEDIACRAWLER_MAX ?? 40) || 40;

export const QUERIES = {
  en: ['"Egon Schiele"', 'Egon Schiele drawing technique', 'Egon Schiele provenance', 'Egon Schiele exhibition'],
  zh: ['埃贡·席勒', '席勒 素描 线条', '席勒 油画 技法', '席勒 展览 2026'],
};

const SCHIELE = /schiele|席勒/i;

const decode = (value) =>
  String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();

const encode = encodeURIComponent;
/** Some APIs take the phrase literally; quotes belong to search-engine syntax only. */
const bare = (query) => String(query).replace(/"/g, '').trim();
const yearOf = (value) => {
  const match = String(value ?? '').match(/(1[6-9]\d{2}|20\d{2})/);
  return match ? Number(match[1]) : null;
};

function item(data) {
  return {
    class: data.class,
    kind: data.kind,
    lang: data.lang,
    title: clip(decode(data.title), 240),
    url: cleanUrl(data.url),
    publisher: decode(data.publisher ?? ''),
    published: data.published ? String(data.published).slice(0, 10) : '',
    excerpt: clip(decode(data.excerpt ?? '')),
    adapter: data.adapter,
    aggregator: data.aggregator === true,
    query: data.query ?? '',
  };
}

function rssItems(xml, limit) {
  const blocks = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return blocks.slice(0, limit).map((block) => {
    const pick = (tag) => {
      const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return match ? decode(match[1]) : '';
    };
    return {
      title: pick('title'),
      link: pick('link'),
      date: pick('pubDate'),
      source: pick('source') || (block.match(/<source[^>]*url="([^"]+)"/) ?? [])[1] || '',
      description: pick('description'),
    };
  });
}

/* ------------------------------------------------------------------ A 学术 */

const crossref = {
  id: 'crossref',
  class: 'A',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    const url =
      'https://api.crossref.org/works?query.bibliographic=' +
      encode(query) +
      `&rows=${limit * 3}&mailto=${MAILTO}&select=DOI,title,author,container-title,issued,type,URL,abstract`;
    const res = await fetchJson(url);
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const kinds = { 'journal-article': 'journal_article', 'book-chapter': 'book_chapter', dissertation: 'dissertation' };
    const items = (res.data.message?.items ?? [])
      .filter((entry) => kinds[entry.type])
      .filter((entry) => SCHIELE.test(`${(entry.title ?? []).join(' ')} ${(entry.author ?? []).map((a) => a.family).join(' ')} ${entry.abstract ?? ''}`))
      .slice(0, limit)
      .map((entry) =>
        item({
          class: 'A',
          kind: kinds[entry.type],
          lang: 'en',
          title: (entry.title ?? [])[0] ?? '(untitled)',
          url: entry.URL ?? `https://doi.org/${entry.DOI}`,
          publisher: (entry['container-title'] ?? [])[0] ?? '',
          published: entry.issued?.['date-parts']?.[0]?.[0] ?? '',
          excerpt: stripTags(entry.abstract ?? `${(entry.author ?? []).map((a) => a.family).join(', ')} · ${entry.DOI}`),
          adapter: 'crossref',
          query,
        }),
      );
    return { ok: true, items };
  },
};

const openalex = {
  id: 'openalex',
  class: 'A',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    const url = `https://api.openalex.org/works?search=${encode(query)}&per-page=${limit}&mailto=${MAILTO}`;
    const res = await fetchJson(url);
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const items = (res.data.results ?? []).slice(0, limit).map((entry) =>
      item({
        class: 'A',
        kind: 'journal_article',
        lang: 'en',
        title: entry.display_name ?? '(untitled)',
        url: entry.doi ?? entry.id,
        publisher: entry.primary_location?.source?.display_name ?? '',
        published: entry.publication_year ?? '',
        excerpt: stripTags(entry.abstract_inverted_index ? '(abstract only in inverted index)' : ''),
        adapter: 'openalex',
        query,
      }),
    );
    return { ok: true, items };
  },
};

/* ------------------------------------------------------------------ B 机构 */

const wikidata = {
  id: 'wikidata',
  class: 'B',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encode(bare(query))}&language=en&uselang=en&format=json&origin=*&limit=${limit}`;
    const res = await fetchJson(url);
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const items = (res.data.search ?? []).map((entry) =>
      item({
        class: 'B',
        kind: 'database_record',
        lang: 'en',
        title: `${entry.label ?? entry.id}${entry.description ? ` — ${entry.description}` : ''}`,
        url: `https://www.wikidata.org/wiki/${entry.id}`,
        publisher: 'Wikidata',
        excerpt: entry.description ?? '',
        adapter: 'wikidata',
        query,
      }),
    );
    return { ok: true, items };
  },
};

function wikipedia(lang, host) {
  return {
    id: `wikipedia-${lang}`,
    class: 'B',
    lang,
    queries: [lang],
    async run(query, limit) {
      const url = `https://${host}/w/api.php?action=query&list=search&srsearch=${encode(bare(query))}&srlimit=${limit}&format=json&origin=*`;
      const res = await fetchJson(url);
      if (!res.ok) return { ok: false, error: res.error, items: [] };
      const items = (res.data.query?.search ?? []).map((entry) =>
        item({
          class: 'B',
          kind: 'other',
          lang,
          title: entry.title,
          url: `https://${host}/wiki/${encode(entry.title.replace(/ /g, '_'))}`,
          publisher: 'Wikipedia',
          excerpt: stripTags(entry.snippet ?? ''),
          adapter: `wikipedia-${lang}`,
          query,
        }),
      );
      return { ok: true, items };
    },
  };
}

const aic = {
  id: 'artic',
  class: 'B',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    const url = `https://api.artic.edu/api/v1/artworks/search?q=${encode(query)}&fields=id,title,date_display,artist_title,medium_display,image_id&limit=${limit}`;
    const res = await fetchJson(url);
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const items = (res.data.data ?? []).map((entry) =>
      item({
        class: 'B',
        kind: 'museum_object_page',
        lang: 'en',
        title: `${entry.title}${entry.artist_title ? ` — ${entry.artist_title}` : ''}`,
        url: `https://www.artic.edu/artworks/${entry.id}`,
        publisher: 'Art Institute of Chicago',
        published: yearOf(entry.date_display) ?? '',
        excerpt: [entry.medium_display, entry.date_display && `dated ${entry.date_display}`].filter(Boolean).join(' · '),
        adapter: 'artic',
        query,
      }),
    );
    return { ok: true, items };
  },
};

/* ------------------------------------------------------------------ C 次级 */

function googleNews(lang, hl, gl, ceid) {
  return {
    id: `gnews-${lang}`,
    class: 'C',
    lang,
    queries: [lang],
    async run(query, limit) {
      const url = `https://news.google.com/rss/search?q=${encode(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
      const res = await fetchText(url, { headers: { accept: 'application/rss+xml,text/xml' } });
      if (!res.ok) return { ok: false, error: res.error, items: [] };
      const items = rssItems(res.text, limit).map((entry) =>
        item({
          class: 'C',
          kind: 'press_article',
          lang,
          title: entry.title,
          url: entry.link,
          publisher: entry.source || 'Google News',
          published: entry.date ? new Date(entry.date).toISOString() : '',
          excerpt: stripTags(entry.description),
          adapter: `gnews-${lang}`,
          // news.google.com/rss/articles/… is a JS redirect: the article body is unreachable from here,
          // so the screener must judge from the RSS title/summary instead of burning a fetch_page call.
          aggregator: true,
          query,
        }),
      );
      return { ok: true, items };
    },
  };
}

/**
 * Bing News 的链接是自家跳转（`bing.com/news/apiclick.aspx?...&url=<encoded>`），
 * 存进库里的应该是出版社原文地址——否则引用对不上、译·摘要也只能读到跳转页。
 * 解不开时退回跳转地址，并标 aggregator（`fetch_page` 会据此提示模型别硬判 F）。
 */
function unwrapBing(url) {
  try {
    const parsed = new URL(url);
    if (!/bing\.com$/i.test(parsed.hostname)) return url;
    const target = parsed.searchParams.get('url');
    if (target && /^https?:\/\//i.test(target)) return target;
    return url;
  } catch {
    return url;
  }
}

const bingNews = {
  id: 'bingnews',
  class: 'C',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    const url = `https://www.bing.com/news/search?q=${encode(query)}&format=RSS`;
    const res = await fetchText(url, { headers: { accept: 'application/rss+xml,text/xml' } });
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const items = rssItems(res.text, limit).map((entry) => {
      const real = unwrapBing(entry.link ?? '');
      return item({
        class: 'C',
        kind: 'press_article',
        lang: 'en',
        title: entry.title,
        url: real,
        publisher: entry.source || 'Bing News',
        published: entry.date ? new Date(entry.date).toISOString() : '',
        excerpt: stripTags(entry.description),
        adapter: 'bingnews',
        aggregator: real === entry.link,
        query,
      });
    });
    return { ok: true, items };
  },
};

/* ------------------------------------------------------------------ D 书籍 */

const LANG_MAP = { eng: 'en', ger: 'de', fre: 'fr', ita: 'it', chi: 'zh', zho: 'zh', spa: 'other', dut: 'other' };

const openlibrary = {
  id: 'openlibrary',
  class: 'D',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    const url = `https://openlibrary.org/search.json?q=${encode(query)}&limit=${limit}&fields=key,title,author_name,first_publish_year,language,publisher,edition_count`;
    const res = await fetchJson(url);
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const items = (res.data.docs ?? []).slice(0, limit).map((entry) =>
      item({
        class: 'D',
        kind: 'book',
        lang: LANG_MAP[(entry.language ?? [])[0]] ?? 'en',
        title: `${entry.title}${entry.first_publish_year ? ` (${entry.first_publish_year})` : ''}`,
        url: `https://openlibrary.org${entry.key}`,
        publisher: (entry.publisher ?? [])[0] ?? 'Open Library',
        published: entry.first_publish_year ?? '',
        excerpt: `${(entry.author_name ?? []).join(', ')} · ${entry.edition_count ?? 0} 个版本`,
        adapter: 'openlibrary',
        query,
      }),
    );
    return { ok: true, items };
  },
};

const archiveOrg = {
  id: 'archive-org',
  class: 'D',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    const url =
      'https://archive.org/advancedsearch.php?q=' +
      encode(`("Egon Schiele" OR Schiele) AND mediatype:texts`) +
      '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&fl%5B%5D=creator&fl%5B%5D=language&rows=' +
      limit +
      '&page=1&output=json';
    const res = await fetchJson(url);
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const items = (res.data.response?.docs ?? []).map((entry) =>
      item({
        class: 'D',
        kind: 'book',
        lang: LANG_MAP[String(entry.language ?? '').slice(0, 3)] ?? 'en',
        title: entry.title ?? entry.identifier,
        url: `https://archive.org/details/${entry.identifier}`,
        publisher: 'Internet Archive',
        published: entry.year ?? '',
        excerpt: Array.isArray(entry.creator) ? entry.creator.join(', ') : String(entry.creator ?? ''),
        adapter: 'archive-org',
        query,
      }),
    );
    return { ok: true, items };
  },
};

const crossrefBooks = {
  id: 'crossref-books',
  class: 'D',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    const url = `https://api.crossref.org/works?query.bibliographic=${encode(query)}&filter=type:book,type:monograph&rows=${limit * 3}&mailto=${MAILTO}&select=DOI,title,author,publisher,issued,type,URL`;
    const res = await fetchJson(url);
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const items = (res.data.message?.items ?? [])
      .filter((entry) => SCHIELE.test(`${(entry.title ?? []).join(' ')} ${(entry.author ?? []).map((a) => a.family).join(' ')}`))
      .slice(0, limit)
      .map((entry) =>
        item({
          class: 'D',
          kind: 'book',
          lang: 'en',
          title: (entry.title ?? [])[0] ?? '(untitled)',
          url: entry.URL ?? `https://doi.org/${entry.DOI}`,
          publisher: entry.publisher ?? '',
          published: entry.issued?.['date-parts']?.[0]?.[0] ?? '',
          excerpt: (entry.author ?? []).map((a) => `${a.given ?? ''} ${a.family ?? ''}`.trim()).join(', '),
          adapter: 'crossref-books',
          query,
        }),
      );
    return { ok: true, items };
  },
};

const doubanBooks = {
  id: 'douban-books',
  class: 'D',
  lang: 'zh',
  queries: ['zh'],
  async run(query, limit) {
    const url = `https://book.douban.com/j/subject_suggest?q=${encode(query)}`;
    const res = await fetchJson(url, { headers: { 'user-agent': BROWSER_UA, referer: 'https://book.douban.com/' } });
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const items = (Array.isArray(res.data) ? res.data : [])
      .filter((entry) => entry.type === 'b' || /\/subject\//.test(entry.url ?? ''))
      .slice(0, limit)
      .map((entry) =>
        item({
          class: 'D',
          kind: 'book',
          lang: 'zh',
          title: entry.title,
          url: entry.url,
          publisher: '豆瓣读书',
          excerpt: `${entry.author_name ?? ''} ${entry.year ?? ''}`.trim(),
          adapter: 'douban-books',
          query,
        }),
      );
    return { ok: true, items };
  },
};

/* ------------------------------------------------------------------ E 评论区 */

/* MediaCrawler 的 JSONL 字段是各平台自己的：小红书 note_url / 抖音 aweme_url / B站 bvid …
   这里只做一层宽容的归一化，字段缺失就丢掉，不猜。 */
const MC_PLATFORM_LABELS = {
  xhs: '小红书',
  dy: '抖音',
  ks: '快手',
  bili: '哔哩哔哩',
  wb: '微博',
  tieba: '百度贴吧',
  zhihu: '知乎',
};
const MC_PLATFORM_SLUGS = new Set(Object.keys(MC_PLATFORM_LABELS));

function mcText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function mcDate(value) {
  const raw = mcText(value);
  if (!raw) return '';
  if (/^\d{10,13}$/.test(raw)) {
    const milliseconds = raw.length >= 13 ? Number(raw) : Number(raw) * 1000;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  const match = raw.match(/((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  return '';
}

function mcPlatformOf(file) {
  for (const part of String(file).split(/[\\/]/)) {
    const slug = part.toLowerCase();
    if (MC_PLATFORM_SLUGS.has(slug)) return slug;
  }
  return 'mediacrawler';
}

function mcUrl(entry, platform) {
  const direct = mcText(
    entry.note_url,
    entry.video_url,
    entry.aweme_url,
    entry.content_url,
    entry.share_url,
    entry.url,
    entry.question_url,
    entry.article_url,
  );
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  if (platform === 'bili') {
    const bvid = mcText(entry.bvid, entry.bv_id, entry.video_id);
    if (bvid) return `https://www.bilibili.com/video/${bvid}`;
  }
  if (platform === 'xhs' && mcText(entry.note_id)) return `https://www.xiaohongshu.com/explore/${mcText(entry.note_id)}`;
  if (platform === 'dy' && mcText(entry.aweme_id)) return `https://www.douyin.com/video/${mcText(entry.aweme_id)}`;
  if (platform === 'wb') {
    const id = mcText(entry.mblogid, entry.mblog_id, entry.id);
    if (id) return `https://m.weibo.cn/detail/${id}`;
  }
  if (platform === 'zhihu') {
    const answer = mcText(entry.answer_id);
    const question = mcText(entry.question_id);
    if (answer && question) return `https://www.zhihu.com/question/${question}/answer/${answer}`;
    const article = mcText(entry.article_id);
    if (article) return `https://zhuanlan.zhihu.com/p/${article}`;
  }
  return '';
}

function mcItem(entry, file, query) {
  if (!entry || typeof entry !== 'object') return null;
  const platform = mcPlatformOf(file);
  const title = mcText(
    entry.title,
    entry.note_title,
    entry.video_title,
    entry.article_title,
    entry.question_title,
    entry.content,
    entry.desc,
    entry.text,
  );
  const excerpt = mcText(entry.desc, entry.content, entry.text, entry.summary, entry.title);
  const url = mcUrl(entry, platform);
  if (!title || !url) return null;

  const haystack = `${title} ${excerpt}`;
  if (!SCHIELE.test(haystack)) return null;

  const isComment = /comments/i.test(file) || Boolean(entry.comment_id);
  return item({
    class: 'E',
    kind: isComment ? 'social_comment' : 'forum_thread',
    lang: 'zh',
    title: stripTags(title),
    url,
    publisher: `${MC_PLATFORM_LABELS[platform] ?? platform} · MediaCrawler`,
    published: mcDate(mcText(entry.time, entry.create_time, entry.publish_time, entry.last_update_time, entry.created_at)),
    excerpt: stripTags(excerpt || title),
    adapter: 'mediacrawler',
    query: mcText(entry.source_keyword, entry.keyword) || query,
  });
}

function mcJsonlFiles(dir, out = [], depth = 0) {
  if (depth > 5) return out;
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
      mcJsonlFiles(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      if (entry.name.includes('contents')) out.push(full);
      else if (MC_INCLUDE_COMMENTS && entry.name.includes('comments')) out.push(full);
    }
  }
  return out;
}

const mediaCrawler = {
  id: 'mediacrawler',
  class: 'E',
  lang: 'zh',
  // 一次把导出批次全部读入；weekly 只调用一次，不需要按查询重复扫盘。
  terms: ['MediaCrawler'],
  async run(query, limit) {
    const files = [...new Set([...mcJsonlFiles(MC_DROP), ...mcJsonlFiles(MC_DATA)])];
    if (!files.length) {
      return {
        ok: true,
        items: [],
        note: `没有 MediaCrawler 导出（${MC_DROP} 或 ${MC_DATA}）；先按 docs/inbox.zh.md 跑一次`,
      };
    }

    const seen = new Set();
    const items = [];
    let badLines = 0;
    for (const file of files) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        badLines += 1;
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          badLines += 1;
          continue;
        }
        const mapped = mcItem(entry, file, query);
        if (!mapped || seen.has(mapped.url)) continue;
        seen.add(mapped.url);
        items.push(mapped);
      }
    }

    if (!items.length) {
      return {
        ok: true,
        items: [],
        note: `${files.length} 个 JSONL，没有命中席勒${badLines ? `（${badLines} 行无法解析）` : ''}`,
      };
    }

    const cap = Math.max(limit, MC_MAX);
    return {
      ok: true,
      items: items.slice(0, cap),
      note: `${files.length} 个 JSONL · 命中 ${items.length} 条${badLines ? ` · ${badLines} 行坏数据` : ''}`,
    };
  },
};

const hackerNews = {
  id: 'hn',
  class: 'E',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    const bareQuery = bare(query);
    const url = `https://hn.algolia.com/api/v1/search?query=${encode(bareQuery)}&tags=comment&hitsPerPage=${limit}`;
    const res = await fetchJson(url);
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const items = (res.data.hits ?? [])
      .filter((hit) => SCHIELE.test(hit.comment_text ?? ''))
      .map((hit) =>
        item({
          class: 'E',
          kind: 'social_comment',
          lang: 'en',
          title: `HN 评论 ${hit.story_title ?? hit.objectID} · @${hit.author ?? '?'}`,
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          publisher: 'Hacker News',
          published: hit.created_at ?? '',
          excerpt: stripTags(hit.comment_text ?? ''),
          adapter: 'hn',
          query,
        }),
      );
    return { ok: true, items };
  },
};

const met = {
  id: 'met',
  class: 'B',
  lang: 'en',
  queries: ['en'],
  async run(query, limit) {
    // v1 search was retired 2026-10-01 (HTTP 410); v1.1 is the live path.
    const search = await fetchJson(
      `https://collectionapi.metmuseum.org/public/collection/v1.1/search?q=${encode(bare(query))}`,
    );
    if (!search.ok) return { ok: false, error: search.error, items: [] };
    const ids = (search.data.objectIDs ?? []).slice(0, limit);
    const items = [];
    for (const id of ids) {
      const detail = await fetchJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
      if (!detail.ok) continue;
      const object = detail.data;
      if (!SCHIELE.test(`${object.artistDisplayName ?? ''} ${object.title ?? ''}`)) continue;
      items.push(
        item({
          class: 'B',
          kind: 'museum_object_page',
          lang: 'en',
          title: `${object.title ?? '(untitled)'} — ${object.artistDisplayName ?? ''}`.trim(),
          url: object.objectURL ?? `https://www.metmuseum.org/art/collection/search/${id}`,
          publisher: 'The Metropolitan Museum of Art',
          published: yearOf(object.objectDate) ?? '',
          excerpt: [object.medium, object.objectDate, object.creditLine].filter(Boolean).join(' · '),
          adapter: 'met',
          query,
        }),
      );
    }
    return { ok: true, items };
  },
};

const doubanReviews = {
  id: 'douban-reviews',
  class: 'E',
  lang: 'zh',
  // 宽词「席勒」在豆瓣会命中德国诗人 Friedrich Schiller；用带画家线索的精确词。
  terms: ['席勒 画', '克里姆特 席勒', '埃贡·席勒'],
  async run(query, limit) {
    const headers = { 'user-agent': BROWSER_UA, referer: 'https://book.douban.com/' };
    const suggest = await fetchJson(`https://book.douban.com/j/subject_suggest?q=${encode(query)}`, { headers });
    if (!suggest.ok) return { ok: false, error: suggest.error, items: [] };
    const books = (Array.isArray(suggest.data) ? suggest.data : []).filter((entry) => entry.type === 'b' && entry.id).slice(0, 2);
    const items = [];
    for (const book of books) {
      const page = await fetchText(`https://book.douban.com/subject/${book.id}/reviews`, { headers });
      if (!page.ok) continue;
      const rows = [
        ...page.text.matchAll(
          /<div class="main review-item" id="(\d+)"[\s\S]*?<h2><a href="(https:\/\/book\.douban\.com\/review\/\d+\/)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<div class="short-content">([\s\S]*?)<\/(?:div|p)>/g,
        ),
      ].slice(0, limit);
      for (const row of rows) {
        items.push(
          item({
            class: 'E',
            kind: 'user_review',
            lang: 'zh',
            title: `${stripTags(row[3])} — 评《${book.title}》`,
            url: row[2],
            publisher: '豆瓣读书',
            excerpt: stripTags(row[4]),
            adapter: 'douban-reviews',
            query,
          }),
        );
      }
    }
    return { ok: true, items };
  },
};

const doubanGroups = {
  id: 'douban-groups',
  class: 'E',
  lang: 'zh',
  terms: ['席勒', '埃贡·席勒'],
  async run(query, limit) {
    const url = `https://www.douban.com/group/search?cat=1013&q=${encode(query)}`;
    const res = await fetchText(url, { headers: { 'user-agent': BROWSER_UA, referer: 'https://www.douban.com/' } });
    if (!res.ok) return { ok: false, error: res.error, items: [] };
    const seen = new Set();
    const items = [];
    // href 上挂着 ?_spm_id=…，标题在 title 属性里比正文干净。
    for (const match of res.text.matchAll(
      /<a[^>]+href="(https:\/\/www\.douban\.com\/group\/topic\/\d+\/)[^"]*"[^>]*title="([^"]*)"/g,
    )) {
      const link = match[1];
      if (seen.has(link)) continue;
      const title = decode(match[2]);
      if (!title || title.length < 4) continue;
      // 小组搜索常把「席勒」理解成诗人，标题里至少要有艺术线索。
      if (!/席勒|schiele|绘画|画|艺术|展览/i.test(title)) continue;
      seen.add(link);
      items.push(
        item({
          class: 'E',
          kind: 'forum_thread',
          lang: 'zh',
          title,
          url: link,
          publisher: '豆瓣小组',
          excerpt: '',
          adapter: 'douban-groups',
          query,
        }),
      );
      if (items.length >= limit) break;
    }
    return { ok: true, items };
  },
};

export const ADAPTERS = [
  crossref,
  openalex,
  wikidata,
  wikipedia('en', 'en.wikipedia.org'),
  wikipedia('zh', 'zh.wikipedia.org'),
  aic,
  met,
  googleNews('en', 'en-US', 'US', 'US:en'),
  googleNews('zh', 'zh-CN', 'CN', 'CN:zh-Hans'),
  bingNews,
  openlibrary,
  archiveOrg,
  crossrefBooks,
  doubanBooks,
  hackerNews,
  doubanReviews,
  doubanGroups,
  mediaCrawler,
];

export function adaptersByClass(klass) {
  return ADAPTERS.filter((adapter) => adapter.class === klass);
}
