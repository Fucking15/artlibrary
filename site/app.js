/* technique-kb — static viewer with per-artist pages and an AI-assisted search.
 *
 * Routes (hash only, so GitHub Pages needs no rewrites):
 *   #/                      画家索引（主页）
 *   #/artist/<id>           画家页 · 概览（一页）
 *   #/artist/<id>/dimensions
 *                           画家页 · 六维档案（时期 / 师从与影响 / 对比与创新 /
 *                           媒介与材料 / 画面构成 / 题材，六个板块同一页）
 *   #/artist/<id>/dimensions/<dim>
 *                           同上，直接落到某一个板块
 *   #/artist/<id>/sources   该画家引用的来源（单独一页）
 *   #/sources               全部来源登记
 *   #/images                图片区：全站引用过的作品图片链接（独立一页）
 *
 * 旧链接 #/artist/<id>/<dim> 仍然可用：会被读成「六维档案」并滚到对应的板块。
 *
 * 数据只有 ./data/index.json 一处。AI 检索先打本地预览服务器的 /api/ai（密钥留在服务端），
 * 没有代理时退回浏览器直连 DeepSeek，密钥只存在本机 localStorage。 */

const DIM_LABELS = {
  period: { zh: '时期', en: 'period' },
  lineage: { zh: '师从与影响', en: 'lineage' },
  comparison: { zh: '对比与创新', en: 'comparison' },
  material: { zh: '媒介与材料', en: 'medium & material' },
  composition: { zh: '画面构成', en: 'composition' },
  subject_matter: { zh: '题材', en: 'subject matter' },
};

/** 六维在「六维档案」页里的固定顺序。 */
const DIM_ORDER = ['period', 'lineage', 'comparison', 'material', 'composition', 'subject_matter'];

/** 每个板块的一句导语，放在长页面里给人一个抓手。 */
const DIM_NOTES = {
  period: '分期依据与断点事件',
  lineage: '他接过谁的做法，又改写了哪一段',
  comparison: '同代人在做什么，他多出了什么',
  material: '底材、媒介与工序',
  composition: '结构、颜色、取景、光影、笔法',
  subject_matter: '反复出现的母题与理由',
};

/** 画家页只有三个顶层页：概览 / 六维档案 / 来源。 */
const TAB_LABELS = { overview: '概览', dimensions: '六维档案', sources: '来源' };

const FIELD_LABELS = {
  structure_proportion: '结构与比例',
  color: '颜色',
  framing: '取景',
  light_shadow: '明暗光影',
  brushwork: '笔法与技法',
};

const STATUS_LABELS = { draft: '草稿', verified: '已核来源', signed: '已签字', deprecated: '已废弃' };
const CONF_LABELS = { high: '高', medium: '中', low: '低' };

const MEDIA_LABELS = {
  oil: '油画',
  oil_on_panel: '木板油画',
  watercolor: '水彩',
  colored_on_paper: '纸上彩色',
  drawing_on_paper: '纸上素描',
  print: '版画',
  period_level: '时期级',
};

/* 画面上一律先列这四类；没有条目的也列出来，标「空白」。
   数据里若还声明了别的画种（水彩、木板油画…），排在四类之后，免得把已有内容藏掉。 */
const MEDIA_CORE = ['oil', 'colored_on_paper', 'drawing_on_paper', 'print'];
const MEDIA_ORDER = ['oil', 'oil_on_panel', 'watercolor', 'colored_on_paper', 'drawing_on_paper', 'print'];
const BLANK = '空白';

const mediaCount = (dossier, medium) => Number(dossier?.media?.counts?.[medium] ?? 0);

/** 这一期要显示的全部画种：固定四类 + 数据里额外声明的。 */
function mediaList(dossier) {
  const extra = new Set(
    [...(dossier?.media?.declared ?? []), ...Object.keys(dossier?.media?.counts ?? {})].filter(
      (medium) => medium !== 'period_level',
    ),
  );
  return [
    ...MEDIA_CORE,
    ...MEDIA_ORDER.filter((medium) => !MEDIA_CORE.includes(medium) && extra.has(medium)),
  ].filter((medium) => MEDIA_LABELS[medium]);
}

const selectedMediaLabel = () => [...state.media].map((medium) => MEDIA_LABELS[medium] ?? medium).join(' / ');

const SUPPORT_LABELS = {
  paper: '纸本',
  canvas: '布面',
  panel: '木板',
  wood: '木板',
  cardboard: '卡纸',
  board: '板',
};

const DRAWING_MEDIUM_LABELS = {
  pencil: '铅笔',
  charcoal: '炭笔',
  crayon: '蜡笔',
  ink: '墨水',
  gouache: '水粉',
  watercolor: '水彩',
  tempera: '蛋彩',
  chalk: '粉笔',
  oil: '油画',
};

const RELATION_LABELS = {
  teacher_mentor: '老师 / 引路人',
  self_prior_period: '他本人的前一阶段',
  peer: '同侪',
  follower: '追随者',
  rival: '对手',
  patron: '赞助人',
};

const MOTIF_LABELS = {
  self_portrait: '自画像',
  double_portrait: '双人像',
  portrait: '肖像',
  nude: '裸体',
  figure_study: '人体习作',
  mother_and_child: '母子',
  landscape: '风景',
  still_life: '静物',
  pregnant: '孕妇',
  sick: '病人',
};

const KIND_LABELS = {
  catalogue_raisonne: '作品全集目录',
  monograph: '专著',
  article: '论文',
  museum_object_page: '馆藏对象页',
  museum_research_document: '机构研究文档',
  exhibition_page: '展览页',
  archive: '档案',
  database: '数据库',
  interview: '访谈',
};

const LANG_LABELS = { zh: '中文', en: '英文', de: '德文', fr: '法文', it: '意大利文' };
const DEFAULT_LLM_BASE = 'https://api.deepseek.com';
const DEFAULT_LLM_MODEL = 'deepseek-chat';
/** 兼容旧版本：早期只存一个 DeepSeek Key，没有 base/model。 */
const KEY_STORE = 'tk_deepseek_key';
const LLM_STORE = 'tk_llm_settings';

/* file:// 打开的单文件版是 opaque origin，碰 localStorage 会抛 SecurityError，
   所以统一走这层：能存就存，不能存就退回内存。 */
const store = (() => {
  try {
    const probe = '__tk_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    const mem = new Map();
    return {
      getItem: (key) => (mem.has(key) ? mem.get(key) : null),
      setItem: (key, value) => mem.set(key, String(value)),
      removeItem: (key) => mem.delete(key),
    };
  }
})();

const qs = (sel, root = document) => root.querySelector(sel);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------ 读者自己的 LLM 设置 */

/**
 * BYOK（bring your own key）：问答用的密钥只写进这台浏览器的 localStorage。
 * 线上是 GitHub Pages，没有 /api/ai 这种服务端转发，所以直连是唯一通道；
 * 本机跑 preview.cmd 时代理优先（密钥在服务端，浏览器里可以什么都不填）。
 * base/model 都可改，于是 DeepSeek、OpenAI、Ollama、vLLM 这些 OpenAI 兼容端点都能用。
 */
function llmSettings() {
  let saved = {};
  try {
    saved = JSON.parse(store.getItem(LLM_STORE) || '{}') || {};
  } catch {
    saved = {};
  }
  return {
    baseUrl: String(saved.baseUrl || DEFAULT_LLM_BASE).trim().replace(/\/+$/, '') || DEFAULT_LLM_BASE,
    model: String(saved.model || DEFAULT_LLM_MODEL).trim() || DEFAULT_LLM_MODEL,
    key: String(store.getItem(KEY_STORE) || '').trim(),
  };
}

function saveLlmSettings(next) {
  store.setItem(
    LLM_STORE,
    JSON.stringify({ baseUrl: next.baseUrl?.trim() || DEFAULT_LLM_BASE, model: next.model?.trim() || DEFAULT_LLM_MODEL }),
  );
  if (next.key?.trim()) store.setItem(KEY_STORE, next.key.trim());
  else store.removeItem(KEY_STORE);
  markAiAvailability();
  markSettingsButton();
}

function llmEndpoint(settings = llmSettings()) {
  return `${settings.baseUrl}/chat/completions`;
}

const maskKey = (key) => (!key ? '' : key.length <= 8 ? '已存' : `${key.slice(0, 3)}…${key.slice(-4)}`);

/* --------------------------------------------------------------- 译文缓存 */

/* 文档页的「AI 翻译」：把页面上每条中文结论翻成英文/德文，或把英文条目翻回中文。
   译文只存本机，按「目标语言 + 原文哈希」做键，换语言或改原文都不会串。 */
const TR_STORE = 'tk.translate.v1';
const TR_TARGETS = [
  { key: 'en', label: 'English' },
  { key: 'de', label: 'Deutsch' },
  { key: 'zh', label: '中文' },
];

const trCache = (() => {
  try {
    return JSON.parse(store.getItem(TR_STORE) || '{}') || {};
  } catch {
    return {};
  }
})();

const trHash = (text) => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
const trKey = (target, text) => `${target}:${trHash(text)}`;

function trSave() {
  try {
    store.setItem(TR_STORE, JSON.stringify(trCache));
  } catch {
    /* 存满就算了，译文还在内存里 */
  }
}

function trLookup(text) {
  return trCache[trKey(state.translate.target, text)] ?? '';
}

/** 有译文就在原文下面挂一行；没有就什么都不渲染。 */
function trLine(text) {
  const value = typeof text === 'string' ? trLookup(text) : '';
  if (!value) return '';
  return `<p class="tr-result"><span class="tr-tag">${esc(state.translate.target.toUpperCase())}</span>${esc(value)}</p>`;
}

/* -------------------------------------------------------------------- state */

let DATA = null;

const state = {
  route: { name: 'home' },
  pendingAnchor: null, // 路由带板块锚点时，渲染完再滚过去
  media: new Set(), // empty = 全部画种
  ai: {
    query: '',
    status: 'idle', // idle | loading | done | empty | need-key | error
    answer: '',
    hits: [],
    error: '',
    via: '',
    model: '',
  },
  translate: {
    target: store.getItem('tk.translate.target') || 'en',
    status: 'idle', // idle | loading | done | empty | error
    message: '',
  },
};

const view = qs('#view');
const tabsEl = qs('#tabs');
const mediaRow = qs('#media-row');
const mediaBar = qs('#media');
const searchBox = qs('.search');
const hint = qs('#qhint');
const input = qs('#q');
const askButton = qs('#ask');

/* ------------------------------------------------------------------ helpers */

const mediumChip = (key, blank = false) =>
  `<span class="chip medium${key === 'period_level' ? ' is-period-level' : ''}${blank ? ' is-blank' : ''}"${
    blank ? ' title="此时期没有这类画种的技法描述"' : ''
  }>${esc(MEDIA_LABELS[key] ?? key)}${blank ? ` · ${BLANK}` : ''}</span>`;

/** A claim is visible when no filter is active, or when it speaks for a selected 画种. */
const visible = (claim) => {
  if (state.media.size === 0) return true;
  if (claim.medium.includes('period_level')) return true; // periodization is above 画种
  return claim.medium.some((medium) => state.media.has(medium));
};

