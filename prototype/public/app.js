const STATUS = {
  queued: 'В очереди', running: 'Выполняется', waiting_human: 'Ждёт вас', pr_open: 'PR → develop',
  in_develop: 'В develop', released: 'Выпущено', blocked: 'Остановлено', failed: 'Ошибка',
  cancelled: 'Отменено', skipped: 'Пропущено', closed: 'Закрыт', done: 'Готово',
};
const KIND = { issue: '', propose: 'идеи', create: 'новый issue', release: 'релиз', fix: 'решение' };
const FILTERS = {
  work: ['queued', 'running', 'waiting_human', 'pr_open', 'blocked', 'failed'],
  develop: ['in_develop'],
  all: null,
};
const ORDER = ['waiting_human', 'running', 'blocked', 'failed', 'pr_open', 'queued', 'in_develop', 'done', 'released', 'closed', 'cancelled', 'skipped'];
const CI = { pending: '⏳ CI идёт', success: '✓ CI', ci: '✗ CI', conflict: '✗ конфликт' };

let state = { jobs: [], ideas: [], actions: [], repos: {}, paused: false, pipeline: {} };
let selectedId = location.hash.slice(1) || null;
let filter = 'work';
let renderedFor = null;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ago = (iso) => {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? 'только что' : s < 3600 ? `${Math.floor(s / 60)} мин назад` : `${Math.floor(s / 3600)} ч назад`;
};
const api = (url, body) => fetch(url, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
const short = (repo) => (repo || '').split('/')[1] || repo;

// ---------- шапка ----------
function renderHeader() {
  const p = state.pipeline || {};
  const active = state.jobs.filter((j) => ['running', 'waiting_human'].includes(j.status)).length;
  const queued = state.jobs.filter((j) => j.status === 'queued').length;
  const prs = state.jobs.filter((j) => j.status === 'pr_open').length;
  $('#status').innerHTML = `<span class="dot ${state.paused ? 'paused' : ''}"></span>
    ${state.paused ? 'На паузе' : 'Работает'} · Claude: ${active}/${p.concurrency ?? 1} · очередь ${queued} · PR на CI ${prs}
    · GitHub ${p.syncing ? 'проверяется…' : 'проверен ' + ago(p.lastSync)}`;
  renderLimits();
  $('#pauseBtn').textContent = state.paused ? '▶ Продолжить' : '⏸ Пауза';
  $('#pauseBtn').className = state.paused ? 'primary' : '';
}

// ---------- потоки ----------
function renderLimits() {
  const p = state.pipeline || {};
  const box = $('#limits');
  const html = `
    <span class="stepper" title="Сколько сессий Claude работает одновременно (по всем проектам)">Потоков
      <button data-limit="concurrency" data-d="-1">−</button><b>${p.concurrency ?? '–'}</b><button data-limit="concurrency" data-d="1">+</button></span>
    <span class="stepper" title="Сколько задач одного проекта выполняется одновременно (каждая в своём клоне)">на проект
      <button data-limit="perRepoConcurrency" data-d="-1">−</button><b>${p.perRepoConcurrency ?? '–'}</b><button data-limit="perRepoConcurrency" data-d="1">+</button></span>`;
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

function renderLanes() {
  const p = state.pipeline || {};
  const live = state.jobs.filter((j) => ['running', 'waiting_human'].includes(j.status))
    .sort((a, b) => a.repo.localeCompare(b.repo) || (a.slot || 0) - (b.slot || 0));
  const free = Math.max(0, (p.concurrency || 0) - live.length);
  const queued = state.jobs.filter((j) => j.status === 'queued').length;
  $('#lanes').innerHTML = live.map((j) => {
    const pr = progress(j);
    return `<div class="lane ${j.status === 'waiting_human' ? 'waiting' : ''} ${j.id === selectedId ? 'sel' : ''}" data-id="${j.id}">
      <div class="l-repo"><span>${esc(short(j.repo))}${j.slot ? ` · поток ${j.slot + 1}` : ''}</span><span class="badge s-${j.status}">${STATUS[j.status]}</span></div>
      <div class="l-title">${KIND[j.kind] ? KIND[j.kind] + ': ' : j.issueNumber ? '#' + j.issueNumber + ' ' : ''}${esc(j.title)}</div>
      <div class="l-act">${esc(j.lastActivity || 'Подготовка клона…')}</div>
      ${pr !== null ? `<div class="progress"><div style="width:${pr}%"></div></div>` : ''}
    </div>`;
  }).join('') + Array.from({ length: free }, () => `<div class="lane free">${queued && !state.paused ? 'ждёт свободный клон проекта' : 'свободно'}</div>`).join('');
}

// ---------- список заданий ----------
function progress(j) {
  if (!j.todos?.length) return null;
  return Math.round((j.todos.filter((x) => x.status === 'completed').length / j.todos.length) * 100);
}

function renderJobs() {
  const allow = FILTERS[filter];
  const list = state.jobs
    .filter((j) => !allow || allow.includes(j.status))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 200);
  $('#jobList').innerHTML = list.length ? list.map((j) => {
    const pr = progress(j);
    const live = ['running', 'waiting_human'].includes(j.status);
    return `<div class="task ${j.id === selectedId ? 'selected' : ''}" data-id="${j.id}">
      <div class="t-title">${esc(j.title)}</div>
      <div class="t-meta">
        <span class="badge s-${j.status}">${STATUS[j.status] || j.status}</span>
        ${KIND[j.kind] ? `<span class="kind">${KIND[j.kind]}</span>` : ''}
        <span>${esc(short(j.repo))}${j.issueNumber ? ' #' + j.issueNumber : ''}</span>
        ${j.status === 'pr_open' && j.ciState ? `<span class="ci">${CI[j.ciState] || ''}</span>` : ''}
      </div>
      ${live && j.lastActivity ? `<div class="t-activity">${esc(j.lastActivity)}</div>` : ''}
      ${live && pr !== null ? `<div class="progress"><div style="width:${pr}%"></div></div>` : ''}
    </div>`;
  }).join('') : '<p class="none">Пусто.</p>';
}

function renderRepos() {
  const names = state.pipeline?.repos || Object.keys(state.repos);
  $('#repoList').innerHTML = names.map((name) => {
    const r = state.repos[name] || {};
    return `<div class="repo">
      <span class="r-name" title="${esc(r.localPath || '')}">${esc(name)}
        ${r.error ? `<span class="r-err">${esc(r.error)}</span>` : ''}</span>
      <button data-propose="${esc(name)}" title="Claude проанализирует проект и предложит доработки">💡 Идеи</button>
    </div>`;
  }).join('') || '<p class="none">Не найдено. Проверьте repos/scan в config.json.</p>';
}

// ---------- детали задания ----------
const TODO_IC = { completed: '✓', in_progress: '▸', pending: '○' };

function detailHead(j) {
  const b = (act, label, cls = '') => `<button class="${cls}" data-job-act="${act}">${label}</button>`;
  const btns = [];
  if (j.status === 'queued') btns.push(b('prioritize', 'Взять следующим'), b('cancel', 'Пропустить', 'danger'));
  if (['running', 'waiting_human'].includes(j.status)) btns.push(b('cancel', 'Остановить', 'danger'));
  if (['failed', 'blocked', 'cancelled', 'skipped'].includes(j.status)) btns.push(b('retry', 'Запустить заново', 'primary'));
  return `
    <div class="d-head">
      <h1>${esc(j.title)}</h1>
      <div class="d-meta">
        <span class="badge s-${j.status}">${STATUS[j.status] || j.status}</span>
        ${KIND[j.kind] ? `<span class="kind">${KIND[j.kind]}</span>` : ''}
        ${j.issueUrl ? `<a href="${esc(j.issueUrl)}" target="_blank">${esc(j.repo)}${j.issueNumber ? ' #' + j.issueNumber : ''}</a>` : `<span>${esc(j.repo)}</span>`}
        ${j.issueNumber ? `<span>ветка <code>issues-${j.issueNumber}</code></span>` : ''}
        ${j.prUrl ? `<a href="${esc(j.prUrl)}" target="_blank">PR → develop ↗</a>` : ''}
        ${j.ciState && j.status === 'pr_open' ? `<span>${CI[j.ciState] || ''}</span>` : ''}
        ${j.fixAttempts ? `<span>автоисправлений: ${j.fixAttempts}</span>` : ''}
        ${j.costUsd ? `<span>$${j.costUsd.toFixed(2)}</span>` : ''}
      </div>
      <div class="d-actions">${btns.join('')}</div>
      ${j.error ? `<div class="d-error">${esc(j.error)}</div>` : ''}
    </div>
    <h3>План Claude ${j.todos?.length ? `· ${progress(j)}%` : ''}</h3>
    ${j.todos?.length
      ? `<ul class="todos">${j.todos.map((x) => `<li class="${x.status}"><span class="ic">${TODO_IC[x.status] || '○'}</span><span>${esc(x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content)}</span></li>`).join('')}</ul>`
      : '<p class="none" style="padding:0">План появится, когда Claude начнёт работу.</p>'}`;
}

function eventHtml(e) {
  let body;
  if (e.kind === 'tool') body = `<span class="tool-name">${esc(e.tool)}</span>${esc(e.text)}`;
  else if (e.kind === 'result') body = `<b>${e.ok ? 'Готово' : 'Завершено с ошибкой'}</b>${e.costUsd ? ` · $${e.costUsd.toFixed(2)}` : ''}<div style="white-space:pre-wrap;margin-top:4px">${esc(e.text)}</div>`;
  else body = esc(e.text);
  return `<div class="ev ${e.kind}"><span class="ev-time">${time(e.ts)}</span><span class="ev-body">${body}</span></div>`;
}

async function renderDetail(force = false) {
  const j = state.jobs.find((x) => x.id === selectedId);
  const el = $('#detail');
  if (!j) { el.innerHTML = '<div class="empty">Выберите задание слева</div>'; renderedFor = null; return; }
  if (renderedFor !== j.id || force) {
    renderedFor = j.id;
    el.innerHTML = `<div id="dHead"></div><div id="followUp"></div><h3>Ход выполнения</h3><div class="timeline" id="timeline"></div>`;
    renderFollowUp(j);
    const events = await api(`/api/jobs/${j.id}/events`);
    if (renderedFor !== j.id) return;
    $('#timeline').innerHTML = events.map(eventHtml).join('') || '<p class="none" style="padding:0">Событий пока нет.</p>';
  }
  $('#dHead').innerHTML = detailHead(j);
}

let followKey = null;
function renderFollowUp(j) {
  followKey = `${j.id}:${j.status}`;
  const can = j.kind === 'issue' && ['pr_open', 'blocked', 'failed', 'in_develop'].includes(j.status) && j.sessionId;
  $('#followUp').innerHTML = can ? `
    <h3>Указание для Claude</h3>
    <textarea id="followText" rows="3" placeholder="Например: «добавь тесты на граничные случаи» — Claude продолжит в той же сессии и обновит ветку issues-${j.issueNumber}"></textarea>
    <div class="a-buttons"><button class="primary" id="followSend">Отправить</button></div>` : '';
}

function appendEvent(jobId, e) {
  if (jobId !== renderedFor) return;
  const tl = $('#timeline');
  if (!tl) return;
  tl.querySelector('.none')?.remove();
  const d = $('#detail');
  const nearBottom = d.scrollHeight - d.scrollTop - d.clientHeight < 80;
  tl.insertAdjacentHTML('beforeend', eventHtml(e));
  if (nearBottom) d.scrollTop = d.scrollHeight;
}

// ---------- «Ваши решения» ----------
function releaseCards() {
  return Object.entries(state.repos)
    .filter(([, r]) => r.release?.ahead)
    .map(([repo, r]) => {
      const rel = r.release;
      const link = rel.pr?.url || `https://github.com/${repo}/compare/main...develop?expand=1`;
      return `<div class="action k-release" data-card="release:${repo}:${rel.ahead}">
        <div class="a-task">${esc(repo)}</div>
        <div class="a-title">Релиз: develop → main</div>
        <div class="a-text">В develop ${rel.ahead} коммит(ов) не в main${rel.issues?.length ? `, задачи: ${rel.issues.map((i) => '#' + i.n).join(', ')}` : ''}.</div>
        <ul class="commits">${rel.commits.slice(0, 8).map((c) => `<li>${esc(c)}</li>`).join('')}${rel.commits.length > 8 ? '<li>…</li>' : ''}</ul>
        <div class="a-buttons">
          <a href="${esc(link)}" target="_blank"><button class="primary">${rel.pr ? 'Открыть PR develop → main ↗' : 'Создать PR develop → main ↗'}</button></a>
          <button data-release="${esc(repo)}" title="После мержа в main: тег, release notes, закрытие issues">Выпустить (git-release)</button>
        </div>
      </div>`;
    });
}

function ideaCard(i) {
  return `<div class="action k-idea" data-card="idea:${i.id}" data-idea="${i.id}">
    <div class="a-task">${esc(i.repo)}</div>
    <div class="a-title">💡 ${esc(i.title)}</div>
    <div class="idea-meta">${esc(i.type || '')}${i.size ? ' · размер ' + esc(i.size) : ''}</div>
    <div class="a-text">${esc(i.rationale || '')}</div>
    <textarea class="idea-desc" rows="4">${esc(i.description)}</textarea>
    <div class="a-buttons">
      <button class="primary" data-idea-act="approve">Создать задачу</button>
      <button data-idea-act="reject">Отклонить</button>
    </div>
  </div>`;
}

function actionCard(a) {
  let inner = '';
  if (a.kind === 'permission') {
    const i = a.input || {};
    const preview = a.tool === 'Bash'
      ? `<pre>$ ${esc(i.command)}</pre>${i.description ? `<div class="a-text">${esc(i.description)}</div>` : ''}`
      : i.file_path
        ? `<div class="a-text"><code>${esc(i.file_path)}</code></div>${i.old_string !== undefined ? `<pre>- ${esc(String(i.old_string).slice(0, 800))}\n+ ${esc(String(i.new_string).slice(0, 800))}</pre>` : `<pre>${esc(String(i.content ?? '').slice(0, 1200))}</pre>`}`
        : `<pre>${esc(JSON.stringify(i, null, 2).slice(0, 1500))}</pre>`;
    inner = `${preview}<input type="text" class="deny-msg" placeholder="Комментарий для Claude (необязательно)">
      <div class="a-buttons"><button class="primary" data-resolve="allow">Разрешить</button><button class="danger" data-resolve="deny">Запретить</button></div>`;
  } else if (a.kind === 'question') {
    inner = (a.questions || []).map((q, qi) => `<div class="q" data-q="${qi}">
        <div class="q-text">${esc(q.question)}</div>
        ${(q.options || []).map((o) => `<label><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${a.id}_${qi}" value="${esc(o.label)}"><span>${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`).join('')}
        <input type="text" class="q-other" placeholder="Свой ответ">
      </div>`).join('') + `<div class="a-buttons"><button class="primary" data-resolve="answer">Ответить</button><button data-resolve="deny">Пусть решит сам</button></div>`;
  } else {
    const p = a.proposal;
    const canApply = p && !p.needsHuman;
    inner = `<div class="a-text">${esc(a.text)}</div>${remedyBlock(a)}
      <div class="a-buttons">
        ${canApply ? '<button class="primary" data-apply>Выполнить решение</button>' : ''}
        ${a.url ? `<a href="${esc(a.url)}" target="_blank"><button>Открыть PR ↗</button></a>` : ''}
        <button class="${canApply ? '' : 'primary'}" data-job-retry>Запустить заново</button>
        <button data-goto>Подробнее / дать указание</button>
        <button data-resolve="dismiss">Скрыть</button>
      </div>`;
  }
  return `<div class="action k-${a.kind}" data-card="action:${a.id}:${a.proposalStatus || ''}" data-action="${a.id}" data-job="${a.jobId}">
    <div class="a-task" data-goto>${esc(a.jobTitle)} · ${esc(short(a.repo))}</div>
    <div class="a-title">${esc(a.title)}</div>${inner}</div>`;
}

// Предлагаемое решение в карточке «Проблемы»: текст шагов можно поправить перед выполнением
function remedyBlock(a) {
  if (a.proposalStatus === 'pending') return '<div class="remedy pending">Claude ищет решение…</div>';
  const p = a.proposal;
  if (!p) return '';
  const who = p.source === 'autopilot' ? 'Известная проблема' : 'Предлагает Claude';
  if (p.needsHuman) {
    return `<div class="remedy human"><div class="remedy-h">Нужно ваше участие · ${who}</div>
      <div class="remedy-sum">${esc(p.summary)}</div>
      ${p.steps.length ? `<ol>${p.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}</div>`;
  }
  return `<div class="remedy"><div class="remedy-h">Предлагаемое решение · ${who}</div>
    <input type="text" class="remedy-sum-in" aria-label="Решение" value="${esc(p.summary)}">
    <textarea class="remedy-steps" rows="${Math.min(6, Math.max(2, p.steps.length))}" aria-label="Шаги, по одному на строку">${esc(p.steps.join('\n'))}</textarea>
    ${p.commands.length ? `<div class="remedy-note">Выполнятся без повторного вопроса:</div><pre>${p.commands.map((c) => '$ ' + esc(c)).join('\n')}</pre>` : ''}
    ${p.where === 'local' ? '<div class="remedy-note warn">Claude будет работать в вашей локальной папке проекта.</div>' : ''}
  </div>`;
}

function renderInbox() {
  const actions = state.actions.filter((a) => a.status === 'open');
  const urgent = actions.filter((a) => ['permission', 'question'].includes(a.kind));
  const problems = actions.filter((a) => !['permission', 'question'].includes(a.kind));
  const ideas = state.ideas.filter((i) => i.status === 'pending');
  const releases = releaseCards();

  const sections = [
    ['Claude ждёт ответа', urgent.map(actionCard)],
    ['Релизы', releases],
    ['Идеи на подтверждение', ideas.map(ideaCard)],
    ['Проблемы', problems.map(actionCard)],
  ].filter(([, cards]) => cards.length);

  const total = urgent.length + releases.length + ideas.length + problems.length;
  $('#inboxCount').textContent = total || '';
  document.title = total ? `(${total}) Claude Autopilot` : 'Claude Autopilot';

  const html = sections.length
    ? sections.map(([t, cards]) => `<div class="inbox-sec">${t}</div>${cards.join('')}`).join('')
    : '<p class="none">Решений не требуется — Claude работает сам.</p>';
  // не перерисовываем без изменений, чтобы не терять введённый текст
  const sig = [...html.matchAll(/data-card="([^"]+)"/g)].map((m) => m[1]).join('|') || html;
  const box = $('#inbox');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = html;
}

function collectAnswers(card, a) {
  const answers = {};
  (a.questions || []).forEach((q, qi) => {
    const box = card.querySelector(`[data-q="${qi}"]`);
    const picked = [...box.querySelectorAll('input:checked')].map((i) => i.value);
    const other = box.querySelector('.q-other').value.trim();
    if (other) picked.push(other);
    answers[q.question] = picked.join(', ');
  });
  return answers;
}

// ---------- обработчики ----------
function select(id) {
  selectedId = id;
  location.hash = id;
  renderJobs();
  renderLanes();
  renderDetail();
}

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  const jobEl = t.closest('.task, .lane[data-id]');
  if (jobEl) return select(jobEl.dataset.id);
  const lim = t.closest('[data-limit]');
  if (lim) {
    const key = lim.dataset.limit;
    const cur = state.pipeline?.[key] || 1;
    return api('/api/limits', { [key]: cur + Number(lim.dataset.d) });
  }

  const tab = t.closest('.tab');
  if (tab) {
    filter = tab.dataset.filter;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tab));
    return renderJobs();
  }
  if (t.closest('[data-propose]')) {
    t.disabled = true;
    return api(`/api/repos/${t.closest('[data-propose]').dataset.propose}/propose`, {});
  }
  if (t.closest('[data-release]')) {
    if (!confirm('Запустить git-release? Делайте это после того, как PR develop → main смержен.')) return;
    return api(`/api/repos/${t.closest('[data-release]').dataset.release}/release`, {});
  }
  const jobAct = t.closest('[data-job-act]');
  if (jobAct) {
    if (jobAct.dataset.jobAct === 'cancel' && !confirm('Остановить / пропустить задание?')) return;
    return api(`/api/jobs/${selectedId}/${jobAct.dataset.jobAct}`, {});
  }
  if (t.id === 'followSend') {
    const message = $('#followText').value.trim();
    if (!message) return;
    await api(`/api/jobs/${selectedId}/followup`, { message });
    $('#followText').value = '';
    return;
  }

  const ideaEl = t.closest('[data-idea]');
  const ideaAct = t.closest('[data-idea-act]');
  if (ideaEl && ideaAct) {
    const id = ideaEl.dataset.idea;
    ideaEl.style.opacity = 0.4;
    if (ideaAct.dataset.ideaAct === 'approve') return api(`/api/ideas/${id}/approve`, { description: ideaEl.querySelector('.idea-desc').value });
    return api(`/api/ideas/${id}/reject`, {});
  }

  const card = t.closest('[data-action]');
  if (!card) return;
  const a = state.actions.find((x) => x.id === card.dataset.action);
  if (t.closest('[data-goto]')) return select(card.dataset.job);
  if (t.closest('[data-job-retry]')) return api(`/api/jobs/${card.dataset.job}/retry`, {});
  if (t.closest('[data-apply]')) {
    card.style.opacity = 0.4;
    return api(`/api/actions/${a.id}/apply`, {
      summary: card.querySelector('.remedy-sum-in')?.value,
      steps: (card.querySelector('.remedy-steps')?.value || '').split('\n'),
    });
  }
  const res = t.closest('[data-resolve]');
  if (!res || !a) return;
  const kind = res.dataset.resolve;
  const payload = kind === 'allow' ? { decision: 'allow' }
    : kind === 'deny' ? { decision: 'deny', message: card.querySelector('.deny-msg')?.value.trim() || undefined }
      : kind === 'answer' ? { decision: 'allow', answers: collectAnswers(card, a) }
        : { decision: 'dismiss' };
  card.style.opacity = 0.4;
  await api(`/api/actions/${a.id}/resolve`, payload);
});

