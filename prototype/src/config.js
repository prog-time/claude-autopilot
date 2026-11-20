import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.AUTOPILOT_DATA || path.join(os.homedir(), '.claude-autopilot');
export const CLONES_DIR = path.join(DATA_DIR, 'repos');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');

export const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

export function loadConfig() {
  const file = process.env.AUTOPILOT_CONFIG || path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) {
    console.error(`Нет файла конфигурации: ${file}\nСкопируйте config.example.json в config.json.`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.port ??= 4777;
  cfg.pollIntervalMinutes ??= 5;
  cfg.concurrency ??= 4;            // всего одновременных сессий Claude
  cfg.perRepoConcurrency ??= 1;     // задач одновременно в одном проекте (каждая — в своём клоне)
  cfg.ioConcurrency ??= 6;          // параллельных запросов к GitHub при опросе
  cfg.maxTurns ??= 150;
  cfg.repos ??= [];
  cfg.scan ??= { dirs: [], owners: [], exclude: [] };
  cfg.issues ??= {};
  cfg.issues.skipLabels ??= ['wontfix', 'question', 'claude:skip'];
  cfg.issues.onlyLabels ??= [];
  cfg.autoMergeToDevelop ??= true;
  cfg.maxCiFixAttempts ??= 2;
  cfg.proposals = { enabled: true, intervalHours: 24, maxPendingPerRepo: 5, perRun: 3, ...(cfg.proposals || {}) };
  // Предлагать решение, когда задание остановилось: рецепты + разбор Claude (только чтение)
  cfg.remedies = { enabled: true, diagnose: true, maxTurns: 30, ...(cfg.remedies || {}) };
  cfg.notifications ??= true;
  cfg.preventSleep ??= true;
  cfg.permissions ??= {};
  cfg.permissions.autoAllowTools ??= ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite'];
  cfg.permissions.autoAllowBashPrefixes ??= [];
  cfg.permissions.alwaysAskBashPatterns ??= [];
  for (const dir of [DATA_DIR, CLONES_DIR, LOGS_DIR]) fs.mkdirSync(dir, { recursive: true });
  return cfg;
}