function claimCard(claim, dimKey) {
  const grade = claim.grades.includes('C') && claim.grades.length === 1 ? 'C' : claim.grades[0] ?? '';
  const chips = [
    dimKey ? `<span class="chip">${esc(DIM_LABELS[dimKey]?.zh ?? dimKey)}</span>` : '',
    claim.medium.map((medium) => mediumChip(medium)).join(''),
    claim.not_applicable ? '<span class="chip warn">不适用</span>' : '',
    claim.grades.map((g) => `<span class="chip grade-${esc(g)}">${esc(g)} 级</span>`).join(''),
    `<span class="chip status-${esc(claim.status)}">${esc(STATUS_LABELS[claim.status] ?? claim.status)}</span>`,
    claim.confidence ? `<span class="chip conf-${esc(claim.confidence)}">置信 ${esc(CONF_LABELS[claim.confidence] ?? claim.confidence)}</span>` : '',
    claim.evidence.some((e) => e.unverified) ? '<span class="chip warn">出处待核验</span>' : '',
  ].join('');

  const evidence = claim.evidence
    .map(
      (e) => `
      <li>
        <span class="chip grade-${esc(e.grade)}">${esc(e.grade)}</span>
        <div>
          <p class="citation">${esc(e.citation)}</p>
          <p class="locator">${esc(e.locator)}${e.kind ? ` · ${esc(e.kind)}` : ''}</p>
          <blockquote>${esc(e.quote)}</blockquote>
          ${e.translation_zh ? `<p class="translation">${esc(e.translation_zh)}</p>` : ''}
          ${e.url ? `<a class="src-link" href="${esc(e.url)}" target="_blank" rel="noopener">来源页 ↗</a>` : ''}
        </div>
      </li>`,
    )
    .join('');

  const iiif = claim.iiif.length
    ? claim.iiif
        .map(
          (ref) =>
            `<div class="iiif-note">IIIF 局部 · ${esc(ref.workTitle)} · region ${esc(ref.region)}${ref.note_zh ? ` — ${esc(ref.note_zh)}` : ''}（manifest 待登记）</div>`,
        )
        .join('')
    : '';

  if (claim.not_applicable) {
    return `
    <article class="claim is-na">
      <span class="na-label">不适用 · not applicable</span>
      <p class="statement">${esc(claim.reason_zh)}</p>
      ${trLine(claim.reason_zh)}
      <div class="chips">${chips}</div>
      <details class="evidence">
        <summary>证据 ${claim.evidence.length} 条 · ${claim.evidence.map((e) => e.grade).join('')}</summary>
        <ol>${evidence}</ol>
      </details>
    </article>`;
  }

  return `
    <article class="claim" data-grade="${esc(grade)}">
      <p class="statement">${esc(claim.statement_zh)}</p>
      ${trLine(claim.statement_zh)}
      <div class="chips">${chips}</div>
      ${claim.note_zh ? `<p class="note">${esc(claim.note_zh)}</p>${trLine(claim.note_zh)}` : ''}
      <details class="evidence">
        <summary>证据 ${claim.evidence.length} 条 · ${claim.evidence.map((e) => e.grade).join('')}</summary>
        <ol>${evidence}</ol>
      </details>
      ${iiif}
    </article>`;
}

function claimList(list, dimKey) {
  const shown = list.filter(visible);
  if (!shown.length) {
    const filter = selectedMediaLabel();
    return `<p class="filter-note">${
      filter ? `${esc(filter)}：` : ''
    }这一项没有可显示的结论${filter ? `（${BLANK}）` : ''}。</p>`;
  }
  return `<div class="claims">${shown.map((claim) => claimCard(claim, dimKey)).join('')}</div>`;
}

function entryBlock(headline, pair, body) {
  return `<section class="entry">
    <div class="entry-head"><h3>${esc(headline)}</h3>${pair ? `<span class="pair">${esc(pair)}</span>` : ''}</div>
    ${body}
  </section>`;
}

function pairBlock(left, right) {
  return `<dl class="pair-block">
    <div><dt>对方在做什么</dt><dd>${esc(left)}</dd></div>
    <div><dt>他多出了什么</dt><dd>${esc(right)}</dd></div>
  </dl>`;
}

function flatten(dossier, dim) {
  const d = dossier.dimensions;
  switch (dim) {
    case 'period':
      return d.period;
    case 'lineage':
      return d.lineage.flatMap((e) => e.claims);
    case 'comparison':
      return d.comparison.flatMap((e) => e.claims);
    case 'material':
      return d.material.claims;
    case 'composition':
      return Object.values(d.composition).flatMap((f) => f.claims);
    case 'subject_matter':
      return d.subject_matter.claims;
    default:
      return [];
  }
}

function countDim(dossier, dim) {
  // 选中的画种在这一期完全没有条目：整页按空白处理，连「全期共用」的时期判断也不冒充该画种的内容。
  if (state.media.size > 0 && ![...state.media].some((medium) => mediaCount(dossier, medium) > 0)) return 0;
  return flatten(dossier, dim).filter(visible).length;
}

/** 概览页用的固定覆盖数：不跟当前画种筛选变，永远显示这一期的真实覆盖。 */
function countDimAll(dossier, dim, medium = null) {
  return flatten(dossier, dim).filter((claim) => (medium ? claim.medium.includes(medium) : true)).length;
}

function countCategory(dossier) {
  return DATA.dims.reduce((total, dim) => total + countDim(dossier, dim), 0);
}

/* ------------------------------------------------------------------ routing */

/** 旧路由里的单个维度（#/artist/<id>/composition）现在都落到「六维档案」页的对应板块。 */
function resolveArtistTab(raw, anchorRaw) {
  if (raw === 'sources') return { tab: 'sources', anchor: '' };
  if (raw === 'dimensions') {
    return { tab: 'dimensions', anchor: DIM_ORDER.includes(anchorRaw) ? anchorRaw : '' };
  }
  if (DIM_ORDER.includes(raw)) return { tab: 'dimensions', anchor: raw };
  return { tab: 'overview', anchor: '' };
}

/** 解析一个 hash（不读 location），这样点击链接时可以先算好路由再决定地址怎么更新。 */
function parseHash(rawHash) {
  const raw = String(rawHash ?? '').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'sources') return { name: 'sources' };
  if (parts[0] === 'images') return { name: 'images' };
  if (parts[0] === 'artist' && parts[1]) {
    const id = decodeURIComponent(parts[1]);
    // #/artist/schiele/<period>/<tab>/<anchor>：第二段只有确实是这位画家的分期 slug 时才当分期，
    // 否则仍按旧链接理解成 tab，老书签不会失效。
    const maybePeriod = parts[2] ? decodeURIComponent(parts[2]) : '';
    const period = maybePeriod && dossierByPeriod(id, maybePeriod) ? maybePeriod : null;
    const rest = (period ? parts.slice(3) : parts.slice(2)).map((part) => decodeURIComponent(part));
    const { tab, anchor } = resolveArtistTab(rest[0] ?? 'overview', rest[1] ?? '');
    return { name: 'artist', id, period, tab, anchor };
  }
  return { name: 'home' };
}

function parseRoute() {
  return parseHash(location.hash);
}

const artistHref = (id, tab = 'overview', period = null, anchor = null) => {
  const base = `#/artist/${encodeURIComponent(id)}${period ? `/${encodeURIComponent(period)}` : ''}`;
  if (tab === 'overview') return base;
  return `${base}/${encodeURIComponent(tab)}${anchor ? `/${encodeURIComponent(anchor)}` : ''}`;
};

/**
 * 内部导航：先按目标 hash 直接渲染，再尽量把地址栏换成可分享的样子。
 *
 * 不把「改地址 → 等 hashchange」当成唯一通路：DSH 预览、file:// 单文件、带 sandbox 的 iframe
 * 里，pushState / hashchange 可能被禁或失效，只靠它们会出现「点了没反应」。这里内容先切过去，
 * 地址栏改不了也不影响阅读；浏览器里的前进 / 后退由 popstate 接。
 */
function go(hash) {
  const next = String(hash ?? '').startsWith('#') ? String(hash) : `#${hash ?? ''}`;
  if (location.hash !== next) {
    try {
      history.pushState(null, '', next);
    } catch {
      /* 地址栏改不了就只换内容 */
    }
  }
  state.route = parseHash(next);
  state.pendingAnchor = state.route.anchor || null;
  canonicalizeRoute();
  render();
  if (!state.pendingAnchor) window.scrollTo({ top: 0 });
}

const artists = () => DATA?.artists ?? [];
const artistById = (id) => artists().find((a) => a.id === id) ?? null;
const dossiersOf = (id) => (DATA?.dossiers ?? []).filter((d) => d.artist.id === id);
/* 默认打开哪一期：条目最多的那一期。分期切换条仍按时间顺序排。 */
const primaryDossier = (id) =>
  dossiersOf(id).reduce((best, d) => ((d.stats?.claims ?? 0) > (best?.stats?.claims ?? -1) ? d : best), null);

/* 一位画家可以有多个分期档案。路由里用档案 id 去掉画家前缀后的那段当 slug。 */
const periodSlug = (dossier) =>
  dossier.id.startsWith(`${dossier.artist.id}.`) ? dossier.id.slice(dossier.artist.id.length + 1) : dossier.id;
const dossierByPeriod = (artistId, slug) => dossiersOf(artistId).find((d) => periodSlug(d) === slug) ?? null;
const currentDossier = (route) => (route?.period ? dossierByPeriod(route.id, route.period) : null) ?? primaryDossier(route?.id);

/* -------------------------------------------------------------- home · index */

function renderIndex() {
  const withDossier = artists().filter((a) => a.hasDossier);
  const pending = artists().filter((a) => !a.hasDossier);
  const ordered = [...withDossier, ...pending];

  const tiles = ordered
    .map((artist) => {
      const dossier = primaryDossier(artist.id);
      const years = [artist.birth_year, artist.death_year].filter(Boolean).join('–');
      const roles = (artist.roles ?? []).map((r) => ({ painter: '画家', draughtsman: '素描', printmaker: '版画' }[r] ?? r)).join(' / ');
      const own = dossiersOf(artist.id);
      const lines = dossier
        ? `${own.length} 份档案 · ${own.reduce((n, d) => n + (d.stats?.claims ?? 0), 0)} 条结论 · ${new Set(own.flatMap((d) => d.media?.declared ?? [])).size} 个画种`
        : '登记在册 · 档案建设中';
      return `
      <a class="artist-tile${dossier ? '' : ' is-pending'}" href="${artistHref(artist.id)}">
        <span class="tile-dates">${esc(years || '—')}</span>
        <h3>${esc(artist.zh)}</h3>
        <p class="tile-en">${esc(artist.en)}</p>
        <p class="tile-meta">${esc([artist.nationality?.[0], roles].filter(Boolean).join(' · '))}</p>
        <p class="tile-status">${esc(lines)}</p>
      </a>`;
    })
    .join('');

  const c = DATA.counts;
  const samples = [
    '席勒的线条为什么是断的？',
    '1912 年新伦巴赫发生了什么',
    '他受过克林姆哪些影响',
    '纸上素描和油画的取景差别',
  ];

  return `
  <p class="section-title">画家索引 · artists</p>
  <p class="home-lede">主页只放索引：这里是登记在册的画家，点进去才是他的分期与六维目录。
    目前 ${c.dossiers} 份档案、${c.claims} 条 claim，每条都能追到来源。</p>
  <div class="index-grid">${tiles}</div>

  <p class="section-title" style="margin-top:44px">登记表 · registry</p>
  <div class="stat-row">
    <div class="stat"><span class="num">${c.artists}</span><span class="lbl">画家</span></div>
    <div class="stat"><span class="num">${c.dossiers}</span><span class="lbl">档案</span></div>
    <div class="stat"><span class="num">${c.claims}</span><span class="lbl">claims</span></div>
    <div class="stat"><span class="num">${c.works}</span><span class="lbl">作品</span></div>
    <div class="stat"><span class="num">${c.sources}</span><span class="lbl">来源</span></div>
  </div>
  <p class="registry-links"><a href="#/sources">全部来源登记 →</a> · <a href="#/images">图片区 →</a></p>

  <p class="section-title" style="margin-top:44px">可以这样问 · ask</p>
  <div class="ask-samples">${samples.map((q) => `<button type="button" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
}

