// Конвейер autopilot:
//   GitHub Issues ──sync──▶ очередь ──/task_complete──▶ PR issues-N → develop
//        ▲                                                 │ CI зелёный → squash-merge (autopilot)
//        │                                                 │ CI красный → Claude чинит (до N раз)
//   /task_create ◀── одобренная идея ◀── Claude предлагает   ▼
//                                                     develop ──▶ карточка «Релиз»: PR develop → main (человек)
import { store } from './store.js';
import * as gh from './github.js';
import * as repos from './repos.js';
import { runClaude } from './runner.js';
import * as remedy from './remedy.js';
import fs from 'node:fs';
import path from 'node:path';
import { notify, setKeepAwake } from './macos.js';

let cfg;
let repoList = [];
const running = new Map(); // jobId -> AbortController
const busy = new Map();     // repo -> Set(slot) — какие клоны проекта сейчас заняты

// Лимиты можно менять на лету из панели; они перекрывают config.json
export const limits = () => ({
  concurrency: store.state.settings?.concurrency ?? cfg.concurrency,
  perRepoConcurrency: store.state.settings?.perRepoConcurrency ?? cfg.perRepoConcurrency,
});

export function setLimits({ concurrency, perRepoConcurrency }) {
  const clamp = (v, max) => Math.max(1, Math.min(max, Math.round(Number(v))));
  const s = { ...(store.state.settings || {}) };
  if (concurrency !== undefined) s.concurrency = clamp(concurrency, 32);
  if (perRepoConcurrency !== undefined) s.perRepoConcurrency = clamp(perRepoConcurrency, 8);
  store.state.settings = s;
  store.emitChange({ type: 'pipeline' });
  pump();
}
let lastSync = null;
let syncing = false;

