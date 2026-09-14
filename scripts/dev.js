// 一键并行启动后端与前端
import { spawn } from 'node:child_process';

const procs = [
  ['API 服务', 'npm', ['--prefix', 'server', 'start']],
  ['Web 前端', 'npm', ['--prefix', 'client', 'run', 'dev']],
];

const children = procs.map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${name}]`;
  p.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(tag, l)));
  p.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.error(tag, l)));
  return p;
});

function shutdown() { children.forEach((p) => p.kill()); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
