import { spawn } from 'node:child_process';

// npm scripts run under cmd.exe on Windows, where `a & b` is sequential rather than a
// background job. Spawn both workspaces directly so the documented root command behaves the
// same on every platform and either child shutting down also retires the other one.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['run', 'dev', '--workspace=server'], { stdio: 'inherit' }),
  spawn(npm, ['run', 'dev', '--workspace=web'], { stdio: 'inherit' }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = code;
}

for (const child of children) {
  child.on('error', (err) => {
    console.error(err);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
