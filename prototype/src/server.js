// HTTP-сервер: REST API + Server-Sent Events + статика, без внешних зависимостей.
// Слушает только 127.0.0.1: через панель подтверждаются команды — не открывайте её наружу.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { store } from './store.js';
import { resolveHumanAction } from './runner.js';
import * as p from './pipeline.js';

const cfg = loadConfig();
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const clients = new Set();

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
async function body(req) {
  let d = '';
  for await (const c of req) d += c;
  return d ? JSON.parse(d) : {};
}

function snapshot() {
  const s = store.state;
  const dayAgo = Date.now() - 86_400_000;
  return {
    jobs: s.jobs,
    ideas: s.ideas.filter((i) => i.status === 'pending' || Date.parse(i.createdAt) > dayAgo),
    actions: s.actions.filter((a) => a.status === 'open'),
    repos: s.repos,
    paused: s.paused,
    pipeline: p.pipelineInfo(),
  };
}

store.on('change', (c) => {
  const msg = `data: ${JSON.stringify(c)}\n\n`;
  for (const res of clients) res.write(msg);
});

const ok = (res) => send(res, 200, { ok: true });
const routes = [
  ['GET', /^\/api\/state$/, (q, r) => send(r, 200, snapshot())],
  ['GET', /^\/api\/jobs\/(\w+)\/events$/, (q, r, [id]) => send(r, 200, store.readEvents(id))],
  ['POST', /^\/api\/sync$/, async (q, r) => { await p.syncAll(); ok(r); }],
  ['POST', /^\/api\/limits$/, async (q, r) => { p.setLimits(await body(q)); ok(r); }],
  ['POST', /^\/api\/pause$/, async (q, r) => { p.setPaused(!!(await body(q)).paused); ok(r); }],
  ['POST', /^\/api\/jobs\/(\w+)\/cancel$/, (q, r, [id]) => { p.cancelJob(id); ok(r); }],
  ['POST', /^\/api\/jobs\/(\w+)\/retry$/, (q, r, [id]) => { p.retryJob(id); ok(r); }],
  ['POST', /^\/api\/jobs\/(\w+)\/prioritize$/, (q, r, [id]) => { p.prioritizeJob(id); ok(r); }],
  ['POST', /^\/api\/jobs\/(\w+)\/followup$/, async (q, r, [id]) => {
    const { message } = await body(q);
    if (!message?.trim()) return send(r, 400, { error: 'Пустое сообщение' });
    p.followUpJob(id, message.trim()); ok(r);
  }],
  ['POST', /^\/api\/actions\/(\w+)\/resolve$/, async (q, r, [id]) => {
    if (!resolveHumanAction(id, await body(q))) return send(r, 404, { error: 'Действие уже закрыто' });
    ok(r);
  }],
  ['POST', /^\/api\/actions\/(\w+)\/apply$/, async (q, r, [id]) => {
    if (!p.applyRemedy(id, await body(q))) return send(r, 409, { error: 'Решение уже не актуально' });
    ok(r);
  }],
  ['POST', /^\/api\/ideas\/(\w+)\/approve$/, async (q, r, [id]) => { p.approveIdea(id, await body(q)); ok(r); }],
  ['POST', /^\/api\/ideas\/(\w+)\/reject$/, (q, r, [id]) => { p.rejectIdea(id); ok(r); }],
  ['POST', /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/propose$/, (q, r, [o, n]) => { p.scheduleProposals(`${o}/${n}`); ok(r); }],
  ['POST', /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/release$/, (q, r, [o, n]) => { p.startRelease(`${o}/${n}`); ok(r); }],
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    for (const [method, re, h] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return await h(req, res, m.slice(1));
    }
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`claude-autopilot: http://localhost:${cfg.port}`);
  p.initPipeline(cfg);
});