/* --------------------------------------------------------------- artist page */

function renderPeriodSwitch(artist, active, route) {
  const periods = dossiersOf(artist.id);
  if (periods.length < 2) return '';
  const tab = route?.tab && route.tab !== 'overview' ? route.tab : 'overview';
  const anchor = route?.anchor || null;
  const items = periods
    .map((dossier) => {
      const slug = periodSlug(dossier);
      const on = dossier.id === active?.id;
      return `<a class="period-chip${on ? ' is-on' : ''}" href="${artistHref(artist.id, tab, slug, anchor)}"${
        on ? ' aria-current="page"' : ''
      }><b>${esc(dossier.period.start_year)}–${esc(dossier.period.end_year)}</b>${esc(dossier.period.label.zh)}
        <span class="n">${dossier.stats?.claims ?? 0}</span></a>`;
    })
    .join('');
  return `<nav class="period-switch" aria-label="分期">${items}</nav>`;
}

function trToolbar() {
  const options = TR_TARGETS.map(
    (item) => `<option value="${item.key}"${item.key === state.translate.target ? ' selected' : ''}>${esc(item.label)}</option>`,
  ).join('');
  const offline = Boolean(window.__TK_OFFLINE__);
  const label = state.translate.status === 'loading' ? '翻译中…' : 'AI 翻译';
  return `<div class="translate-bar">
    <button type="button" class="tr-run" data-tr-run${offline ? ' disabled' : ''}${
      offline ? ' title="离线单文件没有服务器，接不上翻译"' : ''
    }>${esc(label)}</button>
    <label class="tr-pick">译成 <select class="tr-lang" aria-label="译文语言">${options}</select></label>
    <span class="tr-status" aria-live="polite">${esc(state.translate.message)}</span>
  </div>`;
}

function renderArtistHero(artist, dossier, route) {
  const years = [artist.birth_year, artist.death_year].filter(Boolean).join('–');
  const places = [artist.birth_place_zh, artist.death_place_zh].filter(Boolean).join(' → ');
  const roles = (artist.roles ?? []).map((r) => ({ painter: '画家', draughtsman: '素描', printmaker: '版画' }[r] ?? r)).join(' / ');
  const period = dossier
    ? `<p class="period-line"><b>${esc(dossier.period.start_year)}–${esc(dossier.period.end_year)}</b> ${esc(dossier.period.label.zh)}
         <br />${esc(dossier.period.basis_zh)}</p>${trLine(dossier.period.basis_zh)}
       <div class="chips" style="margin-top:14px">${mediaList(dossier)
         .map((medium) => mediumChip(medium, mediaCount(dossier, medium) === 0))
         .join(' ')}</div>`
    : '';

  return `
  <nav class="crumb"><a href="#/">← 画家索引</a></nav>
  <section class="artist-hero">
    <p class="hero-eyebrow">${esc([years, places || '', artist.nationality?.join(' / ') ?? ''].filter(Boolean).join(' · '))}</p>
    <h2>${esc(artist.zh)}</h2>
    <p class="romanised">${esc(artist.en)}${roles ? ` · ${esc(roles)}` : ''}</p>
    ${renderPeriodSwitch(artist, dossier, route)}
    ${dossier ? trToolbar() : ''}
    ${period}
    ${artist.notes_zh ? `<p class="hero-note">${esc(artist.notes_zh)}</p>` : ''}
  </section>`;
}

function renderPending(artist) {
  const dossierHint = DATA.dossiers.length
    ? `要建一份新档案，先看 <code>data/dossiers/</code> 里已有的一份，照它的六维结构写。`
    : '';
  return `
  ${renderArtistHero(artist, null, state.route)}
  <section class="empty-card">
    <h3>档案尚未建立</h3>
    <p>这位画家在 <code>data/registry/artists.yaml</code> 里登记了，但还没有写 dossier。
       没有 dossier，就没有可引用的结论——这个库宁可不显示，也不拿模型记忆填格子。</p>
    <p>${dossierHint}</p>
    <p class="filter-note">需要：一份 <code>data/dossiers/${esc(artist.id)}/&lt;时期&gt;.yaml</code>，六维 × 每个声明的画种都要有答案。</p>
  </section>`;
}

/** 档案还没建时，三个顶层页照样给一页，说清楚这一格为什么是空的。 */
function renderPendingDimension(artist, tab) {
  const label = TAB_LABELS[tab] ?? tab;
  return `
  ${renderArtistHero(artist, null, state.route)}
  <section class="empty-card">
    <h3>${esc(label)} · 暂无条目</h3>
    <p>这一页要等 <code>data/dossiers/${esc(artist.id)}/&lt;时期&gt;.yaml</code> 建起来才有内容。
       空着不是编辑偷懒：六个维度里任何一格没有证据支撑的结论，<code>scripts/validate.mjs</code> 都会报错。</p>
    <p><a href="#/artist/${esc(artist.id)}">回到概览</a> · <a href="#/">看别的画家</a></p>
  </section>`;
}

function renderOverview(dossier) {
  const s = dossier.stats;
  const anchors = dossier.period.anchors
    .map((a) => `<li><span class="year">${esc(a.year)}${a.month_day ? `-${esc(a.month_day)}` : ''}</span><span>${esc(a.event_zh)}</span></li>`)
    .join('');

  const categories = [
    { key: null, label: '全部', sub: 'all media', count: s.claims },
    ...mediaList(dossier).map((medium) => ({
      key: medium,
      label: MEDIA_LABELS[medium] ?? medium,
      sub: medium,
      count: mediaCount(dossier, medium),
    })),
  ];

  const blocks = categories
    .map((category) => {
      const blankMedium = Boolean(category.key) && category.count === 0;
      const cells = DATA.dims
        .map((dim) => {
          const head = `<span class="dim-en">${esc(DIM_LABELS[dim].en)}</span>
            <span class="dim-name">${esc(DIM_LABELS[dim].zh)}</span>`;
          if (dim === 'period' && category.key) {
            return `<div class="dim-cell is-static${blankMedium ? ' is-blank' : ''}"${
              blankMedium ? '' : ` data-goto="dimensions" data-anchor="${dim}"`
            }>
              ${head}
              <span class="dim-count">${blankMedium ? BLANK : `全期共用 · ${dossier.dimensions.period.length} 条`}</span>
            </div>`;
          }
          const n = countDimAll(dossier, dim, category.key);
          return `<div class="dim-cell${n ? '' : ' is-empty'}${blankMedium ? ' is-blank' : ''}" data-goto="dimensions" data-anchor="${dim}" data-medium="${esc(category.key ?? '')}">
            ${head}
            <span class="dim-count">${blankMedium ? BLANK : n ? `${n} 条结论` : '暂无'}</span>
          </div>`;
        })
        .join('');

      const selectedBlock = category.key ? state.media.has(category.key) : state.media.size === 0;
      return `<section class="media-block${blankMedium ? ' is-blank' : ''}${selectedBlock ? ' is-on' : ''}">
        <div class="media-block-head">
          <h3>${esc(category.label)}</h3>
          <span class="media-block-sub">${esc(category.sub)} · ${blankMedium ? BLANK : `${category.count} 条`}</span>
        </div>
        ${blankMedium ? `<p class="media-blank">此时期没有${esc(category.label)}的技法描述（${BLANK}）。</p>` : ''}
        <div class="dim-grid">${cells}</div>
      </section>`;
    })
    .join('');

  const works = dossier.works?.length
    ? `<p class="section-title">所引作品 · works</p>
       <div class="work-grid">${dossier.works
         .map(
           (w) => `<div class="work">
             <span class="work-year">${esc(w.year ?? '—')}</span>
             <h4>${esc(w.title.zh)}</h4>
             <p class="work-meta">${esc(
               [
                 MEDIA_LABELS[w.medium_category] ?? w.medium_category,
                 SUPPORT_LABELS[w.support] ?? w.support,
                 [w.collection?.institution, w.collection?.city].filter(Boolean).join(' · '),
               ]
                 .filter(Boolean)
                 .join(' · '),
             )}</p>
             ${w.attribution && w.attribution !== 'autograph' ? `<p class="work-flag">归属：${esc(w.attribution)}</p>` : ''}
           </div>`,
         )
         .join('')}</div>`
    : '';

  return `
  <div class="stat-row">
    <div class="stat"><span class="num">${s.claims}</span><span class="lbl">claims</span></div>
    <div class="stat"><span class="num">${mediaList(dossier).filter((medium) => mediaCount(dossier, medium) > 0).length} / ${mediaList(dossier).length}</span><span class="lbl">画种覆盖</span></div>
    <div class="stat"><span class="num">${s.signed}</span><span class="lbl">已签字</span></div>
    <div class="stat"><span class="num">${s.grades.A ?? 0}</span><span class="lbl">A 级证据</span></div>
    <div class="stat"><span class="num">${s.notApplicable ?? 0}</span><span class="lbl">不适用</span></div>
    <div class="stat"><span class="num">${s.unverifiedLocators}</span><span class="lbl">出处待核验</span></div>
  </div>

  <p class="section-title">按画种分类 · by medium</p>
  <p class="filter-note">固定列出油画 / 纸上彩色 / 纸上素描 / 版画；这一期没有这类条目的画种整块标「空白」，不隐藏。</p>
  ${blocks}

  <p class="section-title">分期锚点 · anchors</p>
  <ul class="anchors">${anchors}</ul>

  ${works}

  ${
    dossier.open_questions.length
      ? `<p class="section-title">尚未回答 · open questions</p>${dossier.open_questions
          .map(
            (q) =>
              `<div class="open-q"><h4>${esc(q.question_zh)}</h4><p>${esc(q.why_open_zh)}${q.needs?.length ? ` · 需要 ${esc(q.needs.join('/'))} 级来源` : ''}</p></div>`,
          )
          .join('')}`
      : ''
  }`;
}

/** 当前画种筛选命中的 claim 实际引用了哪些来源。没选画种时返回 null（= 整份档案）。 */
function sourceIdsForSelection(dossier) {
  if (!state.media.size) return null;
  const ids = new Set();
  for (const dim of DATA.dims) {
    for (const claim of flatten(dossier, dim)) {
      if (claim.medium.includes('period_level')) continue; // 时期判断不属于单一画种
      if (!claim.medium.some((medium) => state.media.has(medium))) continue;
      for (const evidence of claim.evidence) {
        if (evidence.sourceId) ids.add(evidence.sourceId);
      }
    }
  }
  return [...ids].sort();
}