const ACTIVE = ['queued', 'running', 'waiting_human'];
const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`;

export async function initPipeline(config) {
  cfg = config;
  // Задания, прерванные перезапуском. /task_complete идемпотентен — просто ставим заново.
  for (const j of store.jobs) {
    if (j.status === 'running' || j.status === 'waiting_human') {
      store.closeActionsForJob(j.id, ['permission', 'question']);
      store.updateJob(j.id, { status: 'queued', error: null });
      store.logEvent(j.id, { kind: 'system', text: 'Прервано перезапуском приложения — поставлено в очередь заново' });
    }
  }
  repoList = await repos.discoverRepos(cfg);
  console.log(`Репозитории (${repoList.length}): ${repoList.map((r) => r.repo).join(', ')}`);
  syncAll();
  setInterval(syncAll, cfg.pollIntervalMinutes * 60_000);
  setInterval(monitorPrs, 2 * 60_000);
  setInterval(pump, 5_000);
}

export const pipelineInfo = () => ({
  lastSync, syncing, ...limits(),
  running: [...running.keys()],
  repos: repoList.map((r) => r.repo),
});

// ======================= синхронизация =======================
export async function syncAll() {
  if (syncing) return;
  syncing = true;
  store.emit('change', { type: 'pipeline' });
  try {
    repoList = await repos.discoverRepos(cfg);
    // все проекты опрашиваются параллельно (с ограничением, чтобы не упереться в rate limit GitHub)
    await repos.mapLimit(repoList, cfg.ioConcurrency, (r) =>
      syncRepo(r).catch((e) => store.setRepo(r.repo, { error: e.message.split('\n').slice(-2).join(' ') })));
    await monitorPrs();
  } finally {
    syncing = false;
    lastSync = new Date().toISOString();
    store.emit('change', { type: 'pipeline' });
    pump();
  }
}

function issueEligible(issue) {
  const labels = (issue.labels || []).map((l) => l.name);
  if (labels.some((l) => cfg.issues.skipLabels.includes(l))) return false;
  if (cfg.issues.onlyLabels.length && !labels.some((l) => cfg.issues.onlyLabels.includes(l))) return false;
  return true;
}

async function syncRepo(r) {
  const issues = await gh.listOpenIssues(r.repo);
  const openNumbers = new Set(issues.map((i) => i.number));

  for (const issue of issues.sort((a, b) => a.number - b.number)) {
    if (store.findIssueJob(r.repo, issue.number) || !issueEligible(issue)) continue;
    const prs = await gh.prsForBranch(r.repo, `issues-${issue.number}`);
    const merged = prs.find((p) => p.state === 'MERGED' && p.baseRefName === 'develop');
    const open = prs.find((p) => p.state === 'OPEN');
    store.addJob({
      kind: 'issue',
      repo: r.repo,
      issueNumber: issue.number,
      issueUrl: issue.url,
      title: issue.title,
      status: merged ? 'in_develop' : open ? 'pr_open' : 'queued',
      prUrl: (merged || open)?.url || null,
      prSince: open ? Date.now() : null,
    });
  }

  // Issue закрыт на GitHub: после релиза (git-release) или вручную
  for (const j of store.jobs) {
    if (j.kind !== 'issue' || j.repo !== r.repo || openNumbers.has(j.issueNumber)) continue;
    if (j.status === 'in_develop') store.updateJob(j.id, { status: 'released' });
    else if (['queued', 'pr_open', 'blocked', 'failed'].includes(j.status)) store.updateJob(j.id, { status: 'closed' });
  }

  store.setRepo(r.repo, { error: null, lastSync: new Date().toISOString(), localPath: r.localPath });
  await refreshRelease(r.repo);
  maybeScheduleProposals(r.repo);
}

// Карточка «Релиз develop → main»: что уже в develop и ещё не в main
async function refreshRelease(repo) {
  const release = await repos.releaseInfo(repo).catch(() => null);
  const releasePr = release?.ahead ? await gh.releasePr(repo).catch(() => null) : null;
  const inDevelop = store.jobs.filter((j) => j.repo === repo && j.status === 'in_develop').map((j) => ({ n: j.issueNumber, title: j.title }));
  const prev = store.state.repos[repo]?.release;
  store.setRepo(repo, { release: release ? { ...release, pr: releasePr, issues: inDevelop } : null });
  if (release?.ahead && !prev?.ahead && cfg.notifications) notify('Готов релиз develop → main', `${repo}: ${release.ahead} коммит(ов)`);
}

// ======================= идеи =======================
function maybeScheduleProposals(repo) {
  const p = cfg.proposals;
  if (!p.enabled) return;
  const pendingIdeas = store.state.ideas.filter((i) => i.repo === repo && i.status === 'pending').length;
  if (pendingIdeas >= p.maxPendingPerRepo) return;
  // предлагаем только когда по репозиторию нет работы в очереди
  if (store.jobs.some((j) => j.repo === repo && ACTIVE.includes(j.status))) return;
  const last = store.state.repos[repo]?.lastProposalAt;
  if (last && Date.now() - Date.parse(last) < p.intervalHours * 3_600_000) return;
  scheduleProposals(repo);
}

export function scheduleProposals(repo) {
  if (store.jobs.some((j) => j.kind === 'propose' && j.repo === repo && ACTIVE.includes(j.status))) return;
  store.setRepo(repo, { lastProposalAt: new Date().toISOString() });
  store.addJob({ kind: 'propose', repo, title: `Поиск доработок: ${repo}`, priority: -10 });
  pump();
}

export function approveIdea(id, { title, description }) {
  const idea = store.state.ideas.find((i) => i.id === id);
  if (!idea || idea.status !== 'pending') return null;
  store.updateIdea(id, { status: 'approved', title: title || idea.title, description: description || idea.description });
  store.addJob({ kind: 'create', repo: idea.repo, ideaId: id, title: `Создать issue: ${title || idea.title}`, priority: 50 });
  pump();
  return idea;
}

export function rejectIdea(id) {
  return store.updateIdea(id, { status: 'rejected' });
}

export function startRelease(repo) {
  if (store.jobs.some((j) => j.kind === 'release' && j.repo === repo && ACTIVE.includes(j.status))) return;
  store.addJob({ kind: 'release', repo, title: `Релиз (git-release): ${repo}`, priority: 80 });
  pump();
}

// ======================= очередь =======================
export function pump() {
  if (store.state.paused) return;
  const queue = store.jobs
    .filter((j) => j.status === 'queued' && !running.has(j.id))
    .sort((a, b) => b.priority - a.priority || (a.issueNumber || 0) - (b.issueNumber || 0) || a.createdAt.localeCompare(b.createdAt));
  const lim = limits();
  for (const job of queue) {
    if (running.size >= lim.concurrency) break;
    const slot = pickSlot(job, lim);
    if (slot === null) continue; // все клоны этого проекта заняты — берём задачу из другого проекта
    start(job, slot);
  }
}

// Каждый поток внутри проекта работает в своём клоне (слоте): /task_branch переключает ветки
// и требует чистого дерева, поэтому два задания не могут делить одну папку.
function pickSlot(job, lim) {
  const used = busy.get(job.repo) || new Set();
  // продолжение сессии (исправление CI, указание) — только в том же клоне, где она началась
  if ((job.followUp || job.diagnose) && job.sessionId && job.slot != null) return used.has(job.slot) ? null : job.slot;
  for (let s = 0; s < lim.perRepoConcurrency; s++) if (!used.has(s)) return s;
  return null;
}

function start(job, slot) {
  const ac = new AbortController();
  running.set(job.id, ac);
  if (!busy.has(job.repo)) busy.set(job.repo, new Set());
  busy.get(job.repo).add(slot);
  job.slot = slot;
  if (cfg.preventSleep) setKeepAwake(true);
  if (!job.diagnose) store.closeActionsForJob(job.id, ['failed', 'blocked', 'ci_failed']);
  store.updateJob(job.id, { status: 'running', error: null, slot, startedAt: new Date().toISOString() });

  execute(job, ac)
    .catch(async (e) => {
      const cancelled = ac.signal.aborted;
      store.updateJob(job.id, { status: cancelled ? 'cancelled' : 'failed', error: e.message, diagnose: null, approvedCommands: [] });
      store.logEvent(job.id, { kind: 'error', text: e.message });
      if (cancelled) return;
      const action = store.addAction({
        jobId: job.id, jobTitle: job.title, repo: job.repo, kind: 'failed',
        title: job.kind === 'fix' ? 'Решение не выполнено' : 'Задание упало', text: e.message,
      });
      if (cfg.notifications) notify('Задание Claude упало', job.title);
      const clone = repos.clonePath(job.repo, slot);
      await attachRemedy(job, action, {
        error: e,
        reason: `Задание «${job.title}» упало с ошибкой:\n${e.message}`,
        cwd: fs.existsSync(path.join(clone, '.git')) ? clone : null,
        resume: job.sessionId || undefined,
        ac,
      });
    })
    .finally(() => {
      running.delete(job.id);
      busy.get(job.repo)?.delete(slot);
      if (!running.size) setKeepAwake(false);
      pump();
    });
}

async function execute(job, ac) {
  const r = repoList.find((x) => x.repo === job.repo) || { repo: job.repo, localPath: null };
  const log = (text) => store.logEvent(job.id, { kind: 'system', text });

  // Человек одобрил решение — Claude его выполняет, затем упавшее задание идёт заново
  if (job.kind === 'fix') {
    const p = job.proposal;
    const dir = p.where === 'local' ? r.localPath : await repos.ensureClone(r, log, job.slot || 0);
    if (!dir) throw new Error(`Для ${job.repo} не указан localPath — решение нужно выполнить в локальной папке`);
    log(`Выполняю одобренное решение в ${dir}`);
    const res = await runClaude({ job, cwd: dir, cfg, abortController: ac, prompt: remedy.applyPrompt(p) });
    store.updateJob(job.id, { approvedCommands: [] });
    if (!res.ok) throw new Error(res.text.slice(0, 800) || 'Claude не смог выполнить решение');
    store.updateJob(job.id, { status: 'done', lastActivity: 'Решение выполнено' });
    if (job.fixFor) {
      store.logEvent(job.fixFor, { kind: 'human', text: `Решение выполнено: ${p.summary}. Запускаю заново.` });
      retryJob(job.fixFor);
    }
    return;
  }

  // CI не чинится — Claude в той же сессии разбирает причину и предлагает решение
  if (job.diagnose) {
    const action = store.getAction(job.diagnose);
    store.updateJob(job.id, { diagnose: null });
    const dir = await repos.ensureClone(r, log, job.slot || 0);
    if (action) {
      await attachRemedy(job, action, {
        reason: `${action.title}. ${action.text}\nPR: ${job.prUrl}`,
        cwd: dir, resume: job.sessionId || undefined, ac,
      });
    }
    store.updateJob(job.id, { status: 'blocked' });
    return;
  }

  const cwd = await repos.prepareClone(r, log, job.slot || 0);
  log(`Рабочий клон: ${cwd}${job.slot ? ` (поток ${job.slot + 1} проекта)` : ''}`);
  const base = { job, cwd, cfg, abortController: ac };

  if (job.kind === 'issue') return executeIssue(job, base);

  if (job.kind === 'propose') {
    const res = await runClaude({ ...base, mode: 'readonly', prompt: proposalPrompt(job.repo) });
    const ideas = parseIdeas(res.text);
    for (const i of ideas.slice(0, cfg.proposals.perRun)) {
      store.addIdea({ repo: job.repo, title: i.title, type: i.type, size: i.size, rationale: i.rationale, description: i.description, jobId: job.id });
    }
    store.updateJob(job.id, { status: 'done', lastActivity: `Предложено идей: ${ideas.length}` });
    if (ideas.length && cfg.notifications) notify('Новые идеи для доработки', `${job.repo}: ${ideas.length}`);
    return;
  }

  if (job.kind === 'create') {
    const idea = store.state.ideas.find((i) => i.id === job.ideaId);
    const res = await runClaude({ ...base, prompt: `/task_create ${idea.title}\n\n${idea.description}` });
    const url = (res.text.match(new RegExp(`https://github\\.com/${job.repo}/issues/\\d+`, 'i')) || [])[0];
    if (!res.ok || !url) throw new Error(`/task_create не вернул ссылку на issue: ${res.text.slice(0, 500)}`);
    store.updateIdea(idea.id, { status: 'created', issueUrl: url });
    store.updateJob(job.id, { status: 'done', issueUrl: url, lastActivity: `Создан ${url}` });
    await syncRepo(r).catch(() => {}); // сразу подхватываем новый issue в очередь
    return;
  }

  if (job.kind === 'release') {
    const res = await runClaude({ ...base, prompt: 'Выпусти релиз с помощью скилла git-release по правилам из ~/.claude. PR develop → main уже смержен человеком.' });
    store.updateJob(job.id, { status: res.ok ? 'done' : 'failed', error: res.ok ? null : res.text.slice(0, 500) });
    return syncRepo(r).catch(() => {});
  }
}

