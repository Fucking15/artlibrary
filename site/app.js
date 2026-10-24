/* technique-kb — static viewer.
   No framework, no build step: everything it needs is already resolved in ./data/index.json. */

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

const qs = (sel, root = document) => root.querySelector(sel);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let DATA = null;
let TAB = 'overview';
const view = qs('#view');
const tabs = qs('#tabs');
const input = qs('#q');

/* ------------------------------------------------------------------ helpers */

function claimCard(claim, dimKey) {
  const grade = claim.grades.includes('C') && claim.grades.length === 1 ? 'C' : claim.grades[0] ?? '';
  const chips = [
    dimKey ? `<span class="chip">${esc(DIM_LABELS[dimKey]?.zh ?? dimKey)}</span>` : '',
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

  return `
    <article class="claim" data-grade="${esc(grade)}">
      <p class="statement">${esc(claim.statement_zh)}</p>
      <div class="chips">${chips}</div>
      ${claim.note_zh ? `<p class="note">${esc(claim.note_zh)}</p>` : ''}
      <details class="evidence">
        <summary>证据 ${claim.evidence.length} 条 · ${claim.evidence.map((e) => e.grade).join('')}</summary>
        <ol>${evidence}</ol>
      </details>
      ${iiif}
    </article>`;
}

function claimList(list, dimKey) {
  return `<div class="claims">${list.map((claim) => claimCard(claim, dimKey)).join('')}</div>`;
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

/* --------------------------------------------------------------- rendering */

function renderTabs() {
  const items = [
    { key: 'overview', label: '概览', count: null },
    ...DATA.dims.map((dim) => ({ key: dim, label: DIM_LABELS[dim].zh, count: countClaims(dim) })),
    { key: 'sources', label: '来源', count: DATA.sources.length },
  ];
  tabs.innerHTML = items
    .map(
      (item) =>
        `<button data-tab="${item.key}" aria-selected="${item.key === TAB}">${esc(item.label)}${
          item.count !== null ? ` <span class="count">${item.count}</span>` : ''
        }</button>`,
    )
    .join('');
}

function countClaims(dim) {
  return DATA.dossiers.reduce((total, dossier) => total + flatten(dossier, dim).length, 0);
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

function renderOverview() {
  return DATA.dossiers
    .map((dossier) => {
      const s = dossier.stats;
      const anchors = dossier.period.anchors
        .map((a) => `<li><span class="year">${esc(a.year)}${a.month_day ? `-${esc(a.month_day)}` : ''}</span><span>${esc(a.event_zh)}</span></li>`)
        .join('');

      const cells = DATA.dims
        .map((dim) => {
          const n = flatten(dossier, dim).length;
          return `<div class="dim-cell" data-goto="${dim}">
            <span class="dim-en">${esc(DIM_LABELS[dim].en)}</span>
            <span class="dim-name">${esc(DIM_LABELS[dim].zh)}</span>
            <span class="dim-count">${n} 条结论</span>
          </div>`;
        })
        .join('');

      return `
      <section class="artist-card">
        <h2>${esc(dossier.artist.zh)}</h2>
        <p class="romanised">${esc(dossier.artist.en)} · ${esc(dossier.artistMeta.birth)}–${esc(dossier.artistMeta.death)}</p>
        <p class="period-line"><b>${esc(dossier.period.start_year)}–${esc(dossier.period.end_year)}</b> ${esc(dossier.period.label.zh)}
          <br />${esc(dossier.period.basis_zh)}</p>
      </section>

      <div class="stat-row">
        <div class="stat"><span class="num">${s.claims}</span><span class="lbl">claims</span></div>
        <div class="stat"><span class="num">${s.signed}</span><span class="lbl">已签字</span></div>
        <div class="stat"><span class="num">${s.grades.A ?? 0}</span><span class="lbl">A 级证据</span></div>
        <div class="stat"><span class="num">${s.grades.B ?? 0}</span><span class="lbl">B 级证据</span></div>
        <div class="stat"><span class="num">${s.unverifiedLocators}</span><span class="lbl">出处待核验</span></div>
      </div>

      <p class="section-title">六个维度 · six dimensions</p>
      <div class="dim-grid">${cells}</div>

      <p class="section-title">分期锚点 · anchors</p>
      <ul class="anchors">${anchors}</ul>

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
    })
    .join('');
}

function renderDimension(dim) {
  return DATA.dossiers
    .map((dossier) => {
      const d = dossier.dimensions;

      if (dim === 'period') {
        return `<p class="section-title">${esc(DIM_LABELS.period.zh)} · ${esc(dossier.id)}</p>${claimList(d.period, 'period')}`;
      }

      if (dim === 'lineage') {
        return d.lineage
          .map((entry) =>
            entryBlock(
              `${entry.counterpart} → ${dossier.artist.zh}`,
              `${entry.relation}${entry.window ? ` · ${entry.window.from_year}–${entry.window.to_year ?? ''}` : ''}`,
              `<p class="summary-zh">${esc(entry.summary_zh)}</p>
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
            <div><dt>底材</dt><dd>${esc(m.supports.join(' / ') || '—')}</dd></div>
            <div><dt>媒介</dt><dd>${esc(m.mediums.join(' / ') || '—')}</dd></div>
          </dl>
          ${m.process_zh ? `<p class="summary-zh">${esc(m.process_zh)}</p>` : ''}
          ${claimList(m.claims, 'material')}`;
      }

      if (dim === 'composition') {
        return DATA.composition_fields
          .map((field) => {
            const block = d.composition[field];
            return entryBlock(
              FIELD_LABELS[field] ?? field,
              `composition.${field}`,
              `${block.summary_zh ? `<p class="summary-zh">${esc(block.summary_zh)}</p>` : ''}${claimList(block.claims, 'composition')}`,
            );
          })
          .join('');
      }

      const sm = d.subject_matter;
      return `<p class="section-title">题材 · ${esc(dossier.id)}</p>
        <div class="chips">${sm.motifs.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div>
        ${sm.rationale_zh ? `<p class="summary-zh">${esc(sm.rationale_zh)}</p>` : ''}
        ${claimList(sm.claims, 'subject_matter')}`;
    })
    .join('');
}

function renderSources() {
  return `<p class="section-title">来源登记 · ${DATA.sources.length} 条</p>
    <div class="claims">${DATA.sources
      .map(
        (s) => `<article class="claim" data-grade="${esc(s.grade)}">
        <p class="statement">${esc(s.citation)}</p>
        <div class="chips">
          <span class="chip grade-${esc(s.grade)}">${esc(s.grade)} 级</span>
          <span class="chip">${esc(s.kind)}</span>
          <span class="chip">${esc(s.lang)}</span>
        </div>
        ${s.note_zh ? `<p class="note">${esc(s.note_zh)}</p>` : ''}
        ${s.url ? `<a class="src-link" href="${esc(s.url)}" target="_blank" rel="noopener">来源页 ↗</a>` : ''}
      </article>`,
      )
      .join('')}</div>`;
}

/* ------------------------------------------------------------------ search */

function searchableClaims() {
  const rows = [];
  for (const dossier of DATA.dossiers) {
    for (const dim of DATA.dims) {
      for (const claim of flatten(dossier, dim)) rows.push({ dim, claim, dossier });
    }
  }
  return rows;
}

function renderSearch(query) {
  const needle = query.trim().toLowerCase();
  const rows = searchableClaims()
    .map((row) => {
      const haystack = [
        row.claim.statement_zh,
        row.claim.note_zh,
        ...row.claim.evidence.map((e) => `${e.quote} ${e.translation_zh ?? ''} ${e.citation} ${e.locator}`),
      ]
        .join(' ')
        .toLowerCase();
      const score = haystack.split(needle).length - 1;
      return { ...row, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!rows.length) {
    return `<p class="section-title">检索 · “${esc(query)}”</p>
      <p class="summary-zh">没有命中的结论。这个库目前只有 ${DATA.counts.claims} 条 claim、一位画家——
      在它长大之前，"查不到"是正常的回答。</p>`;
  }

  return `<p class="section-title">检索 · “${esc(query)}” · ${rows.length} 条命中</p>
    <div class="claims">${rows.map((row) => claimCard(row.claim, row.dim)).join('')}</div>`;
}

/* -------------------------------------------------------------------- wire */

function render() {
  const query = input.value.trim();
  if (query) {
    view.innerHTML = renderSearch(query);
    return;
  }
  if (TAB === 'overview') view.innerHTML = renderOverview();
  else if (TAB === 'sources') view.innerHTML = renderSources();
  else view.innerHTML = renderDimension(TAB);
}

const isTab = (value) => value === 'sources' || (DATA?.dims ?? []).includes(value);

function syncHash() {
  const target = TAB === 'overview' ? location.pathname : `#${TAB}`;
  history.replaceState(null, '', target);
}

tabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;
  TAB = button.dataset.tab;
  input.value = '';
  syncHash();
  renderTabs();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

view.addEventListener('click', (event) => {
  const cell = event.target.closest('[data-goto]');
  if (!cell) return;
  TAB = cell.dataset.goto;
  syncHash();
  renderTabs();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

window.addEventListener('hashchange', () => {
  const next = location.hash.replace('#', '');
  TAB = next === '' ? 'overview' : next;
  input.value = '';
  renderTabs();
  render();
});

let timer = null;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(render, 120);
});

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

    renderTabs();

    const fromHash = location.hash.replace('#', '');
    if (fromHash && isTab(fromHash)) {
      TAB = fromHash;
      renderTabs();
    }

    render();
  })
  .catch((error) => {
    view.innerHTML = `<p class="summary-zh">索引载入失败：${esc(error.message)}。<br />
      若在本地打开，请先运行 <code>node scripts/build-site.mjs</code> 生成 site/data/index.json。</p>`;
  });
