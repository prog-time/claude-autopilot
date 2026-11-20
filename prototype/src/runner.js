// Запуск Claude через Agent SDK.
// settingSources: ['user', 'project', 'local'] — подхватываются ваши ~/.claude/CLAUDE.md,
// команды /task_*, скиллы, агенты и хуки (pr-base-guard и др.), как в обычном Claude Code.
// canUseTool — решает, что Claude может делать сам, а что уходит вам на подтверждение.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { store } from './store.js';
import { notify } from './macos.js';
import { STOP_NOTE } from './remedy.js';

const pending = new Map(); // actionId -> { resolve, jobId }

export function resolveHumanAction(actionId, payload) {
  const p = pending.get(actionId);
  const action = store.resolveAction(actionId, payload);
  if (p) { pending.delete(actionId); p.resolve(payload); }
  return action;
}

function waitForHuman(job, cfg, data, signal) {
  const action = store.addAction({ jobId: job.id, jobTitle: job.title, repo: job.repo, ...data });
  store.updateJob(job.id, { status: 'waiting_human' });
  store.logEvent(job.id, { kind: 'human', text: `Ждёт вашего решения: ${data.title}`, actionId: action.id });
  if (cfg.notifications) notify('Claude ждёт вашего решения', `${job.title}: ${data.title}`);
  return new Promise((resolve) => {
    pending.set(action.id, { resolve, jobId: job.id });
    signal?.addEventListener('abort', () => {
      if (pending.has(action.id)) resolveHumanAction(action.id, { decision: 'deny', message: 'Задание отменено' });
    });
  }).then((answer) => {
    const stillWaiting = [...pending.values()].some((p) => p.jobId === job.id);
    if (!stillWaiting && store.getJob(job.id)?.status === 'waiting_human') store.updateJob(job.id, { status: 'running' });
    return answer;
  });
}

// ---------- политика разрешений ----------
const splitShell = (cmd) => cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
const READONLY_BASH = ['ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg', 'jq', 'pwd', 'cd', 'tree',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git ls-files', 'git rev-parse', 'git rev-list',
  'git ls-remote', 'git remote', 'git stash list',
  'gh issue list', 'gh issue view', 'gh pr list', 'gh pr view', 'gh pr checks', 'gh pr diff', 'gh run list', 'gh run view',
  'gh repo view', 'gh label list', 'gh auth status'];