async function executeIssue(job, base) {
  const url = job.issueUrl || issueUrl(job.repo, job.issueNumber);
  const isFix = !!job.followUp;
  const res = await runClaude({
    ...base,
    prompt: isFix ? job.followUp : `/task_complete ${url}`,
    resume: isFix && job.sessionId ? job.sessionId : undefined,
  });
  store.updateJob(job.id, { followUp: null, approvedCommands: [] });

  const prs = await gh.prsForBranch(job.repo, `issues-${job.issueNumber}`);
  const open = prs.find((p) => p.state === 'OPEN' && p.baseRefName === 'develop');
  if (open) {
    store.updateJob(job.id, { status: 'pr_open', prUrl: open.url, prSince: Date.now(), ciState: 'pending' });
    store.logEvent(job.id, { kind: 'system', text: `PR в develop: ${open.url}. Жду CI.` });
    return;
  }
  // team-lead вернул blocked/partial или Claude остановился на STOP-шаблоне
  store.updateJob(job.id, { status: 'blocked' });
  const report = res.text.replace(/```json[\s\S]*?```/g, '').trim();
  const action = store.addAction({
    jobId: job.id, jobTitle: job.title, repo: job.repo, kind: 'blocked',
    title: res.ok ? 'Claude остановился без PR' : 'Claude завершился с ошибкой',
    text: report.slice(0, 3000),
  });
  if (cfg.notifications) notify('Claude остановился без PR', job.title);
  const own = remedy.parseProposal(res.text);
  if (own) return store.updateAction(action.id, { proposal: own, proposalStatus: 'ready' });
  await attachRemedy(job, action, {
    reason: `Claude остановился без PR. Его последний ответ:\n${report.slice(-2000)}`,
    cwd: base.cwd, resume: store.getJob(job.id).sessionId || undefined, ac: base.abortController,
  });
}