$('#syncBtn').onclick = async () => {
  $('#syncBtn').disabled = true;
  await api('/api/sync', {});
  $('#syncBtn').disabled = false;
};
$('#pauseBtn').onclick = () => api('/api/pause', { paused: !state.paused });

// ---------- живые обновления ----------
async function reload() {
  state = await api('/api/state');
  renderAll(true);
}

function renderAll(force) {
  renderHeader();
  renderLanes();
  renderJobs();
  renderRepos();
  renderInbox();
  renderDetail(force);
}

const upsert = (arr, item) => {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
};

let queued = false;
function scheduleRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; renderAll(false); });
}

function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = reload;
  es.onmessage = (m) => {
    const c = JSON.parse(m.data);
    if (c.type === 'job') {
      upsert(state.jobs, c.job);
      if (c.job.id === renderedFor && followKey !== `${c.job.id}:${c.job.status}`) renderFollowUp(c.job);
    } else if (c.type === 'action') {
      upsert(state.actions, c.action);
    } else if (c.type === 'idea') {
      upsert(state.ideas, c.idea);
    } else if (c.type === 'repo') {
      state.repos[c.repo] = c.data;
    } else if (c.type === 'paused') {
      state.paused = c.paused;
    } else if (c.type === 'event') {
      return appendEvent(c.jobId, c.event);
    } else if (c.type === 'pipeline') {
      return reload();
    }
    scheduleRender();
  };
}

setInterval(renderHeader, 30_000);
connect();
