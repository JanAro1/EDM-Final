#!/usr/bin/env node
/**
 * Start the MediData development processes with prefixed, colour-coded logs.
 *
 *   node scripts/dev.mjs            # api + worker + web
 *   node scripts/dev.mjs api web    # subset
 *
 * Ctrl+C stops every child (including grand-children on Windows).
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = join(root, 'backend');
const frontend = join(root, 'frontend');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

const SERVICES = {
  api: {
    label: 'api   ',
    color: '36',
    command: 'npm',
    args: ['--prefix', backend, 'run', 'dev:api'],
  },
  worker: {
    label: 'worker',
    color: '35',
    command: 'npm',
    args: ['--prefix', backend, 'run', 'dev:worker'],
  },
  web: {
    label: 'web   ',
    color: '32',
    command: 'npm',
    args: ['--prefix', frontend, 'run', 'dev'],
  },
};

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const names = requested.length > 0 ? requested : ['api', 'worker', 'web'];
const unknown = names.filter((name) => !SERVICES[name]);
if (unknown.length > 0) {
  console.error(`Unknown service(s): ${unknown.join(', ')}. Choose from: ${Object.keys(SERVICES).join(', ')}`);
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function prefixStream(stream, service) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      process.stdout.write(`${paint(service.color, `[${service.label}]`)} ${line}\n`);
    }
  });
}

for (const name of names) {
  const service = SERVICES[name];
  console.log(paint(service.color, `▶ starting ${name}: ${service.command} ${service.args.join(' ')}`));
  const child = spawn(service.command, service.args, {
    cwd: root,
    shell: true,
    env: { ...process.env, FORCE_COLOR: useColor ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefixStream(child.stdout, service);
  prefixStream(child.stderr, service);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(paint('33', `■ ${name} exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`));
    shutdown(code ?? 0);
  });
  children.push({ name, child });
}

function killTree(child) {
  if (!child.pid || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(paint('33', '\nStopping all services…'));
  for (const { child } of children) killTree(child);
  // Give children a moment to flush, then exit.
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