// ======================= решения для остановок =======================
// Прикрепляет к карточке «Проблемы» предлагаемое решение: рецепт или разбор Claude (только чтение)
async function attachRemedy(job, action, { error, reason, cwd, resume, ac }) {
  if (!cfg.remedies.enabled || job.kind === 'fix') return;
  store.updateAction(action.id, { proposalStatus: 'pending' });
  try {
    const r = repoList.find((x) => x.repo === job.repo) || { repo: job.repo, localPath: null };
    let p = await remedy.knownRemedy(error, r);
    if (!p && cfg.remedies.diagnose && cwd) {
      store.updateJob(job.id, { lastActivity: 'Claude ищет решение проблемы' });
      const res = await runClaude({
        job, cwd, resume, mode: 'readonly', abortController: ac || new AbortController(),
        cfg: { ...cfg, maxTurns: Math.min(cfg.maxTurns, cfg.remedies.maxTurns) },
        prompt: remedy.diagnosePrompt(reason),
      });
      p = remedy.parseProposal(res.text);
    }
    store.updateAction(action.id, { proposal: p, proposalStatus: p ? 'ready' : 'none' });
    if (p) store.logEvent(job.id, { kind: 'human', text: `Предложено решение: ${p.summary}` });
  } catch (e) {
    store.updateAction(action.id, { proposalStatus: 'none' });
    store.logEvent(job.id, { kind: 'error', text: `Не удалось подготовить решение: ${e.message}` });
  }
}

