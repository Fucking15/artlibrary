/* technique-kb — static viewer with per-artist pages and an AI-assisted search.
 *
 * Routes (hash only, so GitHub Pages needs no rewrites):
 *   #/                      画家索引（主页）
 *   #/artist/<id>           画家页 · 概览
 *   #/artist/<id>/<dim>     画家页 · 六个维度之一
 *   #/artist/<id>/sources   该画家引用的来源
 *   #/sources               全部来源登记
 *
 * 数据只有 ./data/index.json 一处。AI 检索先打本地预览服务器的 /api/ai（密钥留在服务端），
 * 没有代理时退回浏览器直连 DeepSeek，密钥只存在本机 localStorage。 */

const DIM_LABELS = {
  period: { zh: '时期', en: 'period' },
  lineage: { zh: '师从与影响', en: 'lineage' },
  comparison: { zh: '对比与创新', en: 'comparison' },
  material: { zh: '材料', en: 'material' },
  composition: { zh: '画面构成', en: 'composition' },
  subject_matter: { zh: '题材', en: 'subject matter' },
};

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

const MEDIA_ORDER = ['oil', 'oil_on_panel', 'watercolor', 'colored_on_paper', 'drawing_on_paper', 'print'];

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
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const KEY_STORE = 'tk_deepseek_key';

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

const mediumChip = (key) =>
  `<span class="chip medium${key === 'period_level' ? ' is-period-level' : ''}">${esc(MEDIA_LABELS[key] ?? key)}</span>`;

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
    claim.medium.map(mediumChip).join(''),
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
    return `<p class="filter-note">当前画种筛选下，这一项没有可显示的结论。</p>`;
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
  return flatten(dossier, dim).filter(visible).length;
}

function countCategory(dossier) {
  return DATA.dims.reduce((total, dim) => total + countDim(dossier, dim), 0);
}

/* ------------------------------------------------------------------ routing */

const isTab = (value) => value === 'sources' || (DATA?.dims ?? []).includes(value);

function parseRoute() {
  const raw = location.hash.replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'sources') return { name: 'sources' };
  if (parts[0] === 'artist' && parts[1]) {
    const id = decodeURIComponent(parts[1]);
    // #/artist/schiele/<period>/<tab>：第二段只有确实是这位画家的分期 slug 时才当分期，
    // 否则仍按旧链接理解成 tab，老书签不会失效。
    const maybePeriod = parts[2] ? decodeURIComponent(parts[2]) : '';
    const period = maybePeriod && dossierByPeriod(id, maybePeriod) ? maybePeriod : null;
    const tabRaw = (period ? parts[3] : parts[2]) ?? 'overview';
    const tab = tabRaw === 'overview' || !isTab(tabRaw) ? 'overview' : tabRaw;
    return { name: 'artist', id, period, tab };
  }
  return { name: 'home' };
}

const artistHref = (id, tab = 'overview', period = null) => {
  const base = `#/artist/${encodeURIComponent(id)}${period ? `/${encodeURIComponent(period)}` : ''}`;
  return tab === 'overview' ? base : `${base}/${tab}`;
};

