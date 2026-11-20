// Предлагаемые решения для остановок, где нужен человек.
//
// Задание упало или Claude остановился → в карточке «Проблемы» появляется решение:
//   1) известная проблема (нет develop, пустой репозиторий) — готовый рецепт, без Claude;
//   2) Claude остановился сам — он заканчивает ответ блоком ```json {"proposal": …};
//   3) иначе — короткая сессия Claude «только чтение» разбирает причину и предлагает решение.
// Человек правит и одобряет → Claude выполняет; команды из решения идут без повторного вопроса.
import * as repos from './repos.js';

// Решение: { summary, steps[], commands[], where: 'clone'|'local', needsHuman, source }
export function normalize(p, source) {
  if (!p || typeof p !== 'object') return null;
  if (p.proposal) p = p.proposal;
  const summary = String(p.summary || '').trim();
  if (!summary) return null;
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    summary,
    steps: list(p.steps),
    commands: list(p.commands).slice(0, 20),
    where: p.where === 'local' ? 'local' : 'clone',
    needsHuman: !!p.needsHuman,
    source,
  };
}

// Последний блок ```json в ответе Claude, если в нём есть решение
export function parseProposal(text) {
  const blocks = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/g)];
  for (const b of blocks.reverse()) {
    try {
      const p = normalize(JSON.parse(b[1]), 'claude');
      if (p) return p;
    } catch { /* не JSON — смотрим предыдущий блок */ }
  }
  return null;
}

// Рецепты для известных проблем. Возвращает решение или null.
export async function knownRemedy(error, r) {
  if (error?.code !== 'NO_DEVELOP') return null;
  const dir = repos.clonePath(r.repo);
  const branches = await repos.remoteBranches(dir).catch(() => null);
  if (!branches) return null;

  if (branches.length) {
    const base = ['main', 'master'].find((b) => branches.includes(b)) || branches[0];
    return {
      summary: `Создать ветку develop из ${base} и отправить её на GitHub`,
      steps: [`Создать develop от текущего origin/${base}`, 'Отправить develop на GitHub', 'Запустить упавшее задание заново'],
      commands: [`git push origin origin/${base}:refs/heads/develop`],
      where: 'clone', needsHuman: false, source: 'autopilot',
    };
  }

  // Репозиторий на GitHub пустой — код есть только в вашей локальной папке
  const local = await repos.localRepoInfo(r.localPath, r.repo);
  if (!local) {
    return {
      summary: 'Репозиторий на GitHub пустой, а локальной копии с этим origin не найдено',
      steps: [`Отправьте код проекта в ${r.repo}: ветки main и develop`, 'Или укажите localPath в config.json — тогда Claude сделает это сам'],
      commands: [], where: 'local', needsHuman: true, source: 'autopilot',
    };
  }
  const branch = local.branch || 'main';
  const commands = [];
  if (!local.hasCommits) commands.push('git add -A', 'git commit -m "Начальная версия проекта"');
  commands.push(`git push -u origin ${branch}`, `git push origin ${branch}:develop`);
  return {
    summary: `Отправить проект из ${r.localPath} на GitHub: ветки ${branch} и develop`,
    steps: [
      ...(local.hasCommits ? [] : ['Сделать первый коммит из всех файлов папки (.gitignore соблюдается)']),
      `Отправить ${branch} на GitHub`,
      `Создать develop из ${branch}`,
      'Запустить упавшее задание заново',
    ],
    commands, where: 'local', needsHuman: false, source: 'autopilot',
  };
}

const FORMAT = `В конце ответа выведи ровно один блок \`\`\`json:
{"summary": "что сделать, одной фразой", "steps": ["шаг 1", "шаг 2"], "commands": ["точные shell-команды, которые нужно выполнить и которые иначе потребуют подтверждения"], "needsHuman": false}
Если без человека не обойтись (доступы, секреты, оплата, решение по продукту) — "needsHuman": true, а в steps — что именно должен сделать человек.`;

// Для AUTONOMY_NOTE: Claude сам предлагает решение, когда останавливается
export const STOP_NOTE = `- Если останавливаешься без результата, потому что нужен человек (нет доступа, запрет, неясное требование, ошибка окружения), — предложи конкретное решение, которое ты выполнишь сам после одобрения. ${FORMAT.replace('В конце ответа выведи ровно один блок', 'Для этого закончи ответ блоком')}`;

export function diagnosePrompt(reason) {
  return `Задание остановилось, и теперь нужен человек. Причина:
${reason}

Разберись в причине (только чтение: ничего не меняй, ничего не спрашивай) и предложи конкретное решение, которое ты сможешь выполнить сам, когда человек его одобрит. Решение должно вернуть задание в работу. Пиши по-русски, коротко.

${FORMAT}`;
}

export function applyPrompt(p, { url } = {}) {
  const where = p.where === 'local' ? 'Ты работаешь в локальной папке разработчика — делай только перечисленное, больше ничего в ней не меняй.' : '';
  const cmds = p.commands.length
    ? `\n\nРазработчик одобрил эти команды — выполни их как есть, по одной, не меняя:\n${p.commands.map((c) => `$ ${c}`).join('\n')}`
    : '';
  const tail = url ? `\n\nКогда закончишь, продолжи задачу: /task_branch ${url}, затем /task_submit.` : '';
  return `Разработчик одобрил решение проблемы, из-за которой задание остановилось. Выполни его.

Решение: ${p.summary}
${p.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${cmds}

${where} Если по ходу выяснится, что решение не подходит, — остановись и опиши, что не так.${tail}`.trim();
}
