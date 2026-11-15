#!/usr/bin/env node
/**
 * One-command setup for MediData.
 *
 *   node scripts/setup.mjs [--skip-install] [--skip-pipeline]
 *
 * Steps: verify Node + backend/.env → install both package trees → apply
 * Prisma migrations → seed synthetic data → run the end-to-end pipeline.
 *
 * Assumes a Neon (or local) PostgreSQL database is reachable via
 * backend/.env. All data is synthetic — never point this at real PHI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = join(root, 'backend');
const frontend = join(root, 'frontend');

const args = new Set(process.argv.slice(2));
const skipInstall = args.has('--skip-install');
const skipPipeline = args.has('--skip-pipeline');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text) => paint('1', text);
const green = (text) => paint('32', text);
const red = (text) => paint('31', text);
const dim = (text) => paint('2', text);

function step(title) {
  console.log(`\n${bold(`▶ ${title}`)}`);
}

function run(label, command, commandArgs, cwd = root) {
  console.log(dim(`$ ${command} ${commandArgs.join(' ')}`));
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd, shell: true });
  if (result.status !== 0) {
    console.error(red(`\n✖ ${label} failed (exit ${result.status ?? 'unknown'}).`));
    process.exit(result.status ?? 1);
  }
  console.log(green(`✔ ${label}`));
}

// --- Preconditions ---------------------------------------------------------
step('Checking prerequisites');
const major = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(major) || major < 20) {
  console.error(red(`Node >= 20 is required (found ${process.versions.node}).`));
  process.exit(1);
}
console.log(green(`✔ Node ${process.versions.node}`));

const envFile = join(backend, '.env');
if (!existsSync(envFile)) {
  console.error(red(`\nMissing backend/.env`));
  console.error('Create it from the template and fill in your database URLs:');
  console.error(dim('  Copy-Item backend/.env.example backend/.env'));
  console.error(dim('  # then set DATABASE_URL (pooled) and DIRECT_URL (direct)'));
  process.exit(1);
}
console.log(green('✔ backend/.env found'));

// --- Install ---------------------------------------------------------------
if (skipInstall) {
  console.log(dim('\nSkipping dependency install (--skip-install).'));
} else {
  step('Installing backend dependencies');
  run('backend install', 'npm', ['--prefix', backend, 'install']);
  step('Installing frontend dependencies');
  run('frontend install', 'npm', ['--prefix', frontend, 'install']);
}

// --- Database --------------------------------------------------------------
step('Applying Prisma migrations');
run('migrate deploy', 'npm', ['--prefix', backend, 'run', 'migrate:deploy']);

step('Seeding synthetic data (~90s)');
run('seed', 'npm', ['--prefix', backend, 'run', 'seed']);

// --- Pipeline --------------------------------------------------------------
if (skipPipeline) {
  console.log(dim('\nSkipping pipeline (--skip-pipeline). Run `npm run pipeline` later.'));
} else {
  step('Running the end-to-end pipeline (ETL → MDM → warehouse → DQ)');
  run('pipeline', 'npm', ['--prefix', backend, 'run', 'pipeline']);
}

console.log(`\n${green(bold('MediData is ready.'))}`);
console.log('Start everything with:');
console.log(dim('  npm run dev        # API :4000 + worker + web :3000'));
console.log('or individually:');
console.log(dim('  npm run dev:api    # http://localhost:4000/health'));
console.log(dim('  npm run dev:worker # scheduled ETL/DQ/MDM jobs'));
console.log(dim('  npm run dev:web    # http://localhost:3000'));
console.log(`\nSign in with ${bold('admin@medidata.local')} / ${bold('Passw0rd!123')}`);
