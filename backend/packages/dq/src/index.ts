/**
 * @medidata/dq — data-quality rule engine.
 *
 * Each `gov.DqRule.sqlAssertion` is a SQL statement that returns the number of
 * FAILING rows (0 = rule passes). The engine executes it read-only, persists a
 * `gov.DqResult` per rule, raises `gov.AlertLog` entries when a CRITICAL rule
 * regresses, and produces the shared `QualityScorecard`.
 *
 * Rules are intentionally declarative: adding a rule is a data change, not a
 * code change. Every seeded assertion targets the real quoted identifiers
 * (`app."Patient"`, ...) so it runs against the canonical schema.
 */
import { prisma, type DqRule, type PrismaClient } from '@medidata/db';
import type { QualityScorecard } from '@medidata/shared';

export type DqDb = PrismaClient;

export interface DqEvaluation {
  ruleId: string;
  code: string;
  name: string;
  severity: 'WARNING' | 'CRITICAL';
  targetSchema: string;
  targetTable: string;
  passed: boolean;
  /** Number of rows violating the assertion. */
  failedCount: number;
  sampleKeys: string[] | null;
  checkedAt: Date;
  /** Set when the assertion itself could not run (SQL error, missing table...). */
  error: string | null;
  durationMs: number;
}

export interface DqRunResult {
  runId: string | null;
  results: DqEvaluation[];
  scorecard: QualityScorecard;
  alertsRaised: number;
}

/** Postgres COUNT(*) comes back as BigInt through Prisma raw queries. */
export function countFromRows(rows: unknown): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const first = rows[0] as Record<string, unknown>;
  const value =
    first.count ?? first.n ?? first.failed ?? first.failed_count ?? Object.values(first)[0];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return 0;
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]?.slice(0, 400) ?? 'unknown error';
}

/**
 * Run one rule's assertion. Never throws: a broken assertion is reported as a
 * failed evaluation with `error` set, so the scorecard can surface it instead
 * of the whole DQ job dying.
 */
