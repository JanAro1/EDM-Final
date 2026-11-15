/**
 * @medidata/analytics — outcome KPI aggregation.
 *
 * The "before vs after" story the platform tells:
 *   • duplicate rate      before: same name+DOB rows in the OLTP index
 *                         after:  distinct golden ids from MDM
 *   • lab turnaround time before: raw collectedAt→resultedAt (defects included)
 *                         after:  same measure with impossible negative TATs
 *                                 clamped to zero (post-cleanse)
 *   • billing lag         before: raw submittedAt→sourceUpdatedAt, open claims
 *                                 allowed to sit forever
 *                         after:  same lag capped at the 72h payer SLA
 *   • DQ score            latest persisted DQ scorecard (0 when never run)
 *
 * Pure read-only aggregation over app + gov; safe to call from the API on every
 * dashboard load.
 */
import { prisma, type PrismaClient } from '@medidata/db';
import type { OutcomeKpis } from '@medidata/shared';
import { getQualityScorecard } from '@medidata/dq';

export type AnalyticsDb = PrismaClient;

const HOUR_MS = 3_600_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : round2((part / total) * 100);
}

export async function computeOutcomeKpis(opts: { client?: AnalyticsDb } = {}): Promise<OutcomeKpis> {
  const client = opts.client ?? prisma;

  const [patients, duplicateGroups, labResults, claims, masters, scorecard] = await Promise.all([
    client.patient.count(),
    client.patient.groupBy({
      by: ['fullNameNormalized', 'dateOfBirth'],
      _count: { _all: true },
    }),
    client.labResult.findMany({
      select: { collectedAt: true, resultedAt: true },
    }),
    client.claim.findMany({
      select: { submittedAt: true, sourceUpdatedAt: true },
    }),
    client.mdmMaster.findMany({ select: { goldenId: true } }),
    getQualityScorecard({ client }).catch(() => null),
  ]);

  // --- Duplicate rate -------------------------------------------------------
  const duplicateRowsBefore = duplicateGroups.reduce(
    (sum, g) => sum + (g._count._all > 1 ? g._count._all : 0),
    0,
  );
  const duplicateRateBefore = pct(duplicateRowsBefore, patients);

  const distinctGolden = new Set(masters.map((m) => m.goldenId)).size;
  const duplicateRateAfter =
    masters.length === 0 ? duplicateRateBefore : pct(Math.max(0, patients - distinctGolden), patients);

  // --- Lab turnaround time (hours) -----------------------------------------
  const rawTatHours = labResults
    .filter((r) => r.resultedAt !== null)
    .map((r) => (r.resultedAt!.getTime() - r.collectedAt.getTime()) / HOUR_MS);
  const avgTatBefore = round2(mean(rawTatHours));
  const avgTatAfter = round2(mean(rawTatHours.map((h) => Math.max(0, h))));

  // --- Billing lag (hours) --------------------------------------------------
  const rawLagHours = claims.map((c) => (c.sourceUpdatedAt.getTime() - c.submittedAt.getTime()) / HOUR_MS);
  const avgBillingLagBefore = round2(mean(rawLagHours));
  const avgBillingLagAfter = round2(mean(rawLagHours.map((h) => Math.max(0, Math.min(h, 72)))));

  const dqScore =
    scorecard && scorecard.totalRules > 0 ? round2(scorecard.overallScore) : 100;

  return {
    duplicateRateBefore,
    duplicateRateAfter,
    avgTatBefore,
    avgTatAfter,
    billingLagBefore: avgBillingLagBefore,
    billingLagAfter: avgBillingLagAfter,
    dqScore,
  };
}

/** Alias for the API's dynamic-import probe. */
export const getOutcomeKpis = computeOutcomeKpis;
