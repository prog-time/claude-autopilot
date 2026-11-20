// Репозитории: поиск локальных проектов и рабочие клоны autopilot.
//
// Claude работает НЕ в ваших папках, а в отдельном клоне каждого репозитория
// (~/.claude-autopilot/repos/owner__repo). Ваши команды /task_* переключают ветки
// и требуют чистого дерева — в собственном клоне это никому не мешает.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { CLONES_DIR, expandHome } from './config.js';
import * as gh from './github.js';

const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);

function slugFromUrl(url) {
  const m = String(url).match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
  return m ? m[1] : null;
}

// Явный список + автопоиск git-репозиториев с origin на github.com/<owner>
export async function discoverRepos(cfg) {
  const found = new Map();
  for (const r of cfg.repos) {
    found.set(r.repo, { repo: r.repo, localPath: r.localPath ? path.resolve(expandHome(r.localPath)) : null });
  }
  const owners = (cfg.scan.owners || []).map((o) => o.toLowerCase());
  const exclude = new Set(cfg.scan.exclude || []);
  for (const dir of cfg.scan.dirs || []) {
    const root = expandHome(dir);
    if (!fs.existsSync(root)) continue;
    const candidates = [];
    for (const a of fs.readdirSync(root, { withFileTypes: true })) {
      if (!a.isDirectory() || a.name.startsWith('.')) continue;
      const p = path.join(root, a.name);
      if (fs.existsSync(path.join(p, '.git'))) candidates.push(p);
      else {
        for (const b of fs.readdirSync(p, { withFileTypes: true })) {
          if (b.isDirectory() && fs.existsSync(path.join(p, b.name, '.git'))) candidates.push(path.join(p, b.name));
        }
      }
    }
    for (const p of candidates) {
      const url = await git(p, 'remote', 'get-url', 'origin').catch(() => null);
      const slug = url && slugFromUrl(url);
      if (!slug || exclude.has(slug) || found.has(slug)) continue;
      if (owners.length && !owners.includes(slug.split('/')[0].toLowerCase())) continue;
      found.set(slug, { repo: slug, localPath: p });
    }
  }
  return [...found.values()];
}

// Слот 0 — основной клон; слоты 1..N — дополнительные клоны для параллельных задач в одном проекте
export const clonePath = (repo, slot = 0) => path.join(CLONES_DIR, repo.replace('/', '__') + (slot ? `@${slot}` : ''));

export class NoDevelopError extends Error {
  constructor(repo) {
    super(`В ${repo} нет ветки origin/develop — ваш git-flow требует её`);
    this.code = 'NO_DEVELOP';
    this.repo = repo;
  }
}

// Создаёт клон при первом обращении и приводит его в исходное состояние перед заданием
export async function prepareClone(r, log = () => {}, slot = 0) {
  const dir = await ensureClone(r, log, slot);
  const hasDevelop = await git(dir, 'rev-parse', '--verify', '--quiet', 'origin/develop').then(() => true, () => false);
  if (!hasDevelop) throw new NoDevelopError(r.repo);

  // Если прошлое задание оставило изменения — не удаляем, а убираем в stash
  const dirty = await git(dir, 'status', '--porcelain');
  if (dirty) {
    await git(dir, 'stash', 'push', '-u', '-m', `autopilot ${new Date().toISOString()}`);
    log('В клоне были незакоммиченные изменения — сохранены в git stash');
  }
  await git(dir, 'switch', 'develop').catch(() => git(dir, 'switch', '-c', 'develop', 'origin/develop'));
  await git(dir, 'merge', '--ff-only', 'origin/develop');
  return dir;
}

// Клон есть, исключения прописаны, origin свежий. Ветки не трогает — так клон годится
// и для заданий-исправлений, которые сами чинят репозиторий (например, создают develop).
export async function ensureClone({ repo, localPath }, log = () => {}, slot = 0) {
  const dir = clonePath(repo, slot);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    log(`Клонирую ${repo} в ${dir}`);
    const url = await gh.originUrl(repo);
    await run('git', ['clone', url, dir]);
  }

  // Локальные файлы ваших команд не должны делать дерево «грязным» для /task_branch
  const exclude = path.join(dir, '.git', 'info', 'exclude');
  const ex = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  const need = ['tasks/', 'github-tasks.json', '.claude/settings.local.json'].filter((l) => !ex.includes(l));
  if (need.length) fs.appendFileSync(exclude, `\n# claude-autopilot\n${need.join('\n')}\n`);

  // Локальные (неотслеживаемые) настройки проекта .claude/ копируем из вашей папки
  if (localPath && fs.existsSync(path.join(localPath, '.claude'))) {
    for (const f of fs.readdirSync(path.join(localPath, '.claude'))) {
      const rel = path.join('.claude', f);
      const tracked = await git(dir, 'ls-files', '--error-unmatch', rel).then(() => true, () => false);
      if (!tracked) fs.cpSync(path.join(localPath, rel), path.join(dir, rel), { recursive: true });
    }
  }

  await git(dir, 'fetch', 'origin', '--prune');
  return dir;
}

// Ветки на GitHub (для диагностики): [] — репозиторий пустой
export async function remoteBranches(dir) {
  const out = await git(dir, 'ls-remote', '--heads', 'origin');
  return out ? out.split('\n').map((l) => l.split('refs/heads/')[1]).filter(Boolean) : [];
}

// Состояние локальной папки разработчика: та ли это копия, есть ли коммиты, какая ветка
export async function localRepoInfo(localPath, repo) {
  if (!localPath || !fs.existsSync(path.join(localPath, '.git'))) return null;
  const url = await git(localPath, 'remote', 'get-url', 'origin').catch(() => null);
  if (!url || slugFromUrl(url)?.toLowerCase() !== repo.toLowerCase()) return null;
  const branch = await git(localPath, 'symbolic-ref', '--short', 'HEAD').catch(() => null);
  const hasCommits = await git(localPath, 'rev-parse', '--verify', '--quiet', 'HEAD').then(() => true, () => false);
  return { branch, hasCommits };
}

// Что лежит в develop и ещё не попало в main (без merge-коммитов sync-develop)
export async function releaseInfo(repo) {
  const dir = clonePath(repo);
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  await git(dir, 'fetch', 'origin', '--prune');
  const hasMain = await git(dir, 'rev-parse', '--verify', '--quiet', 'origin/main').then(() => true, () => false);
  if (!hasMain) return null;
  const log = await git(dir, 'log', '--no-merges', '--format=%s', 'origin/main..origin/develop');
  const commits = log ? log.split('\n') : [];
  return { ahead: commits.length, commits: commits.slice(0, 30) };
}

// Простой ограничитель параллельности для пачки асинхронных задач
export async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}
