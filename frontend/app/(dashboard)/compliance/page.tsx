'use client';

/**
 * Compliance Reports — the declared output of the billing scope profile.
 *
 * Aggregates the same payload as GET /api/governance/compliance-report:
 * billing volumes (data source), CDC outbox state (integration), DQ/freshness/
 * audit (HIPAA governance evidence), and lets the user export it as CSV.
 */
import { Download, FileText, ShieldCheck, Workflow } from 'lucide-react';
import { ENDPOINTS, type ComplianceReport } from '@medidata/shared';
import { useApiQuery } from '@/lib/queries';
import { formatDateTime, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function toRows(report: ComplianceReport): Array<[string, unknown]> {
  return [
    ['generated_at', report.generatedAt],
    ['industry', report.scope.industry],
    ['data_source', report.scope.source],
    ['integration', report.scope.integration],
    ['governance', report.scope.governance],
    ['output', report.scope.output],
    ['total_claims', report.billing.totalClaims],
    ['open_claims', report.billing.openClaims],
    ['total_billed', report.billing.totalBilled],
    ['total_paid', report.billing.totalPaid],
    ...report.billing.byStatus.map(
      (s) => [`claims_${s.status.toLowerCase()}`, s.count] as [string, unknown],
    ),
    ['dq_score', report.quality.overallScore],
    ['dq_rules_total', report.quality.totalRules],
    ['dq_rules_passed', report.quality.passedRules],
    ['dq_rules_failed', report.quality.failedRules],
    ['dq_critical_failures', report.quality.criticalFailures],
    ...report.freshness.map(
      (f) =>
        [
          `freshness_${f.tableName.replace(/[^a-zA-Z0-9]+/g, '_')}`,
          `${f.isStale ? 'BREACH' : 'OK'} (${f.stalenessMinutes ?? 'n/a'}/${f.maxStalenessMinutes} min)`,
        ] as [string, unknown],
    ),
    ['audit_events_24h', report.audit.eventsLast24h],
    ['audit_events_total', report.audit.totalEvents],
    ['cdc_pending_events', report.cdc.pendingEvents],
    ['cdc_delivered_events', report.cdc.deliveredEvents],
    ['cdc_last_event_at', report.cdc.lastEventAt ?? ''],
  ];
}

export default function CompliancePage() {
  const query = useApiQuery<ComplianceReport>(
    ['compliance', 'report'],
    ENDPOINTS.governanceComplianceReport.path,
  );
  const report = query.data;

  function downloadCsv() {
    if (!report) return;
    const csv = ['metric,value', ...toRows(report).map(([k, v]) => `${csvCell(k)},${csvCell(v)}`)].join(
      '\n',
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'medidata-compliance-report.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-4 xl:grid-cols-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="space-y-4">
        <PageHeader title="Compliance Reports" description="HIPAA evidence and billing controls." />
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Compliance Reports"
        description="Billing source · CDC integration · HIPAA governance — one auditable report."
        actions={
          <Button onClick={downloadCsv} disabled={!report}>
            <Download className="h-4 w-4" aria-hidden />
            Download CSV
          </Button>
        }
      />

      {!report ? (
        <EmptyState
          icon={FileText}
          title="No report available"
          description="The report is generated from billing, DQ, freshness and audit data."
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Workflow className="h-4 w-4 text-brand-600" aria-hidden /> Scope mapping
              </CardTitle>
              <CardDescription>Generated {formatDateTime(report.generatedAt)}</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {[
                  ['Industry', report.scope.industry],
                  ['Data source', report.scope.source],
                  ['Integration', report.scope.integration],
                  ['Governance', report.scope.governance],
                  ['Output', report.scope.output],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      {label}
                    </dt>
                    <dd className="mt-0.5 text-sm font-medium text-slate-800">{value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Billing controls</CardTitle>
                <CardDescription>Source: Billing</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label="Total claims" value={formatNumber(report.billing.totalClaims)} />
                <Row label="Open claims" value={formatNumber(report.billing.openClaims)} />
                <Row label="Total billed" value={formatNumber(report.billing.totalBilled)} />
                <Row label="Total paid" value={formatNumber(report.billing.totalPaid)} />
                <Row
                  label="Last billing run"
                  value={report.billing.lastRunAt ? formatDateTime(report.billing.lastRunAt) : '—'}
                />
                <div className="flex flex-wrap gap-1 pt-1">
                  {report.billing.byStatus.map((s) => (
                    <Badge key={s.status} variant="outline">
                      {s.status}: {s.count}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden /> HIPAA evidence
                </CardTitle>
                <CardDescription>Access control, audit and data quality</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label="DQ score" value={`${report.quality.overallScore}%`} />
                <Row
                  label="Rules passing"
                  value={`${report.quality.passedRules}/${report.quality.totalRules}`}
                />
                <Row label="Failed rules" value={formatNumber(report.quality.failedRules)} />
                <Row label="Critical failures" value={formatNumber(report.quality.criticalFailures)} />
                <Row label="Audit events (24h)" value={formatNumber(report.audit.eventsLast24h)} />
                <Row label="Audit events (total)" value={formatNumber(report.audit.totalEvents)} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>CDC / outbox</CardTitle>
                <CardDescription>Change propagation from billing writes</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label="Pending events" value={formatNumber(report.cdc.pendingEvents)} />
                <Row label="Delivered events" value={formatNumber(report.cdc.deliveredEvents)} />
                <Row
                  label="Last change event"
                  value={report.cdc.lastEventAt ? formatDateTime(report.cdc.lastEventAt) : '—'}
                />
                <Row label="Freshness breaches" value={formatNumber(report.freshness.filter((f) => f.isStale).length)} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Freshness SLAs</CardTitle>
              <CardDescription>Staleness of monitored tables</CardDescription>
            </CardHeader>
            <CardContent>
              {report.freshness.length === 0 ? (
                <EmptyState title="No freshness monitors" description="SLA monitors will appear here." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
                        <th className="py-2 pr-4">Table</th>
                        <th className="py-2 pr-4">Staleness</th>
                        <th className="py-2 pr-4">SLA</th>
                        <th className="py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.freshness.map((entry) => (
                        <tr key={entry.tableName} className="border-b border-slate-100 last:border-0">
                          <td className="py-2 pr-4 font-mono text-xs text-slate-700">{entry.tableName}</td>
                          <td className="py-2 pr-4 tabular-nums">
                            {entry.stalenessMinutes === null ? '—' : `${entry.stalenessMinutes} min`}
                          </td>
                          <td className="py-2 pr-4 tabular-nums">{entry.maxStalenessMinutes} min</td>
                          <td className="py-2">
                            <Badge variant={entry.isStale ? 'danger' : 'success'}>
                              {entry.isStale ? 'Breach' : 'OK'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-600">{label}</span>
      <span className="font-medium tabular-nums text-slate-800">{value}</span>
    </div>
  );
}
