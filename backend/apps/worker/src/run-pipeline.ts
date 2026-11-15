/**
 * One-shot end-to-end pipeline for the demo / `npm run pipeline`.
 *
 * Order: extract all five source systems → land in staging → MDM golden
 * records → in-DB warehouse assets → dimensional load → DQ rules → freshness
 * SLAs → outbox delivery. Prints a compact report and exits non-zero on error.
 */
import { prisma } from '@medidata/db';
import { runFullPipeline } from './jobs.js';

async function main(): Promise<void> {
  const result = await runFullPipeline();

  const lines: string[] = [];
  lines.push('');
  lines.push('MediData pipeline — run summary');
  lines.push('─'.repeat(64));
  lines.push(`ETL connectors        : ${result.etl.connectors.length}`);
  for (const c of result.etl.connectors) {
    lines.push(`  ${c.connector.padEnd(20)} in=${String(c.rowsIn).padStart(5)} out=${String(c.rowsOut).padStart(5)}`);
  }
  lines.push(`Staging rows          : ${result.etl.stagingRows}`);
  lines.push(`MDM patients          : ${result.etl.mdm.patients}`);
  lines.push(`MDM golden records    : ${result.etl.mdm.goldenRecords} (merged ${result.etl.mdm.mergedRecords}, auto ${result.etl.mdm.autoMerged})`);
  lines.push(`MDM pending reviews   : ${result.etl.mdm.pendingCandidates}`);
  lines.push(`Warehouse dims/facts  : patients=${result.etl.warehouse.dimPatients} encounters=${result.etl.warehouse.factEncounters} labs=${result.etl.warehouse.factLabResults} claims=${result.etl.warehouse.factClaims}`);
  lines.push(`SQL assets            : ${result.etl.sqlAssets.applied ? `applied (${result.etl.sqlAssets.statements} statements)` : 'already present'}`);
  lines.push(`Refreshed views       : ${result.etl.refreshedViews.join(', ') || 'none'}`);
  lines.push('─'.repeat(64));
  lines.push(`DQ score              : ${result.dq.scorecard.overallScore}/100`);
  lines.push(`DQ rules              : ${result.dq.scorecard.passedRules}/${result.dq.scorecard.totalRules} passing, ${result.dq.scorecard.criticalFailures} critical failure(s)`);
  for (const r of result.dq.results.filter((x) => !x.passed)) {
    lines.push(`  FAIL ${r.code.padEnd(10)} ${r.failedCount} row(s)${r.error ? ` — ${r.error}` : ''}`);
  }
  lines.push(`DQ alerts raised      : ${result.dq.alertsRaised}`);
  const stale = result.freshness.filter((f) => f.isStale);
  lines.push(`Freshness             : ${stale.length} stale of ${result.freshness.length} SLA(s)`);
  for (const s of stale) lines.push(`  STALE ${s.tableName} (${s.stalenessMinutes ?? 'never'} min)`);
  lines.push(`Outbox delivered      : ${result.outbox.delivered} (failed ${result.outbox.failed})`);
  lines.push(`Duration              : ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[pipeline] FAILED:', err instanceof Error ? err.stack ?? err.message : err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