// Человек одобрил решение (возможно, поправив текст). Команды не редактируются — только шаги.
export function applyRemedy(actionId, { summary, steps } = {}) {
  const a = store.getAction(actionId);
  if (!a || a.status !== 'open' || !a.proposal || a.proposal.needsHuman) return null;
  const job = store.getJob(a.jobId);
  if (!job || running.has(job.id)) return null;
  const p = {
    ...a.proposal,
    ...(String(summary || '').trim() ? { summary: String(summary).trim() } : {}),
    ...(Array.isArray(steps) ? { steps: steps.map((x) => String(x).trim()).filter(Boolean) } : {}),
  };
  store.resolveAction(actionId, { decision: 'apply', proposal: p });
  store.logEvent(job.id, { kind: 'human', text: `Решение одобрено: ${p.summary}` });

  // Задача с живой сессией: Claude выполняет решение в том же контексте и продолжает задачу
  if (job.kind === 'issue' && job.sessionId && p.where === 'clone') {
    store.closeActionsForJob(job.id);
    const url = job.issueUrl || issueUrl(job.repo, job.issueNumber);
    store.updateJob(job.id, { status: 'queued', followUp: remedy.applyPrompt(p, { url }), approvedCommands: p.commands, priority: 95 });
  } else {
    // Иначе — отдельное задание-исправление; после него упавшее задание запускается заново
    store.addJob({
      kind: 'fix', repo: job.repo, title: `Решение: ${p.summary}`, fixFor: job.id,
      proposal: p, approvedCommands: p.commands, priority: 95,
    });
  }
  pump();
  return p;
}