/** 单个维度的正文。板块标题由「六维档案」页统一给出，这里只出内容。 */
function renderDimension(dossier, dim) {
  const d = dossier.dimensions;

  if (dim === 'period') {
    return claimList(d.period, 'period');
  }

  if (dim === 'lineage') {
    return d.lineage
      .map((entry) =>
        entryBlock(
          `${entry.counterpart} → ${dossier.artist.zh}`,
          `${RELATION_LABELS[entry.relation] ?? entry.relation}${entry.window ? ` · ${entry.window.from_year}–${entry.window.to_year ?? ''}` : ''}`,
          `<p class="summary-zh">${esc(entry.summary_zh)}</p>${trLine(entry.summary_zh)}
           <div class="chips">${entry.elements.map((el) => `<span class="chip">${esc(FIELD_LABELS[el] ?? el)}</span>`).join('')}</div>
           ${claimList(entry.claims, 'lineage')}`,
        ),
      )
      .join('');
  }

  if (dim === 'comparison') {
    return d.comparison
      .map((entry) =>
        entryBlock(
          `对比 · ${entry.counterpart}`,
          `轴：${FIELD_LABELS[entry.axis] ?? entry.axis}`,
          `${pairBlock(entry.their_practice_zh, entry.his_difference_zh)}${claimList(entry.claims, 'comparison')}`,
        ),
      )
      .join('');
  }

  if (dim === 'material') {
    const m = d.material;
    return `<dl class="pair-block">
        <div><dt>底材</dt><dd>${esc(m.supports.map((s) => SUPPORT_LABELS[s] ?? s).join(' / ') || '—')}</dd></div>
        <div><dt>媒介</dt><dd>${esc((m.mediums ?? []).map((s) => DRAWING_MEDIUM_LABELS[s] ?? s).join(' / ') || '—')}</dd></div>
      </dl>
      ${m.process_zh ? `<p class="summary-zh">${esc(m.process_zh)}</p>${trLine(m.process_zh)}` : ''}
      ${claimList(m.claims, 'material')}`;
  }

  if (dim === 'composition') {
    return DATA.composition_fields
      .map((field) => {
        const block = d.composition[field];
        return entryBlock(
          FIELD_LABELS[field] ?? field,
          `composition.${field}`,
          `${block.summary_zh ? `<p class="summary-zh">${esc(block.summary_zh)}</p>${trLine(block.summary_zh)}` : ''}${claimList(block.claims, 'composition')}`,
        );
      })
      .join('');
  }

  const sm = d.subject_matter;
  return `<div class="chips">${sm.motifs.map((m) => `<span class="chip">${esc(MOTIF_LABELS[m] ?? m)}</span>`).join('')}</div>
    ${sm.rationale_zh ? `<p class="summary-zh">${esc(sm.rationale_zh)}</p>${trLine(sm.rationale_zh)}` : ''}
    ${claimList(sm.claims, 'subject_matter')}`;
}

/**
 * 「本页提到的作品」：六维页下方单独列一块，每条都能跳到馆方对象页看高清图。
 *
 * 只列**真的在本页出现**的作品，两种来源：
 *   1) 某条 claim 的 iiif_evidence 指向它（本页有局部图证）；
 *   2) 某条 claim 的正文/引文里写着它的名字（含去括号的简称、英文名）。
 * 链接只给馆方对象页或 IIIF 清单，图像字节既不入库也不重托管。
 */
function workNames(work) {
  const names = new Set();
  const zh = String(work.title?.zh ?? '');
  if (zh) {
    names.add(zh);
    const bare = zh.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
    if (bare.length >= 3) names.add(bare);
  }
  for (const key of ['en', 'de']) {
    const value = String(work.title?.[key] ?? '');
    if (value.length >= 8) names.add(value);
  }
  return [...names];
}

function worksMentionedIn(dossier) {
  const rows = (dossier.works ?? []).map((work) => ({ work, cited: false, mentions: 0 }));
  if (!rows.length) return [];
  const byId = new Map(rows.map((row) => [row.work.id, row]));

  for (const dim of DATA.dims) {
    for (const claim of flatten(dossier, dim)) {
      for (const ref of claim.iiif ?? []) {
        const row = byId.get(ref.work);
        if (row) row.cited = true;
      }
      const text = [
        claim.statement_zh,
        claim.note_zh,
        claim.reason_zh,
        ...(claim.evidence ?? []).map((e) => `${e.translation_zh ?? ''} ${e.quote ?? ''}`),
      ]
        .filter(Boolean)
        .join(' ');
      for (const row of rows) {
        if (workNames(row.work).some((name) => text.includes(name))) row.mentions += 1;
      }
    }
  }
  return rows.filter((row) => row.cited || row.mentions > 0);
}

function renderWorksBlock(dossier) {
  const rows = worksMentionedIn(dossier);
  if (!rows.length) return '';

  const items = rows
    .map(({ work, cited, mentions }) => {
      const objectUrl = work.object?.url ?? null;
      const imageUrl = work.image?.url ?? null;
      const manifest = work.iiif?.manifest ?? null;
      // 主链接：馆方对象页 → 免费图片页 → IIIF 清单。次链接只在「馆方页也在、图片页也在」时出现，
      // 因为有些馆方站会对读者地区/付费/自动化访问设限，多给一条能打开的。
      const primary = objectUrl
        ? { href: objectUrl, label: '原馆对象页' }
        : imageUrl
          ? { href: imageUrl, label: '图片页' }
          : manifest
            ? { href: manifest, label: 'IIIF 清单' }
            : null;
      const secondary = objectUrl && imageUrl ? { href: imageUrl, label: '图片页' } : null;
      const meta = [work.year, MEDIA_LABELS[work.medium_category] ?? work.medium_category, work.collection?.institution]
        .filter(Boolean)
        .join(' · ');
      const tags = [cited ? '本页有局部图证' : '', mentions ? `正文提到 ${mentions} 处` : ''].filter(Boolean).join(' · ');
      const inner = `<span class="work-title">${esc(work.title.zh)}<em>${esc(work.title.en)}</em></span>
        <span class="work-meta">${esc(meta)}</span>
        <span class="work-tag">${esc(tags)}</span>`;
      if (!primary) {
        return `<div class="work-row is-missing">${inner}<span class="work-link">图片链接待补</span></div>`;
      }
      const links = [primary, secondary]
        .filter(Boolean)
        .map(
          (link, index) =>
            `<a class="work-link${index ? ' is-alt' : ''}" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)} ↗</a>`,
        )
        .join('');
      return `<div class="work-row">${inner}<span class="work-links">${links}</span></div>`;
    })
    .join('');

  return `<p class="section-title">本页提到的作品 · ${rows.length}</p>
    <div class="works-block">${items}</div>
    <p class="filter-note">作品名后的链接只跳馆方对象页或免费图片页：图像不入库、不重托管；打不开或要付费的馆方页会另给一条图片页。</p>`;
}

/**
 * 图片区（#/images）：站内所有板块引用过的作品图片链接，独立成一页。
 * 只汇总指针——馆方对象页 / 免费图片页 / IIIF 清单；图像不入库、不重托管。
 */
function renderImageIndex() {
  const groups = DATA.dossiers
    .map((dossier) => ({
      dossier,
      works: (dossier.works ?? []).filter((work) => work.object?.url || work.image?.url || work.iiif?.manifest),
    }))
    .filter((group) => group.works.length);

  const allWorks = groups.flatMap((group) => group.works);
  const linkCount = allWorks.reduce(
    (total, work) => total + (work.object?.url ? 1 : 0) + (work.image?.url ? 1 : 0) + (work.iiif?.manifest ? 1 : 0),
    0,
  );
  const mediaCount = new Set(allWorks.map((work) => work.medium_category).filter(Boolean)).size;

  const linksOf = (work) => {
    const links = [];
    if (work.object?.url) links.push({ href: work.object.url, label: '原馆对象页' });
    if (work.image?.url) links.push({ href: work.image.url, label: '图片页' });
    if (work.iiif?.manifest) links.push({ href: work.iiif.manifest, label: 'IIIF 清单' });
    if (!links.length) return '<span class="work-link">图片链接待补</span>';
    return links
      .map(
        (link, index) =>
          `<a class="work-link${index ? ' is-alt' : ''}" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)} ↗</a>`,
      )
      .join('');
  };

  const blocks = groups
    .map(({ dossier, works }) => {
      const rows = works
        .map((work) => {
          const meta = [work.year, MEDIA_LABELS[work.medium_category] ?? work.medium_category, work.collection?.institution]
            .filter(Boolean)
            .join(' · ');
          return `<div class="work-row">
            <span class="work-title">${esc(work.title.zh)}<em>${esc(work.title.en)}</em></span>
            <span class="work-meta">${esc(meta)}</span>
            <span class="work-links">${linksOf(work)}</span>
          </div>`;
        })
        .join('');
      return `<p class="section-title">${esc(dossier.period.label.zh)} · ${esc(dossier.period.start_year)}–${esc(
        dossier.period.end_year,
      )} · ${works.length}</p>
        <div class="works-block">${rows}</div>`;
    })
    .join('');

  return `<section class="images-page">
    <h2 class="page-title">图片区<span class="page-title-sub">Images</span></h2>
    <p class="home-lede">这里汇总站内各板块引用过的全部作品图片链接：<b>${allWorks.length}</b> 件作品、<b>${linkCount}</b> 条链接、覆盖 ${mediaCount} 个画种。
      点开即跳馆方对象页或免费图片页；图像不落库、不重托管，版权与访问条件由来源方决定。</p>
    ${blocks || '<p class="empty-card">还没有任何作品图片链接。</p>'}
  </section>`;
}

/** 六维档案：时期 / 师从与影响 / 对比与创新 / 媒介与材料 / 画面构成 / 题材，六个板块共用一页。 */
function renderDimensions(dossier, anchor) {  const blankFilter = state.media.size > 0 && [...state.media].every((medium) => mediaCount(dossier, medium) === 0);
  const blankBanner = blankFilter
    ? `<p class="blank-banner">此时期没有${esc(selectedMediaLabel())}的技法描述（${BLANK}）。下面的六个板块是空的。</p>`
    : '';

  const jumps = DIM_ORDER.map((dim) => {
    const n = countDim(dossier, dim);
    return `<button type="button" class="jump${anchor === dim ? ' is-on' : ''}" data-jump="${dim}" aria-current="${
      anchor === dim ? 'true' : 'false'
    }">${esc(DIM_LABELS[dim].zh)} <span class="n">${n}</span></button>`;
  }).join('');

  const sections = DIM_ORDER.map((dim) => {
    const n = countDim(dossier, dim);
    return `<section class="dim-section" id="dim-${dim}">
      <header class="dim-head">
        <div>
          <h2>${esc(DIM_LABELS[dim].zh)}</h2>
          <p class="dim-note">${esc(DIM_NOTES[dim])}</p>
        </div>
        <div class="dim-meta">
          <span class="dim-en">${esc(DIM_LABELS[dim].en)}</span>
          <span class="dim-n">${n} 条结论</span>
        </div>
      </header>
      ${blankFilter ? '' : renderDimension(dossier, dim)}
    </section>`;
  }).join('');

  return `${blankBanner}<nav class="doc-jump" aria-label="六维目录">
      <span class="doc-jump-label">本页 · 六维</span>
      ${jumps}
    </nav>${sections}`;
}

const raf = (callback) =>
  typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 0);

/** 滚到某个板块，并把地址栏换成可分享的深链接（不触发 hashchange 重渲染）。 */
function focusDimension(dim, { smooth = true, updateHash = true } = {}) {
  const target = document.getElementById(`dim-${dim}`);
  if (!target) return;
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
  }
  for (const button of document.querySelectorAll('[data-jump]')) {
    const on = button.dataset.jump === dim;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-current', on ? 'true' : 'false');
  }
  if (updateHash && state.route.name === 'artist') {
    state.route = { ...state.route, anchor: dim };
    const href = artistHref(state.route.id, 'dimensions', state.route.period, dim);
    if (location.hash !== href) replaceHash(href);
  }
}

