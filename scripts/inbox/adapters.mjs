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
import { cleanUrl, clip, fetchJson, fetchText, stripTags } from './net.mjs';

const MAILTO = process.env.TK_MAILTO ?? 'technique-kb@example.org';
/** Several sites reject the crawler UA; a plain browser UA is the honest cost of reading public pages. */
const BROWSER_UA =
  process.env.TK_BROWSER_UA ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

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
];

export function adaptersByClass(klass) {
  return ADAPTERS.filter((adapter) => adapter.class === klass);
}