// ======================= PR → develop: CI и автомерж =======================
let monitoring = false;
export async function monitorPrs() {
  if (monitoring) return;
  monitoring = true;
  try {
    const prs = store.jobs.filter((j) => j.kind === 'issue' && j.status === 'pr_open' && !running.has(j.id));
    await repos.mapLimit(prs, cfg.ioConcurrency, (job) =>
      checkPr(job).catch((e) => store.logEvent(job.id, { kind: 'error', text: `Проверка PR: ${e.message}` })));
  } finally {
    monitoring = false;
    pump();
  }
}

async function checkPr(job) {
  const number = Number(String(job.prUrl).split('/').pop());
  const pr = await gh.prDetails(job.repo, number);
  if (pr.state === 'MERGED') return toDevelop(job, 'PR смержен');
  if (pr.state === 'CLOSED') return store.updateJob(job.id, { status: 'cancelled', error: 'PR закрыт вручную' });

  const checks = gh.summarizeChecks(pr.statusCheckRollup);
  const fresh = Date.now() - (job.prSince || 0) < 3 * 60_000;
  if (pr.mergeable === 'CONFLICTING') return requestFix(job, 'conflict');
  if (checks.state === 'failure') return requestFix(job, 'ci', checks.failed);
  if (checks.state === 'pending' || pr.mergeable === 'UNKNOWN' || (fresh && !pr.statusCheckRollup?.length)) {
    if (job.ciState !== 'pending') store.updateJob(job.id, { ciState: 'pending' });
    return;
  }
  store.updateJob(job.id, { ciState: 'success' });
  if (!cfg.autoMergeToDevelop) return;
  if (pr.isDraft) await gh.markReady(job.repo, number);
  await gh.mergeToDevelop(job.repo, number);
  toDevelop(job, 'CI зелёный — squash-merge в develop');
}

function toDevelop(job, why) {
  store.updateJob(job.id, { status: 'in_develop', ciState: 'success' });
  store.logEvent(job.id, { kind: 'result', ok: true, text: `${why}. Issue остаётся открытым до релиза (git-release).` });
  if (cfg.notifications) notify('Задача влита в develop', job.title);
  refreshRelease(job.repo).catch(() => {});
}

function requestFix(job, reason, failed = []) {
  if (job.fixAttempts >= cfg.maxCiFixAttempts) {
    store.updateJob(job.id, { status: 'blocked', ciState: reason });
    const action = store.addAction({
      jobId: job.id, jobTitle: job.title, repo: job.repo, kind: 'ci_failed', url: job.prUrl,
      title: reason === 'conflict' ? 'Конфликт с develop не решён' : 'CI не проходит',
      text: `Попыток исправления: ${job.fixAttempts}. ${failed.length ? 'Упали: ' + failed.join(', ') : ''}`,
    });
    if (cfg.notifications) notify('Нужна помощь с PR', job.title);
    if (cfg.remedies.enabled && cfg.remedies.diagnose && job.sessionId) {
      store.updateAction(action.id, { proposalStatus: 'pending' });
      store.updateJob(job.id, { status: 'queued', diagnose: action.id, priority: 100 });
    }
    return;
  }
  const url = job.issueUrl || issueUrl(job.repo, job.issueNumber);
  const what = reason === 'conflict'
    ? `PR ${job.prUrl} конфликтует с develop. Выполни /task_branch ${url} (он вольёт develop в ветку), разреши конфликты, проверь тесты и отправь через /task_submit.`
    : `CI для PR ${job.prUrl} упал${failed.length ? ` (проверки: ${failed.join(', ')})` : ''}. Выполни /task_branch ${url}, посмотри логи (gh pr checks, gh run view --log-failed), исправь причину и отправь через /task_submit. Не отключай проверки и не используй --no-verify.`;
  store.logEvent(job.id, { kind: 'human', text: `Автоисправление (${job.fixAttempts + 1}/${cfg.maxCiFixAttempts}): ${reason === 'conflict' ? 'конфликт' : 'CI упал'}` });
  store.updateJob(job.id, { status: 'queued', followUp: what, fixAttempts: job.fixAttempts + 1, priority: 100 });
}