function go(hash) {
  if (location.hash === hash) {
    state.route = parseRoute();
    render();
    return;
  }
  location.hash = hash;
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
  <p class="registry-links"><a href="#/sources">全部来源登记 →</a></p>

  <p class="section-title" style="margin-top:44px">可以这样问 · ask</p>
  <div class="ask-samples">${samples.map((q) => `<button type="button" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
}

/* --------------------------------------------------------------- artist page */

function renderPeriodSwitch(artist, active, route) {
  const periods = dossiersOf(artist.id);
  if (periods.length < 2) return '';
  const tab = route?.tab && route.tab !== 'overview' ? route.tab : 'overview';
  const items = periods
    .map((dossier) => {
      const slug = periodSlug(dossier);
      const on = dossier.id === active?.id;
      return `<a class="period-chip${on ? ' is-on' : ''}" href="${artistHref(artist.id, tab, slug)}"${
        on ? ' aria-current="page"' : ''
      }><b>${esc(dossier.period.start_year)}–${esc(dossier.period.end_year)}</b>${esc(dossier.period.label.zh)}
        <span class="n">${countCategory(dossier)}</span></a>`;
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
       <div class="chips" style="margin-top:14px">${(dossier.media.declared ?? []).map(mediumChip).join(' ')}</div>`
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

/** 档案还没建时，每个次级目录照样给一页，说清楚这一格为什么是空的。 */
function renderPendingDimension(artist, tab) {
  const dim = DIM_LABELS[tab];
  const label = tab === 'sources' ? '来源' : dim?.zh ?? tab;
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
    { key: null, label: '全部', sub: 'all media', count: countCategory(dossier) },
    ...MEDIA_ORDER.filter((medium) => (dossier.media.declared ?? []).includes(medium)).map((medium) => ({
      key: medium,
      label: MEDIA_LABELS[medium] ?? medium,
      sub: medium,
      count: flattenAll(dossier).filter((claim) => claim.medium.includes(medium)).filter(visible).length,
    })),
  ];

  const blocks = categories
    .map((category) => {
      const cells = DATA.dims
        .map((dim) => {
          if (dim === 'period' && category.key) {
            return `<div class="dim-cell is-static" data-goto="${dim}">
              <span class="dim-en">${esc(DIM_LABELS[dim].en)}</span>
              <span class="dim-name">${esc(DIM_LABELS[dim].zh)}</span>
              <span class="dim-count">全期共用 · ${dossier.dimensions.period.length} 条</span>
            </div>`;
          }
          const n = countDim(dossier, dim);
          return `<div class="dim-cell${n ? '' : ' is-empty'}" data-goto="${dim}" data-medium="${esc(category.key ?? '')}">
            <span class="dim-en">${esc(DIM_LABELS[dim].en)}</span>
            <span class="dim-name">${esc(DIM_LABELS[dim].zh)}</span>
            <span class="dim-count">${n ? `${n} 条结论` : '暂无'}</span>
          </div>`;
        })
        .join('');

      return `<section class="media-block">
        <div class="media-block-head">
          <h3>${esc(category.label)}</h3>
          <span class="media-block-sub">${esc(category.sub)} · ${category.count} 条</span>
        </div>
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
    <div class="stat"><span class="num">${dossier.media.declared.length}</span><span class="lbl">画种</span></div>
    <div class="stat"><span class="num">${s.signed}</span><span class="lbl">已签字</span></div>
    <div class="stat"><span class="num">${s.grades.A ?? 0}</span><span class="lbl">A 级证据</span></div>
    <div class="stat"><span class="num">${s.notApplicable ?? 0}</span><span class="lbl">不适用</span></div>
    <div class="stat"><span class="num">${s.unverifiedLocators}</span><span class="lbl">出处待核验</span></div>
  </div>

  <p class="section-title">按画种分类 · by medium</p>
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

function flattenAll(dossier) {
  return DATA.dims.flatMap((dim) => flatten(dossier, dim));
}

function renderDimension(dossier, dim) {
  const d = dossier.dimensions;

  if (dim === 'period') {
    return `<p class="section-title">${esc(DIM_LABELS.period.zh)} · ${esc(dossier.id)}</p>
      <div class="chips">${dossier.media.declared.map(mediumChip).join('')}</div>
      ${claimList(d.period, 'period')}`;
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
    return `<p class="section-title">材料 · ${esc(dossier.id)}</p>
      <dl class="pair-block">
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
  return `<p class="section-title">题材 · ${esc(dossier.id)}</p>
    <div class="chips">${sm.motifs.map((m) => `<span class="chip">${esc(MOTIF_LABELS[m] ?? m)}</span>`).join('')}</div>
    ${sm.rationale_zh ? `<p class="summary-zh">${esc(sm.rationale_zh)}</p>${trLine(sm.rationale_zh)}` : ''}
    ${claimList(sm.claims, 'subject_matter')}`;
}

function renderSources(ids) {
  const pool = ids ? DATA.sources.filter((s) => ids.includes(s.id)) : DATA.sources;
  const heading = ids ? `来源登记 · 本页引用 ${pool.length} 条` : `来源登记 · ${pool.length} 条`;
  if (!pool.length) {
    return `<p class="section-title">${esc(heading)}</p><p class="filter-note">这份档案还没有引用任何来源。</p>`;
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
  const items = [
    { key: 'overview', label: '概览', count: null },
    ...DATA.dims.map((dim) => ({ key: dim, label: DIM_LABELS[dim].zh, count: dossier ? countDim(dossier, dim) : null })),
    { key: 'sources', label: '来源', count: dossier ? (dossier.sourceIds ?? []).length : null },
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
  const counts = {};
  for (const [medium, n] of Object.entries(dossier.media.counts ?? {})) counts[medium] = n;
  const items = MEDIA_ORDER.filter((medium) => counts[medium]);
  const allPressed = state.media.size === 0;
  mediaBar.innerHTML =
    `<button type="button" data-media="__all" aria-pressed="${allPressed}">全部</button>` +
    items
      .map(
        (medium) =>
          `<button type="button" data-media="${esc(medium)}" aria-pressed="${state.media.has(medium)}">${esc(MEDIA_LABELS[medium] ?? medium)} <span class="n">${counts[medium]}</span></button>`,
      )
      .join('');
  mediaRow.hidden = false;
}

/* ------------------------------------------------------------------ AI 检索 */

const STOPWORDS = new Set(['什么', '怎么', '为什么', '如何', '哪些', '哪个', '是否', '以及', '还有', '一个', '这个', '那个', '我们', '他们']);

function queryTokens(query) {
  const cleaned = query.toLowerCase().replace(/[\s，。、；：？！,.;:?!「」『』（）()《》〈〉…—\-_"'’“”]/g, '');
  const tokens = new Set();
  for (let i = 0; i < cleaned.length - 1; i += 1) {
    const bigram = cleaned.slice(i, i + 2);
    if (!STOPWORDS.has(bigram)) tokens.add(bigram);
  }
  for (const latin of query.toLowerCase().match(/[a-z]{3,}/g) ?? []) tokens.add(latin);
  return [...tokens];
}

/** Lexical retrieval over every claim: enough to hand the model a small, cited context. */
function retrieve(query, limit = 12) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];

  const rows = [];
  for (const dossier of DATA.dossiers) {
    for (const dim of DATA.dims) {
      for (const claim of flatten(dossier, dim)) {
        if (claim.not_applicable) continue;
        const haystack = [
          claim.statement_zh,
          claim.note_zh,
          ...claim.evidence.map((e) => `${e.quote} ${e.translation_zh ?? ''} ${e.citation}`),
          DIM_LABELS[dim].zh,
          DIM_LABELS[dim].en,
          ...claim.medium.map((m) => MEDIA_LABELS[m] ?? m),
          dossier.artist.zh,
          dossier.artist.en,
        ]
          .join(' ')
          .toLowerCase();

        let score = 0;
        for (const token of tokens) {
          let at = haystack.indexOf(token);
          while (at !== -1) {
            score += 1;
            at = haystack.indexOf(token, at + token.length);
          }
        }
        if (score > 0) rows.push({ dossier, dim, claim, score });
      }
    }
  }

  rows.sort((a, b) => b.score - a.score);
  const perDim = new Map();
  const picked = [];
  for (const row of rows) {
    const key = `${row.dossier.id}:${row.dim}`;
    const used = perDim.get(key) ?? 0;
    if (used >= 3) continue;
    perDim.set(key, used + 1);
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
    const media = claim.medium.map((m) => MEDIA_LABELS[m] ?? m).join('/');
    const flags = [
      `${claim.grades.join('')} 级证据`,
      claim.confidence ? `置信${CONF_LABELS[claim.confidence] ?? claim.confidence}` : '',
      claim.evidence.some((e) => e.unverified) ? '出处待核验' : '',
      claim.status === 'signed' ? '已签字' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `[${hit.ref}] ${hit.dossier.artist.zh} · ${DIM_LABELS[hit.dim].zh} · ${media} · ${flags}：${claim.statement_zh}${
      claim.note_zh ? `（注：${claim.note_zh}）` : ''
    }`;
  });

  const system = [
    '你在检索一个「画家技法知识库」。下面给出的条目是唯一可用的事实来源。',
    '规则：',
    '1. 只能使用条目里的内容，不得补充外部知识，不得编造页码、引文、年份或作品名。',
    '2. 每条要点后面用 [S1] 这样的编号标注依据；编号必须来自下面给出的条目。',
    '3. 如果条目不足以回答问题，直接说「现有条目不足以回答」，并说明还缺什么。',
    '4. 条目里标注「出处待核验」的，回答时要用一句话提醒读者它尚未核验。',
    '5. 用中文回答，控制在 250 字内，先给结论，再给要点，不要复述问题。',
    '',
    `知识库里的画家：${roster || '（暂无）'}`,
    '',
    '可选条目：',
    ...lines,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: query },
  ];
}

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
    else if (response.status !== 404) throw { code: 'PROXY_ERROR', status: response.status };
    // 404 = 没起本地服务（静态托管），继续走直连
  } catch (error) {
    // fetch 本身失败（离线、跨域、服务没起）也继续尝试直连
    if (error?.code === 'PROXY_ERROR' || error?.code === 'EMPTY') throw error;
  }

  // 2) 浏览器直连：密钥由用户自己粘贴，只存本机 localStorage。
  const key = store.getItem(KEY_STORE);
  if (!key) throw { code: 'NO_KEY', viaProxy: true };

  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.2, max_tokens: 900 }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw { code: 'HTTP', status: response.status, detail: detail.slice(0, 200) };
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content ?? '';
  if (!content) throw { code: 'EMPTY' };
  return { content, via: 'direct', model: payload?.model ?? 'deepseek-chat' };
}

function errorText(error) {
  switch (error?.code) {
    case 'NO_KEY':
      return error?.viaProxy
        ? '本地预览服务没有读到 DEEPSEEK_KEY，浏览器里也还没存过 Key。'
        : '还没有配置 API Key。';
    case 'HTTP':
      return `DeepSeek 返回 HTTP ${error.status}${error.detail ? `：${error.detail}` : ''}`;
    case 'EMPTY':
      return 'DeepSeek 返回了空回答。';
    default:
      return `请求失败：${error?.message ?? error}`;
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
  return `<a class="cite" href="${artistHref(hit.dossier.artist.id, hit.dim, periodSlug(hit.dossier))}" title="${esc(hit.claim.statement_zh ?? '')}">${esc(hit.ref)}</a>`;
}

function aiInline(text) {
  let html = esc(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[(S\d+)\]/g, (match, ref) => aiCite(state.ai.hits.find((hit) => hit.ref === ref)));
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
        .map(
          (hit) => `<a class="hit" href="${artistHref(hit.dossier.artist.id, hit.dim, periodSlug(hit.dossier))}">
            <span class="hit-ref">${esc(hit.ref)}</span>
            <span class="hit-dim">${esc(hit.dossier.artist.zh)} · ${esc(DIM_LABELS[hit.dim].zh)}</span>
            <span class="hit-text">${esc(hit.claim.statement_zh ?? hit.claim.reason_zh ?? '')}</span>
            <span class="hit-grades">${esc(hit.claim.grades.join('') || '—')}</span>
          </a>`,
        )
        .join('')}</div>`
    : '';

  if (ai.status === 'loading') {
    return `<nav class="crumb"><a href="#/" data-back>← 返回索引</a></nav>
      <section class="ai-panel">
        <p class="ai-q">问题：${esc(ai.query)}</p>
        <p class="ai-status"><span class="pulse"></span>${esc(AI_STATUS.loading)}</p>
      </section>${hitsHtml}`;
  }

  if (ai.status === 'empty') {
    return `<nav class="crumb"><a href="#/" data-back>← 返回索引</a></nav>
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
    return `<nav class="crumb"><a href="#/" data-back>← 返回索引</a></nav>
      <section class="ai-panel">
        <p class="ai-q">问题：${esc(ai.query)}</p>
        <p class="ai-error">${esc(ai.error || AI_STATUS[ai.status])}</p>
        ${keyForm}
      </section>`;
  }

  const meta = [ai.via === 'proxy' ? '本地代理' : '浏览器直连', ai.model, 'DeepSeek'].filter(Boolean).join(' · ');
  return `<nav class="crumb"><a href="#/" data-back>← 返回索引</a></nav>
    <section class="ai-panel">
      <p class="ai-q">问题：${esc(ai.query)}</p>
      <div class="ai-answer">${aiAnswerHtml(ai.answer)}</div>
      <p class="ai-meta">${esc(meta)} · 回答基于下面 ${hits.length} 条 claim，引用编号可点</p>
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

  const artist = artistById(route.id);
  if (!artist) {
    view.innerHTML = `<nav class="crumb"><a href="#/">← 画家索引</a></nav>
      <section class="empty-card"><h3>没有这位画家</h3><p>索引里没有 <code>${esc(route.id)}</code>。可能是链接过期了。</p></section>`;
    return;
  }

  const dossier = currentDossier(route);
  if (!dossier) {
    view.innerHTML = route.tab === 'overview' ? renderPending(artist) : renderPendingDimension(artist, route.tab);
    return;
  }

  const head = renderArtistHero(artist, dossier, route);
  if (route.tab === 'overview') {
    view.innerHTML = `${head}${renderOverview(dossier)}`;
    return;
  }
  if (route.tab === 'sources') {
    view.innerHTML = `${head}${renderSources(dossier.sourceIds ?? [])}`;
    return;
  }
  view.innerHTML = `${head}${renderDimension(dossier, route.tab)}`;
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
      revealLocalTools();
      render();
    })
    .catch((error) => {
      view.innerHTML = `<p class="summary-zh">索引载入失败：${esc(error.message)}。<br />
        若在本地打开，请先运行 <code>node scripts/build-site.mjs</code> 生成 site/data/index.json。</p>`;
    });
}

tabsEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button || state.route.name !== 'artist') return;
  go(artistHref(state.route.id, button.dataset.tab, state.route.period));
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

  if (event.target.closest('[data-tr-run]')) {
    runTranslate();
    return;
  }

  const cell = event.target.closest('[data-goto]');
  if (!cell) return;
  state.media.clear();
  if (cell.dataset.medium) state.media.add(cell.dataset.medium);
  go(artistHref(state.route.id, cell.dataset.goto, state.route.period));
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

view.addEventListener('submit', (event) => {
  const form = event.target.closest('#keyform');
  if (!form) return;
  event.preventDefault();
  const value = qs('#keyinput').value.trim();
  if (!value) return;
  store.setItem(KEY_STORE, value);
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

window.addEventListener('hashchange', () => {
  state.route = parseRoute();
  if (state.route.name !== 'home') {
    state.ai = { query: '', status: 'idle', answer: '', hits: [], error: '', via: '', model: '' };
  }
  render();
  window.scrollTo({ top: 0 });
});

load();
