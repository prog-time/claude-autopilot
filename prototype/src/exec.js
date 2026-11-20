import { execFile } from 'node:child_process';

// Promise-обёртка над execFile без shell — аргументы не интерпретируются оболочкой.
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} ${args.join(' ')}\n${stderr || err.message}`;
        return reject(err);
      }
      resolve(stdout.trim());
    });
  });
}
