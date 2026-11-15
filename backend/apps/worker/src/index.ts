/**
 * @medidata/worker — in-process job runner.
 *
 * Scheduling strategy: node-cron inside the worker process. Redis/BullMQ are
 * optional in this project (the demo runs without Redis), so we deliberately
 * do NOT require a queue: every job is a plain async function (see jobs.ts)
 * that can also be triggered by `npm run pipeline`.
 *
 * Schedules (override with WORKER_*_CRON env vars):
 *   • ETL + MDM + warehouse + DQ    every 15 minutes  (WORKER_ETL_CRON)
 *   • freshness SLA checks          every 5 minutes   (WORKER_FRESHNESS_CRON)
 *   • outbox delivery               every minute      (WORKER_OUTBOX_CRON)
 */
import * as cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { prisma } from '@medidata/db';
import { logger } from '@medidata/shared/logger';
import { checkFreshness, deliverOutbox, runDqJob, runEtlJob } from './jobs.js';

const log = (event: string, meta?: Record<string, unknown>): void => {
  logger.info({ ...meta, event }, event);
};

const ETL_CRON = process.env.WORKER_ETL_CRON ?? '*/15 * * * *';
const FRESHNESS_CRON = process.env.WORKER_FRESHNESS_CRON ?? '*/5 * * * *';
const OUTBOX_CRON = process.env.WORKER_OUTBOX_CRON ?? '* * * * *';

const tasks: ScheduledTask[] = [];

/** Run a job, swallowing/logging errors so one failure never kills the loop. */
function guard(name: string, fn: () => Promise<unknown>): () => void {
  return () => {
    void fn()
      .then((result) => log(`worker.${name}.ok`, { result: summarize(result) }))
      .catch((err: unknown) => log(`worker.${name}.failed`, { error: err instanceof Error ? err.message : String(err) }));
  };
}

/** Keep cron logs compact (avoid dumping entire DQ scorecards). */
function summarize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return { count: value.length };
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('overallScore' in obj) return { overallScore: obj.overallScore, failedRules: obj.failedRules };
    if ('patients' in obj && 'goldenRecords' in obj) {
      return { patients: obj.patients, goldenRecords: obj.goldenRecords, pendingCandidates: obj.pendingCandidates };
    }
    if ('connectors' in obj) return { connectors: Array.isArray(obj.connectors) ? obj.connectors.length : 0 };
    return { keys: Object.keys(obj) };
  }
  return value;
}

function schedule(name: string, expression: string, fn: () => Promise<unknown>): void {
  if (!cron.validate(expression)) {
    log('worker.schedule.invalid', { name, expression });
    return;
  }
  tasks.push(cron.schedule(expression, guard(name, fn)));
  log('worker.schedule.registered', { name, expression });
}

async function main(): Promise<void> {
  log('worker.start', { pid: process.pid, etl: ETL_CRON, freshness: FRESHNESS_CRON, outbox: OUTBOX_CRON });

  schedule('etl', ETL_CRON, runEtlJob);
  schedule('dq', ETL_CRON, runDqJob);
  schedule('freshness', FRESHNESS_CRON, checkFreshness);
  schedule('outbox', OUTBOX_CRON, deliverOutbox);

  // Demo convenience: run once at boot so the UI has fresh state immediately.
  if (process.env.WORKER_RUN_ON_BOOT !== 'false') {
    guard('boot.etl', runEtlJob)();
    guard('boot.dq', runDqJob)();
    guard('boot.freshness', checkFreshness)();
  }

  const shutdown = async (signal: string): Promise<void> => {
    log('worker.stop', { signal });
    for (const task of tasks) task.stop();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((err: unknown) => {
  log('worker.fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
