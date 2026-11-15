/**
 * Worker jobs — the scheduled half of the platform.
 *
 * Each job is an exported async function so it can be called from:
 *   • the cron scheduler (apps/worker/src/index.ts),
 *   • the one-shot pipeline script (apps/worker/src/run-pipeline.ts),
 *   • tests / the ops demo (`npm run pipeline`).
 *
 * Jobs are idempotent: ETL uses the staging composite key, warehouse loads
 * upsert by deterministic keys, MDM upserts by patient, DQ appends a new
 * result per rule (history is the point), freshness alerts are de-duplicated.
 */
import { prisma } from '@medidata/db';
import { logger } from '@medidata/shared/logger';
import {
  CONNECTOR_NAMES,
  applySqlAssets,
  getConnector,
  refreshMaterializedViews,
  runEtlPipeline,
  runWarehouseLoad,
  type EtlContext,
  type RawRow,
} from '@medidata/etl-core';
import { evaluateAllRules, getQualityScorecard, type DqRunResult } from '@medidata/dq';
import { runMdm, type MdmRunResult } from '@medidata/mdm';

const log = (event: string, meta?: Record<string, unknown>): void => {
  logger.info({ ...meta, event }, event);
};

export function etlContext(): EtlContext {
  return { prisma, log };
}

// ---------------------------------------------------------------------------
// ETL + MDM + warehouse
// ---------------------------------------------------------------------------

export interface EtlJobResult {
  connectors: Array<{ connector: string; rowsIn: number; rowsOut: number; runId: string }>;
  stagingRows: number;
  mdm: MdmRunResult;
  warehouse: Awaited<ReturnType<typeof runWarehouseLoad>>['counts'];
  sqlAssets: { applied: boolean; statements: number };
  refreshedViews: string[];
}

export async function runEtlJob(): Promise<EtlJobResult> {
  const ctx = etlContext();
  const connectors: EtlJobResult['connectors'] = [];
  const allRows: RawRow[] = [];

  for (const name of CONNECTOR_NAMES) {
    const connector = getConnector(name);
    const result = await runEtlPipeline(connector, ctx);
    connectors.push({
      connector: connector.name,
      rowsIn: result.rowsIn,
      rowsOut: result.rowsOut,
      runId: result.pipelineRunId,
    });
    allRows.push(...result.rows);
  }

  // MDM must run before the warehouse load so golden ids are available.
  const mdm = await runMdm({ log });

  // In-DB transform path (idempotent SQL assets) + dimensional load.
  const sqlAssets = await applySqlAssets(ctx);
  const warehouseResult = await runWarehouseLoad(allRows, ctx);
  const refreshedViews = await refreshMaterializedViews(ctx).catch((err: unknown) => {
    log('warehouse.refresh.failed', { error: err instanceof Error ? err.message : String(err) });
    return [] as string[];
  });

  return {
    connectors,
    stagingRows: allRows.length,
    mdm,
    warehouse: warehouseResult.counts,
    sqlAssets: { applied: sqlAssets.applied, statements: sqlAssets.statements },
    refreshedViews,
  };
}

/** Lightweight variant: only re-project app.* into the warehouse (no files). */
export async function runWarehouseJob(): Promise<EtlJobResult['warehouse']> {
  const result = await runWarehouseLoad([], etlContext());
  return result.counts;
}