// ======================= управление из UI =======================
export function cancelJob(id) {
  const ac = running.get(id);
  if (ac) ac.abort();
  const job = store.getJob(id);
  store.updateJob(id, { status: job?.kind === 'issue' && !ac ? 'skipped' : 'cancelled' });
  store.closeActionsForJob(id);
}

export function retryJob(id) {
  if (running.has(id)) return;
  store.closeActionsForJob(id);
  store.updateJob(id, { status: 'queued', error: null, followUp: null, fixAttempts: 0 });
  pump();
}

export function followUpJob(id, message) {
  const job = store.getJob(id);
  if (!job || running.has(id)) return;
  store.closeActionsForJob(id);
  const url = job.issueUrl || issueUrl(job.repo, job.issueNumber);
  const prompt = job.kind === 'issue'
    ? `Комментарий разработчика: ${message}\n\nВыполни /task_branch ${url}, внеси изменения и отправь через /task_submit.`
    : message;
  store.updateJob(id, { status: 'queued', followUp: prompt, priority: 90 });
  pump();
}

export function prioritizeJob(id) {
  store.updateJob(id, { priority: 70 });
  pump();
}

export function setPaused(paused) {
  store.setPaused(paused);
  if (!paused) pump();
}

// ======================= промпт для идей =======================
function proposalPrompt(repo) {
  const open = store.jobs.filter((j) => j.kind === 'issue' && j.repo === repo && !['released', 'closed'].includes(j.status)).map((j) => `#${j.issueNumber} ${j.title}`);
  const known = store.state.ideas.filter((i) => i.repo === repo).map((i) => `${i.title} (${i.status === 'rejected' ? 'отклонено' : 'уже предложено'})`);
  return `Проанализируй проект ${repo} (ветка develop) и предложи до ${cfg.proposals.perRun} доработок:
- исправления ошибок, которые ты действительно нашёл в коде (укажи файл и место);
- расширение функционала, полезное пользователям этого open source проекта;
- важные улучшения надёжности, тестов, документации.

Не повторяй уже открытые issues:
${open.join('\n') || '(нет)'}

Не повторяй уже предложенные или отклонённые идеи:
${known.join('\n') || '(нет)'}

Это только анализ: не меняй файлы, не создавай issues, не запускай /task_create, не задавай вопросов.
Лучше меньше, но конкретнее. Если толковых идей нет — верни пустой массив.

В конце ответа выведи ровно один блок \`\`\`json с массивом объектов:
{"title": "короткий заголовок", "type": "bug|feature|refactor|docs", "size": "S|M|L", "rationale": "почему это важно, 1–2 предложения", "description": "описание задачи для /task_create: что сделать, где в коде, критерии готовности"}
Пиши по-русски.`;
}

export function parseIdeas(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return [];
  try {
    const arr = JSON.parse(blocks[blocks.length - 1][1]);
    return Array.isArray(arr) ? arr.filter((i) => i && i.title && i.description) : [];
  } catch {
    return [];
  }
}
