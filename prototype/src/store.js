// Состояние приложения: задания Claude (jobs), идеи, релизы, действия для человека.
// Один JSON-файл + журнал каждого задания в logs/<id>.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, LOGS_DIR } from './config.js';

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const uid = () => randomUUID().slice(0, 8);
const now = () => new Date().toISOString();

class Store extends EventEmitter {
  constructor() {
    super();
    this.state = { jobs: [], ideas: [], actions: [], repos: {}, paused: false };
    if (fs.existsSync(STATE_FILE)) {
      try {
        this.state = { ...this.state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
      } catch (e) {
        console.error('state.json повреждён, начинаю с пустого состояния:', e.message);
      }
    }
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, STATE_FILE);
    }, 100);
  }

  emitChange(change) {
    this.save();
    this.emit('change', change);
  }

  // ---------- задания ----------
  // kind: issue | propose | create | release
  get jobs() { return this.state.jobs; }
  getJob(id) { return this.state.jobs.find((j) => j.id === id); }
  findIssueJob(repo, n) { return this.state.jobs.find((j) => j.kind === 'issue' && j.repo === repo && j.issueNumber === n); }

  addJob(data) {
    const job = {
      id: uid(), status: 'queued', createdAt: now(), updatedAt: now(),
      todos: [], lastActivity: null, costUsd: 0, turns: 0, sessionId: null,
      prUrl: null, error: null, followUp: null, fixAttempts: 0, priority: 0,
      ...data,
    };
    this.state.jobs.push(job);
    this.emitChange({ type: 'job', job });
    return job;
  }

  updateJob(id, patch) {
    const job = this.getJob(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: now() });
    this.emitChange({ type: 'job', job });
    return job;
  }

  logEvent(jobId, event) {
    const entry = { ts: now(), ...event };
    fs.appendFileSync(path.join(LOGS_DIR, `${jobId}.jsonl`), JSON.stringify(entry) + '\n');
    this.emit('change', { type: 'event', jobId, event: entry });
    return entry;
  }

  readEvents(jobId, limit = 800) {
    const file = path.join(LOGS_DIR, `${jobId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
  }

  // ---------- идеи ----------
  addIdea(data) {
    const idea = { id: uid(), status: 'pending', createdAt: now(), ...data };
    this.state.ideas.push(idea);
    this.emitChange({ type: 'idea', idea });
    return idea;
  }

  updateIdea(id, patch) {
    const idea = this.state.ideas.find((i) => i.id === id);
    if (!idea) return null;
    Object.assign(idea, patch);
    this.emitChange({ type: 'idea', idea });
    return idea;
  }

  // ---------- состояние репозиториев (релиз, ошибки) ----------
  setRepo(repo, patch) {
    this.state.repos[repo] = { ...(this.state.repos[repo] || {}), ...patch };
    this.emitChange({ type: 'repo', repo, data: this.state.repos[repo] });
  }

  // ---------- действия для человека (разрешения, вопросы, ошибки) ----------
  getAction(id) { return this.state.actions.find((a) => a.id === id); }

  addAction(data) {
    const action = { id: uid(), status: 'open', createdAt: now(), ...data };
    this.state.actions.push(action);
    this.emitChange({ type: 'action', action });
    return action;
  }

  updateAction(id, patch) {
    const a = this.getAction(id);
    if (!a) return null;
    Object.assign(a, patch);
    this.emitChange({ type: 'action', action: a });
    return a;
  }

  resolveAction(id, resolution) {
    const a = this.getAction(id);
    if (!a || a.status !== 'open') return null;
    Object.assign(a, { status: 'resolved', resolvedAt: now(), resolution });
    this.emitChange({ type: 'action', action: a });
    return a;
  }

  closeActionsForJob(jobId, kinds) {
    for (const a of this.state.actions) {
      if (a.jobId === jobId && a.status === 'open' && (!kinds || kinds.includes(a.kind))) this.resolveAction(a.id, { auto: true });
    }
  }

  setPaused(paused) {
    this.state.paused = paused;
    this.emitChange({ type: 'paused', paused });
  }
}

export const store = new Store();