function bashAllowed(command, prefixes, askPatterns) {
  if (askPatterns.some((p) => command.includes(p))) return false;
  if (/\$\(|`/.test(command)) return false;
  return splitShell(command).every((part) => {
    const p = part.replace(/^(\w+=\S+\s+)+/, ''); // FOO=bar cmd
    return prefixes.some((pre) => p === pre || p.startsWith(pre.endsWith(' ') || pre.endsWith('/') || pre.endsWith('-') ? pre : pre + ' '));
  });
}

function makeCanUseTool(job, cfg, mode) {
  const perms = cfg.permissions;
  return async (toolName, input, { signal }) => {
    const allow = { behavior: 'allow', updatedInput: input };

    if (mode === 'readonly') {
      if (['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'Task', 'Agent', 'WebSearch', 'WebFetch'].includes(toolName)) return allow;
      if (toolName === 'Bash' && bashAllowed(String(input.command || ''), READONLY_BASH, ['>', '--force'])) return allow;
      return { behavior: 'deny', message: 'Это задание только для анализа: ничего не меняй, не создавай задачи и не задавай вопросов. Верни ответ в требуемом формате.' };
    }

    if (toolName === 'AskUserQuestion') {
      const answer = await waitForHuman(job, cfg, { kind: 'question', title: 'Claude задаёт вопрос', questions: input.questions || [] }, signal);
      if (answer.decision === 'deny') return { behavior: 'deny', message: answer.message || 'Пользователь пропустил вопрос — прими разумное решение сам и отметь его в отчёте.' };
      return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers || {} } };
    }
    if (perms.autoAllowTools.includes(toolName)) return allow;
    // Команды из решения, которое человек уже одобрил в панели, — без повторного вопроса
    const approved = store.getJob(job.id)?.approvedCommands || [];
    if (toolName === 'Bash' && approved.includes(String(input.command || '').trim())) return allow;
    if (toolName === 'Bash' && bashAllowed(String(input.command || ''), perms.autoAllowBashPrefixes, perms.alwaysAskBashPatterns)) return allow;

    const answer = await waitForHuman(job, cfg, { kind: 'permission', title: `Разрешить ${toolName}?`, tool: toolName, input }, signal);
    if (answer.decision === 'allow') return allow;
    return { behavior: 'deny', message: answer.message || 'Пользователь запретил это действие. Не обходи запрет: найди другой способ или остановись с отчётом.' };
  };
}

// ---------- журнал ----------
function summarize(name, input = {}) {
  if (name === 'Bash') return input.command;
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return input.file_path || input.notebook_path;
  if (name === 'Grep') return `${input.pattern}${input.path ? ' в ' + input.path : ''}`;
  if (name === 'Glob') return input.pattern;
  if (name === 'Skill') return input.skill || input.command || JSON.stringify(input);
  if (name === 'Task' || name === 'Agent') return `${input.subagent_type || ''} ${input.description || ''}`.trim();
  if (name === 'SlashCommand') return input.command;
  if (name === 'TodoWrite') return `${(input.todos || []).length} пунктов плана`;
  return JSON.stringify(input).slice(0, 200);
}

function handleMessage(job, msg) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    store.updateJob(job.id, { sessionId: msg.session_id });
    store.logEvent(job.id, { kind: 'system', text: `Сессия ${msg.session_id}, модель ${msg.model}` });
  } else if (msg.type === 'assistant') {
    // сообщения сабагентов (team-lead → backend-agent и т.д.) помечаем
    const sub = msg.parent_tool_use_id ? '↳ ' : '';
    for (const b of msg.message?.content || []) {
      if (b.type === 'text' && b.text.trim()) {
        store.logEvent(job.id, { kind: 'text', text: sub + b.text });
        store.updateJob(job.id, { lastActivity: b.text.slice(0, 160) });
      } else if (b.type === 'tool_use') {
        const s = summarize(b.name, b.input);
        store.logEvent(job.id, { kind: 'tool', tool: sub + b.name, text: s });
        store.updateJob(job.id, { lastActivity: `${b.name}: ${String(s).slice(0, 140)}` });
        if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos) && !msg.parent_tool_use_id) store.updateJob(job.id, { todos: b.input.todos });
      }
    }
  } else if (msg.type === 'user') {
    for (const b of msg.message?.content || []) {
      if (b.type === 'tool_result' && b.is_error) {
        const t = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : String(b.content || '');
        store.logEvent(job.id, { kind: 'tool_error', text: t.slice(0, 1200) });
      }
    }
  } else if (msg.type === 'result') {
    const j = store.getJob(job.id);
    store.updateJob(job.id, {
      costUsd: (j.costUsd || 0) + (msg.total_cost_usd || 0),
      turns: (j.turns || 0) + (msg.num_turns || 0),
      resultText: msg.result || null,
    });
    store.logEvent(job.id, { kind: 'result', ok: msg.subtype === 'success' && !msg.is_error, text: msg.result || msg.subtype, costUsd: msg.total_cost_usd });
  }
}

const AUTONOMY_NOTE = `
Ты работаешь автономно через claude-autopilot, пока разработчик занят другим. Человек следит за тобой через веб-панель.
- Строго следуй правилам из ~/.claude/CLAUDE.md, CLAUDE.md проекта и командам /task_*.
- Веди план через TodoWrite — по нему человек видит прогресс.
- Если нужен выбор человека — спроси через AskUserQuestion. Если запрет — не обходи его.
- Не мержи PR и не трогай main: мерж в develop делает autopilot после зелёного CI, develop → main — человек.
${STOP_NOTE}`;

// mode: 'work' | 'readonly'
export async function runClaude({ job, cwd, prompt, resume, mode = 'work', cfg, abortController }) {
  store.logEvent(job.id, { kind: 'system', text: `Промпт: ${prompt.length > 400 ? prompt.slice(0, 400) + '…' : prompt}` });
  const stream = query({
    prompt,
    options: {
      cwd,
      model: cfg.model || undefined,
      maxTurns: cfg.maxTurns,
      permissionMode: mode === 'readonly' ? 'default' : 'acceptEdits',
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: AUTONOMY_NOTE },
      canUseTool: makeCanUseTool(job, cfg, mode),
      abortController,
      resume,
    },
  });
  let result = null;
  for await (const msg of stream) {
    handleMessage(job, msg);
    if (msg.type === 'result') result = msg;
  }
  const ok = !!result && result.subtype === 'success' && !result.is_error;
  return { ok, text: result?.result || '', subtype: result?.subtype };
}
