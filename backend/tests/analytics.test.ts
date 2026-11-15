import { describe, expect, it } from 'vitest';
import { computeOutcomeKpis } from '../packages/analytics/src/index.js';

const HOUR = 3_600_000;

describe('computeOutcomeKpis', () => {
  it('computes duplicate, turnaround and billing-lag improvements', async () => {
    const submitted = new Date('2024-01-01T00:00:00Z');
    const client = {
      patient: {
        count: async () => 4,
        groupBy: async () => [
          { _count: { _all: 2 } },
          { _count: { _all: 2 } },
        ],
      },
      labResult: {
        findMany: async () => [
          { collectedAt: submitted, resultedAt: new Date(submitted.getTime() + 2 * HOUR) },
          { collectedAt: submitted, resultedAt: new Date(submitted.getTime() + 4 * HOUR) },
        ],
      },
      claim: {
        findMany: async () => [
          { submittedAt: submitted, sourceUpdatedAt: new Date(submitted.getTime() + 100 * HOUR) },
          { submittedAt: submitted, sourceUpdatedAt: new Date(submitted.getTime() + 10 * HOUR) },
        ],
      },
      mdmMaster: {
        findMany: async () => [{ goldenId: 'g1' }, { goldenId: 'g1' }, { goldenId: 'g2' }],
      },
    };

    const kpis = await computeOutcomeKpis({ client: client as never });

    expect(kpis.duplicateRateBefore).toBe(100);
    expect(kpis.duplicateRateAfter).toBe(50);
    expect(kpis.avgTatBefore).toBe(3);
    expect(kpis.avgTatAfter).toBe(3);
    expect(kpis.billingLagBefore).toBe(55);
    expect(kpis.billingLagAfter).toBe(41);
    expect(kpis.dqScore).toBe(100);
  });

  it('never divides by zero on an empty warehouse', async () => {
    const client = {
      patient: { count: async () => 0, groupBy: async () => [] },
      labResult: { findMany: async () => [] },
      claim: { findMany: async () => [] },
      mdmMaster: { findMany: async () => [] },
    };
    const kpis = await computeOutcomeKpis({ client: client as never });
    expect(kpis.duplicateRateBefore).toBe(0);
    expect(kpis.duplicateRateAfter).toBe(0);
    expect(kpis.avgTatBefore).toBe(0);
    expect(kpis.billingLagBefore).toBe(0);
  });
});