export async function runMdmJob(): Promise<MdmRunResult> {
  return runMdm({ log });
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

export async function runDqJob(): Promise<DqRunResult> {
  const result = await evaluateAllRules({ log });
  log('dq.job.done', {
    rules: result.results.length,
    passed: result.scorecard.passedRules,
    failed: result.scorecard.failedRules,
    alertsRaised: result.alertsRaised,
  });
  return result;
}

export async function qualitySnapshot(): ReturnType<typeof getQualityScorecard> {
  return getQualityScorecard();
}

// ---------------------------------------------------------------------------
// Freshness SLA checks
// ---------------------------------------------------------------------------

export interface FreshnessCheck {
  tableName: string;
  maxStalenessMinutes: number;
  lastLoadedAt: Date | null;
  stalenessMinutes: number | null;
  isStale: boolean;
}

type MaxUpdatedAt = { _max: { updatedAt: Date | null } };

async function maxUpdatedAt(factory: () => { aggregate: (args: { _max: { updatedAt: true } }) => Promise<MaxUpdatedAt> }): Promise<Date | null> {
  return (await factory().aggregate({ _max: { updatedAt: true } }))._max.updatedAt;
}

export async function checkFreshness(): Promise<FreshnessCheck[]> {
  const slas = await prisma.freshnessSla.findMany({ orderBy: { tableName: 'asc' } });
  const now = Date.now();
  const checks: FreshnessCheck[] = [];

  for (const sla of slas) {
    let lastLoadedAt: Date | null = null;
    try {
      switch (sla.tableName) {
        case 'app.patients':
          lastLoadedAt = await maxUpdatedAt(() => prisma.patient);
          break;
        case 'app.encounters':
          lastLoadedAt = await maxUpdatedAt(() => prisma.encounter);
          break;
        case 'app.lab_results':
          lastLoadedAt = await maxUpdatedAt(() => prisma.labResult);
          break;
        case 'app.claims':
          lastLoadedAt = await maxUpdatedAt(() => prisma.claim);
          break;
        case 'warehouse.fact_claim':
        case 'warehouse.dim_patient':
          lastLoadedAt = await maxUpdatedAt(() => prisma.dimPatient);
          break;
        case 'staging.raw_source_record':
          lastLoadedAt = (await prisma.rawSourceRecord.aggregate({ _max: { extractedAt: true } }))._max.extractedAt;
          break;
        default:
          lastLoadedAt = null;
      }
    } catch {
      lastLoadedAt = null;
    }

    const stalenessMinutes = lastLoadedAt ? Math.round((now - lastLoadedAt.getTime()) / 60_000) : null;
    const isStale = stalenessMinutes === null ? true : stalenessMinutes > sla.maxStalenessMinutes;
    checks.push({ tableName: sla.tableName, maxStalenessMinutes: sla.maxStalenessMinutes, lastLoadedAt, stalenessMinutes, isStale });
  }

  for (const check of checks.filter((c) => c.isStale)) {
    const message = `[FRESHNESS] ${check.tableName} is stale: ${check.stalenessMinutes ?? 'never loaded'} min > ${check.maxStalenessMinutes} min SLA`;
    const recent = await prisma.alertLog.findFirst({
      where: { channel: 'freshness', message, sentAt: { gte: new Date(Date.now() - 6 * 3_600_000) } },
      select: { id: true },
    });
    if (!recent) {
      await prisma.alertLog.create({ data: { channel: 'freshness', severity: 'WARNING', message } });
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Outbox delivery (outbound webhooks)
// ---------------------------------------------------------------------------

export interface OutboxDeliveryResult {
  delivered: number;
  failed: number;
  skipped: number;
}

/**
 * Publish pending `app.OutboxEvent` rows. With `WEBHOOK_URL` set we POST the
 * event (HMAC-signed) and only mark it published on 2xx; without a URL the
 * demo runs in "in-process" mode and marks events published locally, which is
 * what the /webhooks/outbound/deliveries UI reads.
 */
export async function deliverOutbox(opts: { limit?: number } = {}): Promise<OutboxDeliveryResult> {
  const pending = await prisma.outboxEvent.findMany({
    where: { publishedAt: null },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 100,
  });

  const target = process.env.WEBHOOK_URL;
  let delivered = 0;
  let failed = 0;

  for (const event of pending) {
    if (!target) {
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
      delivered += 1;
      continue;
    }
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-medidata-event': event.eventType,
        },
        body: JSON.stringify({ id: event.id, type: event.eventType, aggregateType: event.aggregateType, aggregateId: event.aggregateId, payload: event.payload, createdAt: event.createdAt }),
      });
      if (res.ok) {
        await prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
        delivered += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { delivered, failed, skipped: pending.length - delivered - failed };
}

// ---------------------------------------------------------------------------
// Full pipeline (demo)
// ---------------------------------------------------------------------------

export interface PipelineResult {
  etl: EtlJobResult;
  dq: DqRunResult;
  freshness: FreshnessCheck[];
  outbox: OutboxDeliveryResult;
  durationMs: number;
}

/** One-shot end-to-end run: extract → stage → MDM → warehouse → DQ → alerts. */
export async function runFullPipeline(): Promise<PipelineResult> {
  const startedAt = Date.now();
  const etl = await runEtlJob();
  const dq = await runDqJob();
  const freshness = await checkFreshness();
  const outbox = await deliverOutbox();
  const result = { etl, dq, freshness, outbox, durationMs: Date.now() - startedAt };
  log('pipeline.done', { durationMs: result.durationMs, score: dq.scorecard.overallScore });
  return result;
}
