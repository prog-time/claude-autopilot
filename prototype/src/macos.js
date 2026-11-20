// macOS-интеграция: уведомления и запрет сна, пока Claude работает.
import { spawn, execFile } from 'node:child_process';

const isMac = process.platform === 'darwin';
let caffeinate = null;

export function notify(title, message, url) {
  if (!isMac) return;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 200);
  const script = `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`;
  execFile('osascript', ['-e', script], () => {});
}

// Не даём Mac уснуть, пока есть выполняющиеся задачи (экран при этом гаснуть может).
export function setKeepAwake(on) {
  if (!isMac) return;
  if (on && !caffeinate) {
    caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    caffeinate.on('exit', () => { caffeinate = null; });
  } else if (!on && caffeinate) {
    caffeinate.kill();
    caffeinate = null;
  }
}

export function openUrl(url) {
  if (isMac) execFile('open', [url], () => {});
}
