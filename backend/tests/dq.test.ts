import { describe, expect, it } from 'vitest';
import {
  buildScorecard,
  countFromRows,
  evaluateRule,
  type DqEvaluation,
} from '../packages/dq/src/index.js';

const baseRule = {
  id: 'rule-1',
  code: 'PAT-001',
  name: 'UNIQUE_MRN',
  severity: 'CRITICAL' as const,
  targetSchema: 'app',
  targetTable: 'patients',
  sqlAssertion: 'SELECT 0',
  description: 'MRN must be unique',
  isActive: true,
};

describe('countFromRows', () => {
  it('reads the first column of a single-row result', () => {
    expect(countFromRows([{ count: 3 }])).toBe(3);
    expect(countFromRows([{ n: 7 }])).toBe(7);
    expect(countFromRows([{ failed: 2 }])).toBe(2);
    expect(countFromRows([{ anything: '4' }])).toBe(4);
  });

  it('handles bigint and empty results', () => {
    expect(countFromRows([{ count: 5n }])).toBe(5);
    expect(countFromRows([])).toBe(0);
    expect(countFromRows(null)).toBe(0);
  });
});

describe('buildScorecard', () => {
  const evaluation = (over: Partial<DqEvaluation>): DqEvaluation => ({
    ruleId: baseRule.id,
    code: baseRule.code,
    name: baseRule.name,
    severity: 'CRITICAL',
    targetSchema: 'app',
    targetTable: 'patients',
    checkedAt: new Date('2024-01-01T00:00:00Z'),
    passed: true,
    failedCount: 0,
    sampleKeys: null,
    error: null,
    durationMs: 1,
    ...over,
  });

  it('scores 100 when there are no rules', () => {
    expect(buildScorecard([], []).overallScore).toBe(100);
  });

  it('computes pass rate and counts critical failures', () => {
    const rules = [
      baseRule,
      { ...baseRule, id: 'rule-2', code: 'LAB-001', severity: 'WARNING' as const },
    ];
    const scorecard = buildScorecard(
      rules,
      [
        evaluation({ ruleId: 'rule-1', passed: false, failedCount: 2 }),
        evaluation({ ruleId: 'rule-2', passed: true, failedCount: 0 }),
      ],
      new Date('2024-01-02T00:00:00Z'),
    );
    expect(scorecard.totalRules).toBe(2);
    expect(scorecard.passedRules).toBe(1);
    expect(scorecard.failedRules).toBe(1);
    expect(scorecard.criticalFailures).toBe(1);
    expect(scorecard.overallScore).toBe(50);
    expect(scorecard.results[0]!.rule.code).toBe('PAT-001');
  });
});

describe('evaluateRule', () => {
  it('passes when the assertion returns zero', async () => {
    const client = { $queryRawUnsafe: async () => [{ count: 0 }] };
    const result = await evaluateRule(baseRule, { client: client as never });
    expect(result.passed).toBe(true);
    expect(result.failedCount).toBe(0);
    expect(result.error).toBeNull();
  });

  it('fails with a row count when the assertion returns rows', async () => {
    const client = { $queryRawUnsafe: async () => [{ count: 4 }] };
    const result = await evaluateRule(baseRule, { client: client as never });
    expect(result.passed).toBe(false);
    expect(result.failedCount).toBe(4);
  });

  it('reports a broken assertion as a failed evaluation instead of throwing', async () => {
    const client = {
      $queryRawUnsafe: async () => {
        throw new Error('relation "app.patients" does not exist');
      },
    };
    const result = await evaluateRule(baseRule, { client: client as never });
    expect(result.passed).toBe(false);
    expect(result.error).toContain('does not exist');
  });
});