/** 改地址栏但不触发重渲染。单文件离线版在 file:// 下可能禁止改历史记录，失败就算了。 */
function replaceHash(href) {
  try {
    history.replaceState(null, '', href);
  } catch {
    /* 滚到位置就够了 */
  }
}

/** 旧链接（#/artist/<id>/<dim>）落地后把地址栏换成新的深链接，分享出去不再带旧格式。 */
function canonicalizeRoute() {
  if (state.route.name !== 'artist') return;
  const href = artistHref(state.route.id, state.route.tab, state.route.period, state.route.anchor || null);
  if (location.hash !== href) replaceHash(href);
}

/** 深链接进来时，等一帧再滚：这时样式与字体已经排好，不会滚偏。 */
function settlePendingAnchor() {
  const anchor = state.pendingAnchor;
  state.pendingAnchor = null;
  if (!anchor) return;
  raf(() => {
    if (state.route.anchor === anchor) focusDimension(anchor, { smooth: false, updateHash: false });
  });
}

function renderSources(ids, { filterLabel = '', emptyNote = '' } = {}) {
  const pool = ids ? DATA.sources.filter((s) => ids.includes(s.id)) : DATA.sources;
  const scope = filterLabel ? ` · ${filterLabel}` : '';
  const heading = ids ? `来源登记 · 本页引用 ${pool.length} 条${scope}` : `来源登记 · ${pool.length} 条`;
  if (!pool.length) {
    return `<p class="section-title">${esc(heading)}</p><p class="filter-note">${esc(
      emptyNote || '这份档案还没有引用任何来源。',
    )}</p>`;
  }
  const sorted = [...pool].sort((a, b) => String(a.grade).localeCompare(String(b.grade)));
  return `<p class="section-title">${esc(heading)}</p>
    <div class="claims">${sorted
      .map(
        (s) => `<article class="claim" data-grade="${esc(s.grade)}">
        <p class="statement">${esc(s.citation)}</p>
        <div class="chips">
          <span class="chip grade-${esc(s.grade)}">${esc(s.grade)} 级</span>
          ${s.class ? `<span class="chip chip-class">${esc(s.class)} 类</span>` : ''}
          <span class="chip">${esc(KIND_LABELS[s.kind] ?? s.kind)}</span>
          <span class="chip">${esc(LANG_LABELS[s.lang] ?? s.lang)}</span>
        </div>
        ${s.note_zh ? `<p class="note">${esc(s.note_zh)}</p>` : ''}
        ${s.url ? `<a class="src-link" href="${esc(s.url)}" target="_blank" rel="noopener">来源页 ↗</a>` : ''}
      </article>`,
      )
      .join('')}</div>`;
}

/* --------------------------------------------------------------- navigation */

function renderTabsFor(route) {
  if (!route || route.name !== 'artist') {
    tabsEl.hidden = true;
    return;
  }
  const dossier = currentDossier(route);
  const sourceCount = dossier
    ? state.media.size
      ? (sourceIdsForSelection(dossier) ?? []).length
      : (dossier.sourceIds ?? []).length
    : null;
  const items = [
    { key: 'overview', label: TAB_LABELS.overview, count: null },
    { key: 'dimensions', label: TAB_LABELS.dimensions, count: dossier ? countCategory(dossier) : null },
    { key: 'sources', label: TAB_LABELS.sources, count: sourceCount },
  ];
  tabsEl.innerHTML = items
    .map(
      (item) =>
        `<button type="button" data-tab="${item.key}" aria-selected="${item.key === route.tab}">${esc(item.label)}${
          item.count !== null ? ` <span class="count">${item.count}</span>` : ''
        }</button>`,
    )
    .join('');
  tabsEl.hidden = false;
}

function renderMediaBarFor(route) {
  const dossier = route?.name === 'artist' ? currentDossier(route) : null;
  if (!dossier) {
    mediaRow.hidden = true;
    mediaBar.innerHTML = '';
    return;
  }
  const items = mediaList(dossier);
  const allPressed = state.media.size === 0;
  mediaBar.innerHTML =
    `<button type="button" data-media="__all" aria-pressed="${allPressed}">全部</button>` +
    items
      .map((medium) => {
        const n = mediaCount(dossier, medium);
        const blank = n === 0;
        return `<button type="button" class="media-chip${blank ? ' is-blank' : ''}" data-media="${esc(medium)}" aria-pressed="${state.media.has(medium)}"${
          blank ? ' title="此时期没有这类画种的技法描述，选中后各维为空白"' : ''
        }>${esc(MEDIA_LABELS[medium] ?? medium)} <span class="n">${blank ? BLANK : n}</span></button>`;
      })
      .join('');
  mediaRow.hidden = false;
}

/* ------------------------------------------------------------------ AI 检索 */

const STOPWORDS = new Set(['什么', '怎么', '为什么', '如何', '哪些', '哪个', '是否', '以及', '还有', '一个', '这个', '那个', '我们', '他们']);
/** 画家名每一条都带，不能作为区分度；年份相同也不等于在讲同一个技法。 */
const ARTIST_TOKENS = new Set(['席勒', 'schiele']);
const LINE_QUERY = /线|轮廓|笔|描|断|裂/;

/** 中文问题里的同义扩展：不补充事实，只是让「断线/线条/轮廓」能互相召回。 */
const QUERY_EXPANSIONS = [
  {
    test: /断|裂|中断|不连续/,
    terms: ['断线', '断裂', '中断', '不连续', '复线', '叠线', '续线', '错误留在画面'],
  },
  {
    test: /线|轮廓|笔|描/,
    terms: ['线条', '轮廓', '用线', '一笔', '重描', '描线', '边缘', '笔法', '线描'],
  },
  {
    test: /1912/,
    terms: ['1912', '1911–1912', '1911-1912'],
  },
  // 中文问题要能命中库里的英文/德文引文与候选池原文（excerpt 基本是外文），
  // 否则「爬虫抓到的英文材料」永远不会出现在中文提问的上下文里。
  {
    test: /线|轮廓|笔|描/,
    terms: ['line', 'linear', 'contour', 'stroke', 'drawing', 'pencil', 'graphite'],
  },
  {
    test: /色|颜色|水彩|水粉|颜料/,
    terms: ['colour', 'color', 'watercolour', 'watercolor', 'gouache', 'palette', 'oil'],
  },
  {
    test: /构图|取景|画幅|裁切/,
    terms: ['composition', 'framing', 'crop', 'format'],
  },
  {
    test: /身体|人体|裸|姿态/,
    terms: ['body', 'nude', 'figure', 'pose'],
  },
  {
    test: /影响|师承|克林姆|老师/,
    terms: ['influence', 'klimt', 'academy', 'teacher'],
  },
  {
    test: /版画|印|蚀刻/,
    terms: ['print', 'lithograph', 'etching'],
  },
];

