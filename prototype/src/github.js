// GitHub через gh CLI (авторизация из `gh auth login`). Каждый вызов с явным -R.
import { run } from './exec.js';

const json = async (args) => JSON.parse((await run('gh', args)) || 'null');

export const listOpenIssues = (repo) =>
  json(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '200',
    '--json', 'number,title,url,labels,assignees,createdAt']);

// Все PR из ветки issues-N (любое состояние)
export const prsForBranch = (repo, branch) =>
  json(['pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--json', 'number,url,state,baseRefName']);

export const prDetails = (repo, number) =>
  json(['pr', 'view', String(number), '-R', repo,
    '--json', 'number,url,state,baseRefName,headRefName,mergeable,mergeStateStatus,statusCheckRollup,isDraft']);

// Автомерж в develop: squash, как требует git-flow. Делает приложение, не Claude.
export const mergeToDevelop = (repo, number) =>
  run('gh', ['pr', 'merge', String(number), '-R', repo, '--squash', '--delete-branch']);

export const markReady = (repo, number) => run('gh', ['pr', 'ready', String(number), '-R', repo]).catch(() => {});

export const releasePr = async (repo) =>
  (await json(['pr', 'list', '-R', repo, '--base', 'main', '--head', 'develop', '--state', 'open', '--json', 'number,url,title']))?.[0] || null;

export const originUrl = (repo) => json(['repo', 'view', repo, '--json', 'url']).then((r) => r.url);

// Свод по проверкам CI: pending | success | failure
export function summarizeChecks(rollup = []) {
  if (!rollup.length) return { state: 'success', failed: [] };
  const failed = [];
  let pending = false;
  for (const c of rollup) {
    if (c.__typename === 'StatusContext' || c.state) {
      if (['PENDING', 'EXPECTED'].includes(c.state)) pending = true;
      else if (['FAILURE', 'ERROR'].includes(c.state)) failed.push(c.context);
    } else {
      if (c.status !== 'COMPLETED') pending = true;
      else if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)) failed.push(c.name || c.workflowName);
    }
  }
  return { state: failed.length ? 'failure' : pending ? 'pending' : 'success', failed };
}