export async function evaluateRule(
  rule: Pick<DqRule, 'id' | 'code' | 'name' | 'severity' | 'targetSchema' | 'targetTable' | 'sqlAssertion'>,
  opts: { client?: DqDb; now?: Date } = {},
): Promise<DqEvaluation> {
  const client = opts.client ?? prisma;
  const checkedAt = opts.now ?? new Date();
  const startedAt = Date.now();

  const base = {
    ruleId: rule.id,
    code: rule.code,
    name: rule.name,
    severity: rule.severity as 'WARNING' | 'CRITICAL',
    targetSchema: rule.targetSchema,
    targetTable: rule.targetTable,
    checkedAt,
  };

  try {
    const rows = await client.$queryRawUnsafe<unknown[]>(rule.sqlAssertion);
    const failedCount = Math.max(0, countFromRows(rows));
    return {
      ...base,
      passed: failedCount === 0,
      failedCount,
      sampleKeys: null,
      error: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ...base,
      passed: false,
      failedCount: 0,
      sampleKeys: null,
      error: errorText(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Latest result per rule id (for regression detection + scorecards). */
async function latestResults(client: DqDb): Promise<Map<string, { passed: boolean; failedCount: number }>> {
  const rows = await client.dqResult.findMany({
    orderBy: { checkedAt: 'desc' },
    distinct: ['ruleId'],
    select: { ruleId: true, passed: true, failedCount: true },
  });
  return new Map(rows.map((r) => [r.ruleId, { passed: r.passed, failedCount: r.failedCount }]));
}

/**
 * Evaluate every active rule, persist results and raise alerts.
 * `runId` links the results to the `gov.PipelineRun` that triggered them.
 */
export async function evaluateAllRules(
  opts: { client?: DqDb; runId?: string | null; now?: Date; log?: (e: string, m?: Record<string, unknown>) => void } = {},
): Promise<DqRunResult> {
  const client = opts.client ?? prisma;
  const now = opts.now ?? new Date();
  const runId = opts.runId ?? null;

  const rules = await client.dqRule.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } });
  const previous = await latestResults(client);
  const results: DqEvaluation[] = [];

  for (const rule of rules) {
    const evaluation = await evaluateRule(rule, { client, now });
    results.push(evaluation);
    opts.log?.('dq.rule', {
      code: evaluation.code,
      passed: evaluation.passed,
      failedCount: evaluation.failedCount,
      error: evaluation.error,
    });
  }

  if (results.length > 0) {
    await client.dqResult.createMany({
      data: results.map((r) => ({
        ruleId: r.ruleId,
        runId,
        passed: r.passed,
        failedCount: r.failedCount,
        sampleKeys: r.sampleKeys === null ? undefined : (r.sampleKeys as never),
        checkedAt: r.checkedAt,
      })),
    });
  }

  // Alert on CRITICAL regressions (or first-ever critical failure).
  let alertsRaised = 0;
  for (const r of results) {
    if (r.severity !== 'CRITICAL' || r.passed) continue;
    const before = previous.get(r.ruleId);
    const isRegression = !before || before.passed;
    if (!isRegression) continue;
    await client.alertLog.create({
      data: {
        channel: 'data-quality',
        severity: 'CRITICAL',
        message: `[${r.code}] ${r.name} failed with ${r.failedCount} violating row(s)${
          r.error ? ` — ${r.error}` : ''
        }`,
      },
    });
    alertsRaised += 1;
  }

  const scorecard = buildScorecard(rules, results);
  return { runId, results, scorecard, alertsRaised };
}

/** Pure score computation — used by evaluateAllRules and the API. */
export function buildScorecard(
  rules: Array<Pick<DqRule, 'id' | 'code' | 'name' | 'severity' | 'targetSchema' | 'targetTable' | 'sqlAssertion' | 'description' | 'isActive'>>,
  evaluations: DqEvaluation[],
  generatedAt: Date = new Date(),
): QualityScorecard {
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const results = evaluations.map((e) => {
    const rule = ruleById.get(e.ruleId);
    return {
      id: `${e.ruleId}:${e.checkedAt.getTime()}`,
      ruleId: e.ruleId,
      runId: null,
      passed: e.passed,
      failedCount: e.failedCount,
      sampleKeys: e.sampleKeys,
      checkedAt: e.checkedAt,
      rule: {
        id: e.ruleId,
        code: e.code,
        name: e.name,
        severity: e.severity,
        targetSchema: e.targetSchema,
        targetTable: e.targetTable,
        sqlAssertion: rule?.sqlAssertion ?? '',
        description: rule?.description ?? '',
        isActive: rule?.isActive ?? true,
      },
    };
  });

  const totalRules = results.length;
  const passedRules = results.filter((r) => r.passed).length;
  const failedRules = totalRules - passedRules;
  const criticalFailures = results.filter((r) => !r.passed && r.rule.severity === 'CRITICAL').length;
  const overallScore = totalRules === 0 ? 100 : Math.round((passedRules / totalRules) * 1000) / 10;

  return { overallScore, totalRules, passedRules, failedRules, criticalFailures, results, generatedAt };
}

/**
 * Latest persisted result per rule → QualityScorecard (what the UI reads).
 * Returns an empty-but-valid scorecard when the DQ job has never run.
 */
export async function getQualityScorecard(opts: { client?: DqDb; now?: Date } = {}): Promise<QualityScorecard> {
  const client = opts.client ?? prisma;
  const rules = await client.dqRule.findMany({
    where: { isActive: true },
    include: { results: { orderBy: { checkedAt: 'desc' }, take: 1 } },
    orderBy: { code: 'asc' },
  });

  const results = rules
    .filter((r) => r.results.length > 0)
    .map((r) => {
      const latest = r.results[0]!;
      const { results: _ignored, ...rule } = r;
      return {
        id: latest.id,
        ruleId: r.id,
        runId: latest.runId,
        passed: latest.passed,
        failedCount: latest.failedCount,
        sampleKeys: latest.sampleKeys,
        checkedAt: latest.checkedAt,
        rule,
      };
    });

  const totalRules = results.length;
  const passedRules = results.filter((r) => r.passed).length;
  const failedRules = totalRules - passedRules;
  const criticalFailures = results.filter((r) => !r.passed && r.rule.severity === 'CRITICAL').length;

  return {
    overallScore: totalRules === 0 ? 0 : Math.round((passedRules / totalRules) * 1000) / 10,
    totalRules,
    passedRules,
    failedRules,
    criticalFailures,
    results,
    generatedAt: opts.now ?? new Date(),
  };
}

/** Convenience: is any CRITICAL rule currently failing? Used by the ML gate. */
export async function criticalFailures(opts: { client?: DqDb } = {}): Promise<Array<{ code: string; name: string; failedCount: number }>> {
  const scorecard = await getQualityScorecard(opts);
  return scorecard.results
    .filter((r) => !r.passed && r.rule.severity === 'CRITICAL')
    .map((r) => ({ code: r.rule.code, name: r.rule.name, failedCount: r.failedCount }));
}

export type { QualityScorecard };