function queryTerms(query) {
  const lower = query.toLowerCase();
  const cleaned = lower.replace(/[\s，。、；：？！,.;:?!「」『』（）()《》〈〉…—\-_"'’“”]/g, '');
  const direct = new Set();
  for (let i = 0; i < cleaned.length - 1; i += 1) {
    const bigram = cleaned.slice(i, i + 2);
    if (/\d/.test(bigram) || STOPWORDS.has(bigram) || ARTIST_TOKENS.has(bigram)) continue;
    direct.add(bigram);
  }
  for (const latin of lower.match(/[a-z]{3,}/g) ?? []) {
    if (!ARTIST_TOKENS.has(latin)) direct.add(latin);
  }
  const years = [...new Set(lower.match(/(?:19|20)\d{2}/g) ?? [])];
  const aliases = new Set();
  for (const rule of QUERY_EXPANSIONS) {
    if (!rule.test.test(lower)) continue;
    for (const term of rule.terms) aliases.add(term);
  }
  return { direct: [...direct], aliases: [...aliases].filter((term) => !direct.has(term) && !years.includes(term)), years };
}

function countToken(haystack, token) {
  let count = 0;
  let at = haystack.indexOf(token);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(token, at + token.length);
  }
  return count;
}

/**
 * Lexical retrieval over every retrievable claim.
 *
 * 六维 claim 只是库里的一半事实：分期锚点（哪年发生了什么）和「尚未回答的问题」同样
 * 写在 YAML 里、页面上能读到。旧版只遍历 dimensions，所以问「1912 年新伦巴赫发生了什么」
 * 时，库里明明有「4 月 13 日被捕、关押二十四天」这条锚点，模型却收到「条目没有交代经过」，
 * 于是只能回答「现有条目不足以回答」。这里把三类条目放进同一个排序池，让模型看到的
 * 上下文与页面上能读到的内容一致。
 */
function retrieve(query, limit = 18) {
  const { direct, aliases, years } = queryTerms(query);
  if (!direct.length && !aliases.length && !years.length) return [];

  const rows = [];
  const haystackOf = (...parts) => parts.filter(Boolean).join(' ').toLowerCase();
  const evidenceText = (evidence) =>
    (evidence ?? []).map((e) => `${e.quote ?? ''} ${e.translation_zh ?? ''} ${e.citation ?? ''}`).join(' ');

  const lexical = (haystack) => {
    let score = 0;
    for (const token of direct) score += countToken(haystack, token) * 3;
    for (const token of aliases) score += countToken(haystack, token) * 1.5;
    for (const year of years) score += countToken(haystack, year) * 2;
    return score;
  };

  for (const dossier of DATA.dossiers) {
    const start = Number(dossier.period.start_year);
    const end = Number(dossier.period.end_year);

    // 1912 这类年份是范围线索：命中所在分期加高分，相邻分期保留一点上下文。
    let yearBias = 0;
    for (const year of years) {
      const value = Number(year);
      if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (value >= start && value <= end) yearBias += 6;
      else if (Math.min(Math.abs(value - start), Math.abs(value - end)) <= 1) yearBias += 2;
    }

    const dimBias = (dim) => {
      if (!LINE_QUERY.test(query)) return 0;
      if (dim === 'composition') return 2;
      if (dim === 'material') return 1;
      if (dim === 'lineage') return 1;
      return 0;
    };

    for (const dim of DATA.dims) {
      for (const claim of flatten(dossier, dim)) {
        if (claim.not_applicable) continue;
        const haystack = haystackOf(
          claim.statement_zh,
          claim.note_zh,
          evidenceText(claim.evidence),
          DIM_LABELS[dim].zh,
          ...claim.medium.map((m) => MEDIA_LABELS[m] ?? m),
        );
        // 问题点了年份、条目却不在那一期：保留但降权，免得拿晚期对照条目冒充本期依据。
        const offPeriod = years.length && yearBias === 0 ? 0.7 : 1;
        const score = (lexical(haystack) + yearBias + dimBias(dim)) * offPeriod;
        if (score > 0) rows.push({ dossier, dim, claim, score, kind: 'claim', label: DIM_LABELS[dim].zh });
      }
    }

    // 分期锚点：问「发生了什么 / 为什么会变」时，事件时间线才是直接答案。
    for (const anchor of dossier.period.anchors ?? []) {
      const stamp = anchor.month_day ? `${anchor.year}-${anchor.month_day}` : String(anchor.year);
      const haystack = haystackOf(anchor.event_zh, evidenceText(anchor.evidence), dossier.period.label?.zh, stamp);
      const score = lexical(haystack) + Math.round(yearBias * 1.5) + 2;
      if (score > 2) {
        rows.push({
          dossier,
          dim: 'period',
          kind: 'anchor',
          label: `时期锚点 ${stamp}`,
          score,
          claim: {
            statement_zh: anchor.event_zh,
            note_zh: null,
            evidence: anchor.evidence ?? [],
            medium: ['period_level'],
            grades: [...new Set((anchor.evidence ?? []).map((e) => e.grade))],
            confidence: 'medium',
            status: 'draft',
          },
        });
      }
    }

    // 「尚未回答的问题」：让模型能说清这一问缺什么，而不是笼统说条目不够。
    for (const open of dossier.open_questions ?? []) {
      const haystack = haystackOf(open.question_zh, open.why_open_zh);
      const score = Math.round(lexical(haystack) * 0.9);
      if (score >= 6) {
        rows.push({
          dossier,
          dim: 'period',
          kind: 'open',
          label: '尚未回答的问题',
          score,
          claim: {
            statement_zh: open.question_zh,
            note_zh: open.why_open_zh,
            evidence: [],
            medium: ['period_level'],
            grades: [],
            confidence: null,
            status: 'draft',
          },
        });
      }
    }
  }

  // 候选池：每周抓取 + 初筛通过的原文材料。还不是 claim，但「抓到了却答不出」正是要修的病。
  for (const row of DATA.inbox ?? []) {
    const text = haystackOf(row.title, row.excerpt, row.publisher, row.published, row.kind);
    const score = Math.round(lexical(text) * 0.8);
    if (score >= 6) {
      rows.push({
        dossier: { id: 'inbox', artist: { id: 'inbox', zh: '候选池' }, period: {} },
        dim: 'period',
        kind: 'inbox',
        label: [row.kind ?? '原文', row.class ? `${row.class} 级` : '', row.published].filter(Boolean).join(' · '),
        score,
        claim: {
          statement_zh: `${row.title}${row.excerpt ? `：${String(row.excerpt).slice(0, 260)}` : ''}`,
          note_zh: row.reason_zh ? `初筛理由：${row.reason_zh}` : null,
          evidence: [{ quote: row.excerpt ?? '', citation: [row.publisher, row.published].filter(Boolean).join(' · '), url: row.url, grade: row.class, unverified: false }],
          medium: [],
          grades: row.class ? [row.class] : [],
          confidence: 'low',
          status: 'candidate',
          url: row.url,
        },
      });
    }
  }

  rows.sort((a, b) => b.score - a.score);
  const top = rows[0]?.score ?? 0;
  const floor = Math.max(3, top * 0.18);
  const quotas = { anchor: 4, open: 1, inbox: 2 };
  const perBucket = new Map();
  const picked = [];
  for (const row of rows) {
    if (row.score < floor) break; // 已按分数降序，后面的只会更弱
    const key = `${row.kind}:${row.dossier.id}:${row.dim}`;
    const used = perBucket.get(key) ?? 0;
    if (used >= (quotas[row.kind] ?? 2)) continue;
    perBucket.set(key, used + 1);
    picked.push(row);
    if (picked.length >= limit) break;
  }
  return picked.map((row, index) => ({ ...row, ref: `S${index + 1}` }));
}

function buildMessages(query, hits) {
  const roster = artists()
    .map((a) => `${a.zh}（${a.en}，${a.birth_year ?? '?'}–${a.death_year ?? '?'}）`)
    .join('；');
  const lines = hits.map((hit) => {
    const claim = hit.claim;
    const media = (claim.medium ?? []).map((m) => MEDIA_LABELS[m] ?? m).join('/');
    const flags = [
      claim.grades?.length ? `${claim.grades.join('')} 级证据` : '',
      claim.confidence ? `置信${CONF_LABELS[claim.confidence] ?? claim.confidence}` : '',
      claim.evidence.some((e) => e.unverified) ? '出处待核验' : '',
      claim.status === 'signed' ? '已签字' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    // 关键细节常只存在于证据引文里（例如「1911–1912 用极硬铅笔，几乎看不见」），
    // 只给 statement 会让模型误以为条目没写原因。这里带上 1–2 条短引文。
    // 候选池条目的 statement 本身就是原文摘录，不再重复一遍，只补链接。
    const evidence =
      hit.kind === 'inbox'
        ? ''
        : claim.evidence
            .filter((e) => e.quote || e.translation_zh)
            .slice(0, 2)
            .map((e) => String(e.translation_zh || e.quote || '').slice(0, 180))
            .filter(Boolean)
            .join('；');
    const link = claim.url ? `\n    链接：${claim.url}` : '';
    const head = [`[${hit.ref}]`, hit.dossier.artist.zh, hit.label ?? DIM_LABELS[hit.dim].zh, media, flags]
      .filter(Boolean)
      .join(' · ');
    return `${head}：${claim.statement_zh}${claim.note_zh ? `（注：${claim.note_zh}）` : ''}${
      evidence ? `\n    证据：${evidence}` : ''
    }${link}`;
  });

  const system = [
    '你在检索一个「画家技法知识库」。下面给出的条目是唯一可用的事实来源。',
    '规则：',
    '1. 只能使用条目里的内容，不得补充外部知识，不得编造页码、引文、年份或作品名。',
    '2. 先正面回答「为什么」：第一句就是结论。即使条目没有一句直接因果句，也要把同一时期、同一画种、同一技法维度的多条条目组合起来，用「推断：」开头给出结论；不许把「现有条目不足以回答」放在开头。',
    '3. 只有在结论之后，才可以说哪一部分缺证据，并说明缺什么；条目里若有「尚未回答的问题」，直接把它作为缺口说出来。',
    '4. 标注「时期锚点」的是事件条目（哪年发生了什么），可以直接用来回答「发生了什么」「为什么会变」；标注「尚未回答的问题」的是库里还没解决的问题。',
    '5. 标注「候选池」的是每周抓取、AI 初筛判过可靠性的原文摘录，还没写成条目：可以用它说明「库里还没有结论，但候选池已有这篇材料这样说」，并给出链接；不要把它当成已核对过的技法结论。',
    '6. 如果问题里的前提和条目冲突（例如把叠线当成断线），先用一句话纠正前提，再给推断。',
    '7. 条目里标注「出处待核验」的，回答末尾用一句话提醒读者它尚未核验。',
    '8. 引用只写 [S1] 这样单独的编号，不要在方括号里夹任何文字；「出处待核验」的提醒不要塞进编号里。',
    '9. 年份相同不等于相关；优先同一时期、同一画种、同一技法维度的条目。',
    '10. 推断只能组合条目，不能写成条目直述；每条依据仍要标 [S#]。',
    '11. 用中文回答，控制在 320 字内，先给结论（直述或推断），再给要点，不要复述问题。',
    '',
    `知识库里的画家：${roster || '（暂无）'}`,
    '',
    '可选条目：',
    ...lines,
  ].join('\n');

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `${query}\n\n请先给出结论；如果只能从条目推断，请以「推断：」开头，不要只罗列资料。`,
    },
  ];
}

/**
 * 静态托管（GitHub Pages）对 POST /api/ai 的典型拒绝：404 没有这个路径、
 * 405 不允许多数方法、501 不支持、403 被网关拦。遇到这些说明「这里没有本地代理」，
 * 应该退回浏览器直连，而不是把它当成代理报错。
 */
const NO_PROXY_STATUS = new Set([403, 404, 405, 501]);

