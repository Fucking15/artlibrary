/* 审查台 / examine — 读 /api/examine/state，写判决，不改知识库本体。 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  const banner = $('#banner');
  const TOKEN_KEY = 'tk.examine.token';

  const CLASS_LABELS = { A: 'A 学术', B: 'B 机构', C: 'C 次级', D: 'D 书籍', E: 'E 评论区' };
  const KIND_LABELS = {
    journal_article: '期刊论文',
    conference_paper: '会议论文',
    dissertation: '学位论文',
    monograph: '专著',
    catalogue_raisonne: '作品全集目录',
    exhibition_catalogue: '展览图录',
    book: '书',
    book_chapter: '书中章节',
    edited_volume: '文集',
    museum_object_page: '馆藏对象页',
    museum_research_document: '馆方研究文档',
    archive_record: '档案记录',
    database_record: '数据库记录',
    exhibition_page: '展览页',
    press_article: '媒体报道',
    interview: '访谈',
    documentary: '纪录片',
    social_comment: '评论',
    forum_thread: '论坛帖',
    user_review: '书评',
    other: '其他',
  };

  let state = null;
  let klass = '';

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  const token = () => sessionStorage.getItem(TOKEN_KEY) ?? '';

  function say(text, kind = 'info') {
    banner.hidden = false;
    banner.textContent = text;
    banner.dataset.kind = kind;
  }

  async function api(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
    const current = token();
    if (current) headers['x-examine-token'] = current;
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401) {
      const error = new Error('unauthorized');
      error.code = 401;
      throw error;
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(payload.error ?? `HTTP ${res.status}`);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function renderTokenForm() {
    banner.hidden = true;
    view.innerHTML = `
      <section class="empty-card">
        <h3>需要审查口令</h3>
        <p>这个服务配置了 <code>EXAMINE_TOKEN</code>。口令只存在浏览器的 sessionStorage 里，不会发给别处。</p>
        <form id="token-form" class="keyform">
          <label for="token">审查口令</label>
          <input id="token" type="password" autocomplete="off" placeholder="EXAMINE_TOKEN" />
          <button type="submit">进入</button>
        </form>
      </section>`;
    $('#token-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const value = $('#token').value.trim();
      if (!value) return;
      sessionStorage.setItem(TOKEN_KEY, value);
      load();
    });
  }

  function statRow(stats) {
    const by = stats.by_status ?? {};
    const cells = [
      ['待审', by.awaiting_review ?? 0],
      ['已入库', by.approved ?? 0],
      ['已驳回', by.rejected ?? 0],
      ['判 F 已删', stats.absurd ?? 0],
      ['无关已筛', stats.out_of_scope ?? 0],
      ['未初筛', by.new ?? 0],
    ];
    return `<div class="stat-row">${cells
      .map(([label, value]) => `<div class="stat"><span class="num">${value}</span><span class="lbl">${esc(label)}</span></div>`)
      .join('')}</div>`;
  }

  function runLine(run) {
    if (!run) return '<p class="search-hint">还没有抓取记录。跑一次 <code>node scripts/inbox/weekly.mjs</code>。</p>';
    const adapters = run.adapters ?? [];
    const ok = adapters.filter((a) => a.ok);
    const bad = adapters.filter((a) => !a.ok);
    return `<p class="run-line">上次抓取 <b>${esc(String(run.run_id ?? '').slice(0, 16).replace('T', ' '))}</b>
      · 新增 ${run.added ?? 0} 条 · 重复跳过 ${run.skipped ?? 0} 条
      · 源 ${ok.length}/${adapters.length} 可用${bad.length ? `（失败：${bad.map((a) => esc(a.id)).join('、')}）` : ''}</p>`;
  }

  function glossHtml(gloss) {
    if (!gloss || !gloss.summary_zh) return '';
    const facts = (gloss.key_facts ?? []).length
      ? `<ul class="gloss-facts">${gloss.key_facts.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
      : '';
    const caveat = gloss.caveat_zh ? `<p class="gloss-caveat">待核：${esc(gloss.caveat_zh)}</p>` : '';
    const stamp = esc(String(gloss.at ?? '').slice(0, 16).replace('T', ' '));
    return `<div class="gloss-body">
      ${gloss.relevant === false ? '<p class="gloss-flag">与席勒无关</p>' : ''}
      ${gloss.title_zh ? `<p class="gloss-title">${esc(gloss.title_zh)}</p>` : ''}
      <p class="gloss-summary">${esc(gloss.summary_zh)}</p>
      ${facts}
      ${caveat}
      <details class="gloss-trans"><summary>译文</summary><p>${esc(gloss.translation_zh || '（略）')}</p></details>
      <p class="gloss-meta">${esc(gloss.model ?? '')} · ${gloss.source === 'page' ? '读了正文' : '只有摘要'} · ${stamp}</p>
    </div>`;
  }

  function card(row) {
    const kind = KIND_LABELS[row.kind] ?? row.kind;
    const when = row.published ? ` · ${esc(row.published)}` : '';
    const aiNote = row.reason_zh
      ? `<p class="ai-note"><span class="tag tag-${esc(row.verdict ?? 'S')}">${esc(row.verdict ?? 'S')}</span> ${esc(row.reason_zh)}
         <span class="by">${esc((row.verdict_by ?? '').replace('ai:', 'AI · '))}</span></p>`
      : '<p class="ai-note dim">AI 还没给初判。</p>';
    return `
    <article class="review-card" data-id="${esc(row.id)}" data-class="${esc(row.class)}">
      <header>
        <span class="tag tag-class">${esc(CLASS_LABELS[row.class] ?? row.class)}</span>
        <span class="tag tag-kind">${esc(kind)}</span>
        <span class="tag tag-lang">${esc(row.lang ?? '—')}</span>
        <span class="by">${esc(row.adapter ?? '')}${when}</span>
      </header>
      <h3>${row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noreferrer">${esc(row.title || row.url)}</a>` : esc(row.title || '(无标题)')}</h3>
      <p class="publisher">${esc(row.publisher ?? '')}</p>
      <p class="excerpt">${esc(row.excerpt ?? '')}</p>
      ${aiNote}
      <div class="gloss-bar">
        <button type="button" class="ghost" data-act="gloss">${row.gloss?.summary_zh ? '重译 · 摘要' : '译 · 摘要'}</button>
        <span class="gloss-hint">译成中文，只留与席勒有关的部分。</span>
      </div>
      <div class="gloss" ${row.gloss?.summary_zh ? '' : 'hidden'}>${glossHtml(row.gloss)}</div>
      <div class="review-actions">
        <input class="note" type="text" maxlength="300" placeholder="备注（可选，写进日志）" />
        <button type="button" data-act="approve" data-tag="T">通过 · T</button>
        <button type="button" data-act="approve" data-tag="S">通过 · S</button>
        <button type="button" data-act="reject">驳回</button>
        <button type="button" class="danger" data-act="delete">删除 · F</button>
      </div>
    </article>`;
  }

  function recentTable(rows) {
    if (!rows.length) return '<p class="search-hint">还没有通过审核的条目。</p>';
    return `<table class="recent-table">
      <thead><tr><th>标题</th><th>类别</th><th>标签</th><th>审核人</th><th>时间</th></tr></thead>
      <tbody>${rows
        .map(
          (row) => `<tr>
            <td>${row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noreferrer">${esc(row.title)}</a>` : esc(row.title)}</td>
            <td>${esc(row.class)}</td>
            <td><span class="tag tag-${esc(row.verdict ?? 'S')}">${esc(row.verdict ?? '—')}</span></td>
            <td>${esc((row.verdict_by ?? '').replace(/^(ai|human):/, ''))}</td>
            <td>${esc(String(row.reviewed_at ?? row.verdict_at ?? '').slice(0, 16).replace('T', ' '))}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>`;
  }

  function droppedPanel(rows, stats) {
    const total = stats.out_of_scope ?? 0;
    if (!total) return '';
    const body = rows.length
      ? rows
          .map(
            (row) => `<li class="dropped-row">
              <span class="tag tag-class">${esc(row.class)}</span>
              <span class="dropped-title">${row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noreferrer">${esc(row.title)}</a>` : esc(row.title)}</span>
              <span class="dropped-reason">${esc(row.reason_zh ?? '')}</span>
            </li>`,
          )
          .join('')
      : '<li class="dropped-row"><span class="dropped-reason">没有可显示的记录。</span></li>';
    return `<details class="dropped-panel">
      <summary>已筛除 ${total} 条 · 与席勒的技法/学术无关，不参与审核（看最近 ${rows.length} 条）</summary>
      <ul class="dropped-list">${body}</ul>
    </details>`;
  }

  function render() {
    const stats = state.stats ?? {};
    const queue = (state.queue ?? []).filter((row) => (klass ? row.class === klass : true));
    const pendingReview = stats.by_status?.awaiting_review ?? 0;
    const needScreening = stats.by_status?.new ?? 0;

    view.innerHTML = `
      ${statRow(stats)}
      ${runLine(state.last_run)}
      ${needScreening ? `<p class="callout">有 <b>${needScreening}</b> 条候选还没过 AI 初筛。点上面的「运行 AI 初筛」，或跑 <code>node scripts/inbox/screen.mjs</code>。</p>` : ''}
      <p class="section-title">待审 · C / D / E（${pendingReview}）</p>
      ${queue.length ? `<div class="review-list">${queue.map(card).join('')}</div>` : '<p class="empty-line">这一类没有待审条目。</p>'}
      ${droppedPanel(state.dropped ?? [], stats)}
      <p class="section-title" style="margin-top:44px">最近入库</p>
      ${recentTable(state.recent ?? [])}`;

    view.querySelectorAll('.review-actions button').forEach((button) => {
      button.addEventListener('click', () => decide(button));
    });
    view.querySelectorAll('[data-act="gloss"]').forEach((button) => {
      button.addEventListener('click', () => gloss(button));
    });
  }

  async function gloss(button) {
    const cardEl = button.closest('.review-card');
    const id = cardEl.dataset.id;
    const target = cardEl.querySelector('.gloss');
    const rerun = Boolean(target.querySelector('.gloss-body'));
    const label = button.textContent;
    button.disabled = true;
    button.textContent = '翻译中…';
    target.hidden = false;
    target.innerHTML = '<p class="gloss-wait">读原文、译、写摘要…（外文长页要二三十秒）</p>';
    try {
      const payload = await api('/api/examine/gloss', {
        method: 'POST',
        body: JSON.stringify({ id, force: rerun }),
      });
      target.innerHTML = glossHtml(payload.gloss);
      button.textContent = '重译 · 摘要';
      say(payload.cached ? '这条已有摘要，直接读缓存。' : `译好了：${payload.gloss.relevant === false ? '与席勒无关' : '已摘要'}。`, 'ok');
    } catch (error) {
      const code = error.payload?.error ?? '';
      const hints = {
        'no-key': '本地服务没有读到 DEEPSEEK_KEY，用 preview.cmd 启动，或设置环境变量。',
        'not-enough-text': '这条只有标题没有内容，抓不到正文，译不了。',
        'bad-model-json': '模型输出不是合法 JSON，点一次重试。',
        'too-long': '正文太长，连截短几次都没能一次译完，点一次重试。',
        'upstream-402': 'DeepSeek 账户余额不足。',
      };
      target.innerHTML = `<p class="gloss-error">译不了：${esc(hints[code] ?? error.message)}</p>`;
      button.textContent = label;
    } finally {
      button.disabled = false;
    }
  }

  async function decide(button) {
    const cardEl = button.closest('.review-card');
    const id = cardEl.dataset.id;
    const action = button.dataset.act;
    const tag = button.dataset.tag;
    const note = cardEl.querySelector('.note').value.trim();
    const labels = { approve: '通过', reject: '驳回', delete: '删除' };
    if (action === 'delete' && !window.confirm('删除后这条会留指纹、下周也不会再收。确定？')) return;

    cardEl.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    try {
      const payload = await api('/api/examine/decision', {
        method: 'POST',
        body: JSON.stringify({ id, decision: action, tag, note, reviewer: 'admin' }),
      });
      say(`${labels[action]}成功：${payload.status}`, 'ok');
      await load({ quiet: true });
    } catch (error) {
      say(`操作失败：${error.message}`, 'error');
      cardEl.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
    }
  }

  async function load({ quiet = false } = {}) {
    try {
      state = await api('/api/examine/state');
      render();
      if (!quiet) say(`共 ${state.stats?.total ?? 0} 条候选，判 F 删除 ${state.stats?.absurd ?? 0} 条，与本库无关筛除 ${state.stats?.out_of_scope ?? 0} 条。`, 'info');
      if (state.screening === 'running') $('#screening').textContent = 'AI 初筛进行中…';
    } catch (error) {
      if (error.code === 401) {
        renderTokenForm();
        return;
      }
      view.innerHTML = `<section class="empty-card"><h3>读不到审查队列</h3><p>${esc(error.message)}</p>
        <p>确认 <code>preview.cmd</code> 起的服务还在跑（默认 4321）。</p></section>`;
    }
  }

  $('#filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-class]');
    if (!button) return;
    klass = button.dataset.class;
    document.querySelectorAll('#filters button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    render();
  });

  $('#refresh').addEventListener('click', () => load());

  $('#screen').addEventListener('click', async () => {
    const button = $('#screen');
    button.disabled = true;
    $('#screening').textContent = 'AI 初筛进行中…';
    try {
      const payload = await api('/api/examine/screen', { method: 'POST', body: '{}' });
      const tail = String(payload.output ?? '').trim().split('\n').slice(-3).join(' · ');
      say(tail || `初筛结束（exit ${payload.code}）`, payload.ok ? 'ok' : 'error');
      await load({ quiet: true });
    } catch (error) {
      say(`初筛失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
      $('#screening').textContent = '';
    }
  });

  load();
})();