async function callDeepSeek(messages) {
  // 1) 本地预览服务器的代理：密钥留在服务端，浏览器看不到。
  let proxySaidNoKey = false;
  try {
    const response = await fetch('./api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok && payload?.ok && payload.content) {
      return { content: payload.content, via: 'proxy', model: payload.model ?? 'deepseek-chat' };
    }
    if (payload?.error === 'no-key') proxySaidNoKey = true;
    else if (response.ok) throw { code: 'EMPTY' };
    else if (!NO_PROXY_STATUS.has(response.status)) {
      // 把代理带上来的原因原样透出：502 多半是上游 DeepSeek 这次没答上来。
      const detail = payload?.detail ?? payload?.error ?? (payload ? '' : '代理返回的不是 JSON');
      throw { code: 'PROXY_ERROR', status: response.status, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
    }
    // 其余（404/405/501/403）= 这里没有本地代理，继续走直连
  } catch (error) {
    if (error?.code === 'PROXY_ERROR' || error?.code === 'EMPTY') throw error;
    // fetch 本身失败：在本机访问说明代理没起或被断开；静态托管上则继续尝试直连。
    const host = String(location.hostname || '');
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (isLocal) {
      throw { code: 'PROXY_ERROR', status: 0, detail: `连不上本地预览服务（${host}:${location.port || '?'}）：serve.mjs 没在跑，或刚重启过。` };
    }
  }

  // 2) 浏览器直连读者自己的端点：Key/base/model 都在 localStorage 里。
  const settings = llmSettings();
  if (!settings.key) throw { code: 'NO_KEY', viaProxy: proxySaidNoKey };

  let response;
  try {
    response = await fetch(llmEndpoint(settings), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.key}` },
      body: JSON.stringify({ model: settings.model, messages, temperature: 0.2, max_tokens: 900 }),
    });
  } catch (error) {
    throw { code: 'DIRECT_FAILED', baseUrl: settings.baseUrl, detail: String(error?.message ?? error) };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw { code: 'HTTP', status: response.status, detail: detail.slice(0, 200), baseUrl: settings.baseUrl };
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content ?? '';
  if (!content) throw { code: 'EMPTY' };
  return { content, via: 'direct', model: payload?.model ?? settings.model };
}

function errorText(error) {
  const asText = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  switch (error?.code) {
    case 'NO_KEY':
      return error?.viaProxy
        ? '本地预览服务没有读到 DEEPSEEK_KEY，浏览器里也还没存过 Key。点右上「设置 Key」填一个也行。'
        : '这个页面没有服务端代理（线上静态托管就是这样）：点右上「设置 Key」粘贴一次你自己的 Key 就能提问，Key 只存这台浏览器。';
    case 'HTTP': {
      let who = '模型端点';
      try {
        if (error.baseUrl) who = new URL(error.baseUrl).host;
      } catch {
        /* baseUrl 不是合法 URL 就用默认名字 */
      }
      return `${who} 返回 HTTP ${error.status}${error.detail ? `：${asText(error.detail)}` : ''}`;
    }
    case 'DIRECT_FAILED':
      return `连不上 ${error.baseUrl ?? '自定端点'}：${asText(error.detail).slice(0, 200)}。检查 Base URL、网络，或该端点是否允许浏览器直连（CORS）。`;
    case 'EMPTY':
      return '模型返回了空回答（这次没吐内容，重试一次通常就好）。';
    case 'PROXY_ERROR': {
      const where = error.status ? `HTTP ${error.status}` : '网络中断';
      const detail = asText(error.detail).slice(0, 240);
      const hint =
        error.status === 502
          ? '上游 DeepSeek 这次没答上来（超时 / 限流 / 网络抖动），点下面「重试」一般就好。'
          : error.status === 0
            ? '本地预览服务这会儿没响应。'
            : '';
      return [`本地代理请求失败（${where}）`, detail ? `：${detail}` : '', hint ? ` ${hint}` : ''].join('');
    }
    default:
      return `请求失败：${asText(error?.message) || asText(error?.code) || '未知错误'}（可重试）`;
  }
}

async function ask(query) {
  const question = query.trim();
  if (!question) return;
  if (!DATA) return;

  if (window.__TK_OFFLINE__) {
    state.ai = { query: question, status: 'error', answer: '', hits: [], error: '离线单文件版没有网络代理，AI 检索不可用。请双击 preview.cmd 启动本地服务后访问 http://localhost:4321。', via: '', model: '' };
    render();
    return;
  }

  const hits = retrieve(question);
  state.ai = { query: question, status: 'loading', answer: '', hits, error: '', via: '', model: '' };
  render();

  if (!hits.length) {
    state.ai.status = 'empty';
    render();
    return;
  }

  try {
    const result = await callDeepSeek(buildMessages(question, hits));
    state.ai.status = 'done';
    state.ai.answer = result.content;
    state.ai.via = result.via;
    state.ai.model = result.model;
  } catch (error) {
    state.ai.status = error?.code === 'NO_KEY' ? 'need-key' : 'error';
    state.ai.error = errorText(error);
  }
  render();
}

/* ---------------------------------------------------------------- AI render */

const AI_STATUS = {
  idle: '',
  loading: '正在检索条目并请 DeepSeek 回答…',
  done: '',
  empty: '没有命中任何条目',
  'need-key': '需要一次 API Key 配置',
  error: '检索失败',
};

function aiCite(hit) {
  if (!hit) return '<span class="cite">?</span>';
  // 候选池条目不是页面上的条目，只能指向原文链接。
  if (hit.kind === 'inbox') {
    return `<a class="cite" href="${esc(hit.claim.url ?? '#/')}" target="_blank" rel="noopener" title="${esc(hit.claim.statement_zh ?? '')}">${esc(hit.ref)}</a>`;
  }
  // 事件锚点与开放问题不在六维页里，落到该期的概览页（那里正好列出这两块）。
  const tab = hit.kind === 'claim' ? 'dimensions' : 'overview';
  const anchor = hit.kind === 'claim' ? hit.dim : null;
  return `<a class="cite" href="${artistHref(hit.dossier.artist.id, tab, periodSlug(hit.dossier), anchor)}" title="${esc(hit.claim.statement_zh ?? '')}">${esc(hit.ref)}</a>`;
}

function aiInline(text) {
  let html = esc(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 模型有时把提醒塞进编号里（[S4，出处待核验]），这种也要变成可点链接，附注单独显示。
  html = html.replace(/[\[【]\s*(S\d+)\s*([^\]]*?)\s*[\]】]/g, (match, ref, trail) => {
    const hit = state.ai.hits.find((item) => item.ref === ref);
    const cite = aiCite(hit);
    const note = String(trail ?? '').replace(/^[，,、·|/／\s]+/, '').trim();
    return note ? `${cite}<span class="cite-note">${esc(note)}</span>` : cite;
  });
  return html;
}

function aiAnswerHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph.split('\n').filter(Boolean);
      if (lines.length && lines.every((line) => /^[-*·]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${aiInline(line.replace(/^[-*·]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.length && lines.every((line) => /^\d+[.、]\s+/.test(line))) {
        return `<ol>${lines.map((line) => `<li>${aiInline(line.replace(/^\d+[.、]\s+/, ''))}</li>`).join('')}</ol>`;
      }
      return `<p>${lines.map(aiInline).join('<br />')}</p>`;
    })
    .join('');
}

function renderAiPanel() {
  const ai = state.ai;
  const hits = ai.hits ?? [];

  const hitsHtml = hits.length
    ? `<p class="section-title">作为依据的条目 · ${hits.length}</p>
      <div class="hits">${hits
        .map((hit) => {
          const fromInbox = hit.kind === 'inbox';
          const href = fromInbox
            ? esc(hit.claim.url ?? '#/')
            : artistHref(
                hit.dossier.artist.id,
                hit.kind === 'claim' ? 'dimensions' : 'overview',
                periodSlug(hit.dossier),
                hit.kind === 'claim' ? hit.dim : null,
              );
          const extra = fromInbox ? ' target="_blank" rel="noopener"' : '';
          return `<a class="hit" href="${href}"${extra}>
            <span class="hit-ref">${esc(hit.ref)}</span>
            <span class="hit-dim">${esc(hit.dossier.artist.zh)} · ${esc(hit.label ?? DIM_LABELS[hit.dim].zh)}</span>
            <span class="hit-text">${esc(hit.claim.statement_zh ?? hit.claim.reason_zh ?? '')}</span>
            <span class="hit-grades">${esc((hit.claim.grades ?? []).join('') || '—')}</span>
          </a>`;
        })
        .join('')}</div>`
    : '';

  if (ai.status === 'loading') {
    return `<nav class="crumb"><a href="#/" data-back>← 返回首页</a></nav>
      <section class="ai-panel">
        <p class="ai-q">问题：${esc(ai.query)}</p>
        <p class="ai-status"><span class="pulse"></span>${esc(AI_STATUS.loading)}</p>
      </section>${hitsHtml}`;
  }

  if (ai.status === 'empty') {
    return `<nav class="crumb"><a href="#/" data-back>← 返回首页</a></nav>
      <section class="ai-panel">
        <p class="ai-q">问题：${esc(ai.query)}</p>
        <p class="ai-status">这个库里没有能对上这句话的条目。它目前只有 ${DATA.counts.claims} 条 claim，
          「查不到」也是回答——可以换个说法，或者先补数据。</p>
      </section>`;
  }

  if (ai.status === 'need-key' || ai.status === 'error') {
    const keyForm =
      ai.status === 'need-key'
        ? `<form id="keyform" class="keyform">
             <input id="keyinput" type="password" placeholder="sk-…（DeepSeek API Key）" autocomplete="off" />
             <button type="submit">保存并重试</button>
           </form>
           <p class="filter-note">Key 只写进本机 localStorage，不会提交给这个站点。本地预览服务器已配置密钥时无需填写。</p>`
        : '';
    return `<nav class="crumb"><a href="#/" data-back>← 返回首页</a></nav>
      <section class="ai-panel">
        <p class="ai-q">问题：${esc(ai.query)}</p>
        <p class="ai-error">${esc(ai.error || AI_STATUS[ai.status])}</p>
        ${ai.status === 'error' ? '<p class="ai-actions"><button type="button" class="retry" data-retry>重试这个问题</button></p>' : ''}
        ${keyForm}
      </section>`;
  }

  const meta = [ai.via === 'proxy' ? '本地代理' : '浏览器直连', ai.model, 'DeepSeek'].filter(Boolean).join(' · ');
  const kinds = new Set(hits.map((hit) => hit.kind));
  const scope = [
    '六维条目',
    kinds.has('anchor') ? '分期锚点' : '',
    kinds.has('open') ? '待解问题' : '',
    kinds.has('inbox') ? '候选池原文' : '',
  ]
    .filter(Boolean)
    .join(' + ');
  return `<nav class="crumb"><a href="#/" data-back>← 返回首页</a></nav>
    <section class="ai-panel">
      <p class="ai-q">问题：${esc(ai.query)}</p>
      <div class="ai-answer">${aiAnswerHtml(ai.answer)}</div>
      <p class="ai-meta">${esc(meta)} · 回答基于下面 ${hits.length} 条${esc(scope)}，引用编号可点</p>
    </section>
    ${hitsHtml}
    <p class="ai-disclaimer">AI 只是把已入库的条目读给你听；它说的每句话都该用 [S1] 这样的链接回到条目上核对。</p>`;
}

/* ------------------------------------------------------------------ AI 翻译 */

/** 把一份档案里所有 *_zh 字段收集起来：这就是「文档正文」。 */
function collectTexts(value, out = new Set(), depth = 0) {
  if (depth > 14 || out.size > 600 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectTexts(item, out, depth + 1));
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /_zh$/.test(key) && item.trim().length > 2) out.add(item.trim());
    else if (item && typeof item === 'object') collectTexts(item, out, depth + 1);
  }
  return out;
}

async function runTranslate() {
  if (state.translate.status === 'loading' || window.__TK_OFFLINE__) return;
  const dossier = currentDossier(state.route);
  if (!dossier) return;

  const all = [...collectTexts(dossier)];
  const missing = all.filter((text) => !trLookup(text));
  if (!missing.length) {
    state.translate = { ...state.translate, status: 'done', message: `这一页 ${all.length} 条都译过了` };
    render();
    return;
  }

  const batch = missing.slice(0, 16);
  state.translate = { ...state.translate, status: 'loading', message: `翻译中 · 0/${batch.length}` };
  render();

  try {
    const response = await fetch('./api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: state.translate.target, items: batch.map((text, i) => ({ key: String(i), text })) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);

    let got = 0;
    for (const item of payload.items ?? []) {
      const text = batch[Number(item.key)];
      if (!text) continue;
      trCache[trKey(state.translate.target, text)] = item.text;
      got += 1;
    }
    trSave();

    const left = missing.length - got;
    state.translate = {
      ...state.translate,
      status: 'done',
      message: left > 0 ? `已译 ${got} 条，还剩 ${left} 条，再点一次继续` : `已译 ${got} 条 · ${payload.model ?? ''}`.trim(),
    };
    render();
  } catch (error) {
    state.translate = { ...state.translate, status: 'error', message: `翻译失败：${error?.message ?? error}` };
    render();
  }
}

/* -------------------------------------------------------------------- render */

function render() {
  if (!DATA) return;
  const route = state.route;
  const onHome = route.name === 'home';

  searchBox.hidden = !onHome;
  qs('.search-hint').hidden = !onHome;
  const settingsButton = qs('#ai-settings-toggle');
  if (settingsButton) settingsButton.hidden = !onHome;
  if (!onHome) {
    const box = qs('#ai-settings');
    if (box) box.hidden = true;
  }
  renderTabsFor(route);
  renderMediaBarFor(route);

  if (onHome) {
    hint.textContent = state.ai.status === 'loading' ? '检索中…' : 'AI 检索 · DeepSeek';
    view.innerHTML = state.ai.query ? renderAiPanel() : renderIndex();
    return;
  }

  state.ai = { query: '', status: 'idle', answer: '', hits: [], error: '', via: '', model: '' };
  input.value = '';

  if (route.name === 'sources') {
    view.innerHTML = `<nav class="crumb"><a href="#/">← 画家索引</a></nav>${renderSources(null)}`;
    return;
  }

  if (route.name === 'images') {
    view.innerHTML = `<nav class="crumb"><a href="#/" data-back>← 返回首页</a></nav>${renderImageIndex()}`;
    return;
  }

  const artist = artistById(route.id);
  if (!artist) {
    view.innerHTML = `<nav class="crumb"><a href="#/">← 画家索引</a></nav>
      <section class="empty-card"><h3>没有这位画家</h3><p>索引里没有 <code>${esc(route.id)}</code>。可能是链接过期了。</p></section>`;
    return;
  }

  const dossier = currentDossier(route);
  if (!dossier) {
    state.pendingAnchor = null;
    view.innerHTML = route.tab === 'overview' ? renderPending(artist) : renderPendingDimension(artist, route.tab);
    return;
  }

  const head = renderArtistHero(artist, dossier, route);
  if (route.tab === 'overview') {
    view.innerHTML = `${head}${renderOverview(dossier)}`;
    return;
  }
  if (route.tab === 'sources') {
    const filterLabel = selectedMediaLabel();
    const ids = state.media.size ? sourceIdsForSelection(dossier) : (dossier.sourceIds ?? []);
    const emptyNote = filterLabel
      ? `此时期没有${filterLabel}的技法描述，因此没有对应来源（${BLANK}）。`
      : '';
    view.innerHTML = `${head}${renderSources(ids, { filterLabel, emptyNote })}`;
    return;
  }
  view.innerHTML = `${head}${renderDimensions(dossier, route.anchor)}${renderWorksBlock(dossier)}`;
  settlePendingAnchor();
}

/* ---------------------------------------------------------------------- wire */

/* The review desk only exists when preview.cmd (or another local serve.mjs) is running;
   a published site and the offline single file should not advertise a dead link. */
function revealLocalTools() {
  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal || window.__TK_OFFLINE__) return;
  const link = qs('#examine-link');
  if (link) link.hidden = false;
}

/**
 * 问答的可用性在三种环境里不一样，先把话说清楚，省得读者点了才发现：
 *   本机（preview.cmd）→ 密钥在服务端，直接用；
 *   线上静态托管       → 没有 /api/ai（POST 会被回 405），要读者自己粘一次 Key；
 *   离线单文件         → 没有网络代理，但可以直连读者自己的端点（DeepSeek 对 null origin 也回 CORS）。
 */
function markAiAvailability() {
  if (!hint) return;
  const settings = llmSettings();
  const own = settings.key ? `自备 Key ${maskKey(settings.key)}` : '';
  if (window.__TK_OFFLINE__) {
    hint.textContent = own ? `离线版 · ${own}` : '离线版 · 点「设置 Key」自备密钥';
    return;
  }
  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal) {
    hint.textContent = own ? `AI 检索 · 本地代理 + ${own}` : 'AI 检索 · 本地代理';
    return;
  }
  let who = '直连';
  try {
    who = new URL(settings.baseUrl).host;
  } catch {
    /* 保留默认 */
  }
  hint.textContent = own ? `AI 检索 · ${who}（${own}）` : 'AI 检索 · 点「设置 Key」自备密钥';
}

function markSettingsButton() {
  const button = qs('#ai-settings-toggle');
  if (!button) return;
  const { key } = llmSettings();
  button.textContent = key ? `Key ${maskKey(key)}` : '设置 Key';
  button.classList.toggle('is-set', Boolean(key));
}

/** 设置面板：填一次 Key，之后所有提问都走读者自己的端点。 */
function renderAiSettings() {
  const box = qs('#ai-settings');
  if (!box) return;
  const settings = llmSettings();
  box.innerHTML = `
    <form id="llmform" class="llm-form" autocomplete="off">
      <div class="llm-row">
        <label>API Key<input id="llm-key" type="password" placeholder="${settings.key ? '已存 ' + esc(maskKey(settings.key)) + '，留空＝不改' : 'sk-…（你的 Key）'}" /></label>
        <label>Base URL<input id="llm-base" type="text" value="${esc(settings.baseUrl)}" placeholder="${DEFAULT_LLM_BASE}" /></label>
        <label>模型<input id="llm-model" type="text" value="${esc(settings.model)}" placeholder="${DEFAULT_LLM_MODEL}" /></label>
      </div>
      <div class="llm-row llm-actions">
        <button type="submit">保存</button>
        <button type="button" data-llm-test>测试连接</button>
        <button type="button" data-llm-clear>清除</button>
        <span id="llm-msg" class="llm-msg"></span>
      </div>
      <p class="llm-note">Key 只写进<b>这台浏览器的 localStorage</b>，不会上传到任何服务器；清浏览器数据就没了。
        换 DeepSeek / OpenAI / Ollama / vLLM 等 OpenAI 兼容端点，改 Base URL 与模型名即可。</p>
      <p class="llm-note"${window.__TK_OFFLINE__ ? ' hidden' : ''}>想整站离线跑？<a href="./download/artlibrary-offline.html" download>下载单文件版</a>（约 220 KB，双击就能看）；
        要 Key 能存住，用本地 http 服务打开（例如 <code>python -m http.server</code>）。</p>
    </form>`;
}

function load() {
  view.innerHTML = `<p class="loading">正在载入索引…</p>`;
  fetch('./data/index.json')
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      DATA = payload;

      const examples = DATA.dossiers.filter((d) => d.meta.example);
      if (examples.length) {
        const banner = qs('#banner');
        banner.hidden = false;
        banner.innerHTML = `<strong>示例数据。</strong>引文中标注「出处待核验」的位置尚未核对，原文引句为结构示意，
          不可作为引用依据。真实条目须由人签字后才算数。`;
      }

      state.route = parseRoute();
      state.pendingAnchor = state.route.anchor || null;
      canonicalizeRoute();
      revealLocalTools();
      markAiAvailability();
      markSettingsButton();
      renderAiSettings();
      render();
    })
    .catch((error) => {
      view.innerHTML = `<p class="summary-zh">索引载入失败：${esc(error.message)}。<br />
        若在本地打开，请先运行 <code>node scripts/build-site.mjs</code> 生成 site/data/index.json。</p>`;
    });
}

/* ---------------------------------------------------------- LLM 设置面板 */

const settingsToggle = qs('#ai-settings-toggle');
const settingsBox = qs('#ai-settings');

function openSettings(open) {
  if (!settingsBox || !settingsToggle) return;
  const next = typeof open === 'boolean' ? open : settingsBox.hidden;
  settingsBox.hidden = !next;
  settingsToggle.setAttribute('aria-expanded', String(next));
  if (next) {
    renderAiSettings();
    qs('#llm-key')?.focus();
  }
}

settingsToggle?.addEventListener('click', () => openSettings());

settingsBox?.addEventListener('submit', (event) => {
  const form = event.target.closest('#llmform');
  if (!form) return;
  event.preventDefault();
  const keyInput = qs('#llm-key');
  const typedKey = keyInput?.value?.trim() ?? '';
  saveLlmSettings({
    key: typedKey || llmSettings().key,
    baseUrl: qs('#llm-base')?.value ?? '',
    model: qs('#llm-model')?.value ?? '',
  });
  const saved = llmSettings();
  const msg = qs('#llm-msg');
  if (msg) msg.textContent = `已保存：${saved.model} @ ${saved.baseUrl}${saved.key ? `，Key ${maskKey(saved.key)}` : ''}`;
  if (keyInput) keyInput.value = '';
  // 刚才是因为没 Key 才失败的，保存后自动重来一次，别让人再点一遍「问」。
  if (state.ai.query && (state.ai.status === 'need-key' || state.ai.status === 'error')) ask(state.ai.query);
});

settingsBox?.addEventListener('click', async (event) => {
  const msg = qs('#llm-msg');

  if (event.target.closest('[data-llm-clear]')) {
    saveLlmSettings({});
    renderAiSettings();
    const note = qs('#llm-msg');
    if (note) note.textContent = '已清除本机保存的 Key 与端点设置。';
    render();
    return;
  }

  if (!event.target.closest('[data-llm-test]')) return;
  const key = (qs('#llm-key')?.value ?? '').trim() || llmSettings().key;
  const baseUrl = ((qs('#llm-base')?.value ?? '').trim() || DEFAULT_LLM_BASE).replace(/\/+$/, '');
  const model = (qs('#llm-model')?.value ?? '').trim() || DEFAULT_LLM_MODEL;
  if (!key) {
    if (msg) msg.textContent = '先填 Key 再测试。';
    return;
  }
  if (msg) msg.textContent = '测试中…';
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
    });
    if (res.ok) {
      const payload = await res.json().catch(() => null);
      if (msg) msg.textContent = `通了：${payload?.model ?? model}（HTTP 200）。记得点「保存」。`;
    } else {
      const detail = (await res.text().catch(() => '')).slice(0, 120);
      if (msg) msg.textContent = `失败 HTTP ${res.status}${detail ? `：${detail}` : ''}`;
    }
  } catch (error) {
    if (msg) msg.textContent = `连不上：${error.message}（多半是 Base URL 写错，或该端点不允许浏览器直连）`;
  }
});

tabsEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button || state.route.name !== 'artist') return;
  go(artistHref(state.route.id, button.dataset.tab, state.route.period));
});

mediaBar.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-media]');
  if (!button) return;
  const key = button.dataset.media;
  if (key === '__all') state.media.clear();
  else if (state.media.has(key)) state.media.delete(key);
  else state.media.add(key);
  renderMediaBarFor(state.route);
  renderTabsFor(state.route);
  render();
});

view.addEventListener('change', (event) => {
  const select = event.target.closest('.tr-lang');
  if (!select) return;
  state.translate = { ...state.translate, target: select.value, status: 'idle', message: '' };
  store.setItem('tk.translate.target', select.value);
  render();
});

view.addEventListener('click', (event) => {
  const retry = event.target.closest('[data-retry]');
  if (retry) {
    event.preventDefault();
    if (state.ai.query) ask(state.ai.query);
    return;
  }
  const back = event.target.closest('[data-back]');
  if (back) {
    event.preventDefault();
    state.ai = { query: '', status: 'idle', answer: '', hits: [], error: '', via: '', model: '' };
    input.value = '';
    go('#/');
    return;
  }

  const sample = event.target.closest('[data-ask]');
  if (sample) {
    input.value = sample.dataset.ask;
    ask(sample.dataset.ask);
    return;
  }

  /* 站内链接（画家卡、分期条、面包屑、AI 引用…）全部走 go()。
     这样不依赖浏览器的 hash 跳转：预览 iframe / file:// 里点了也有反应。
     Ctrl / Cmd / Shift 点击仍交给浏览器（新标签页等）。 */
  const internal = event.target.closest('a[href^="#/"]');
  if (
    internal &&
    !internal.target &&
    !internal.hasAttribute('download') &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  ) {
    event.preventDefault();
    go(internal.getAttribute('href'));
    return;
  }

  if (event.target.closest('[data-tr-run]')) {
    runTranslate();
    return;
  }

  const jump = event.target.closest('[data-jump]');
  if (jump) {
    focusDimension(jump.dataset.jump);
    return;
  }

  const cell = event.target.closest('[data-goto]');
  if (!cell) return;
  state.media.clear();
  if (cell.dataset.medium) state.media.add(cell.dataset.medium);
  go(artistHref(state.route.id, 'dimensions', state.route.period, cell.dataset.anchor || null));
});

view.addEventListener('submit', (event) => {
  const form = event.target.closest('#keyform');
  if (!form) return;
  event.preventDefault();
  const value = qs('#keyinput').value.trim();
  if (!value) return;
  saveLlmSettings({ ...llmSettings(), key: value });
  markSettingsButton();
  ask(state.ai.query);
});

function submitQuestion() {
  const question = input.value.trim();
  if (!question) return;
  if (state.route.name !== 'home') go('#/');
  ask(question);
}

askButton.addEventListener('click', submitQuestion);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitQuestion();
  }
});

/** 地址栏变化（手输、前进/后退、没被拦截的链接）统一从这里同步页面。 */
function syncFromLocation() {
  state.route = parseRoute();
  const anchor = state.route.name === 'artist' ? state.route.anchor || null : null;
  state.pendingAnchor = anchor;
  canonicalizeRoute();
  if (state.route.name !== 'home') {
    state.ai = { query: '', status: 'idle', answer: '', hits: [], error: '', via: '', model: '' };
  }
  render();
  if (!anchor) window.scrollTo({ top: 0 });
}

window.addEventListener('hashchange', syncFromLocation);
window.addEventListener('popstate', syncFromLocation);

load();
