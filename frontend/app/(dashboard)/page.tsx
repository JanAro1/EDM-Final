'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { format, subMonths } from 'date-fns';
import {
  AlertOctagon,
  CheckCircle2,
  ChevronRight,
  Database,
  FileText,
  FlaskConical,
  Hourglass,
  Merge,
  Users,
  Wallet,
} from 'lucide-react';
import {
  ENDPOINTS,
  IS_BILLING_SCOPE,
  type ComplianceReport,
  type FreshnessStatus,
  type LabResult,
  type OutcomeKpis,
  type PatientSummary,
  type Claim,
  type QualityScorecard,
} from '@medidata/shared';
import { useApiList, useApiQuery } from '@/lib/queries';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/error-state';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber, formatPercent, toDate } from '@/lib/format';
import { ChartSkeleton } from '@/components/charts/common';

const ResultsByMonthChart = dynamic(() => import('@/components/charts/results-by-month'), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});
const ClaimsByStatusChart = dynamic(() => import('@/components/charts/claims-by-status'), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

const PENDING_RESULT_STATUSES = new Set(['COLLECTED', 'IN_PROGRESS', 'REVIEWED']);
const OPEN_CLAIM_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'PENDING']);

function monthBuckets(results: LabResult[]): Array<{ month: string; count: number }> {
  const buckets = new Map<string, number>();
  const start = subMonths(new Date(), 11);
  for (let i = 11; i >= 0; i -= 1) {
    buckets.set(format(subMonths(new Date(), i), 'yyyy-MM'), 0);
  }
  for (const result of results) {
    const date = toDate(result.resultedAt) ?? toDate(result.collectedAt);
    if (!date || date < start) continue;
    const key = format(date, 'yyyy-MM');
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return Array.from(buckets.entries()).map(([month, count]) => ({ month, count }));
}

function claimStatusCounts(claims: Claim[]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();
  for (const claim of claims) {
    counts.set(claim.status, (counts.get(claim.status) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => a.status.localeCompare(b.status));
}

function freshnessTone(entry: FreshnessStatus): 'success' | 'warning' | 'danger' {
  if (entry.isStale) return 'danger';
  const max = entry.maxStalenessMinutes;
  const staleness = entry.stalenessMinutes;
  if (staleness !== null && max > 0 && staleness / max >= 0.75) return 'warning';
  return 'success';
}

const FRESHNESS_LABEL = { success: 'OK', warning: 'Warn', danger: 'Breach' } as const;

function FullOverview() {
  const patients = useApiList<PatientSummary>(['patients', 'list'], ENDPOINTS.patients.path);
  const results = useApiList<LabResult>(['labs', 'results'], ENDPOINTS.labResults.path);
  const claims = useApiList<Claim>(['billing', 'claims'], ENDPOINTS.claims.path);
  const quality = useApiQuery<QualityScorecard>(['governance', 'quality'], ENDPOINTS.governanceQuality.path);
  const outcomes = useApiQuery<OutcomeKpis>(['kpis', 'outcomes'], ENDPOINTS.kpisOutcomes.path);
  const freshness = useApiQuery<FreshnessStatus[]>(['governance', 'freshness'], ENDPOINTS.governanceFreshness.path);

  const loading = patients.isLoading || results.isLoading || claims.isLoading;
  const retryAll = () => {
    void patients.refetch();
    void results.refetch();
    void claims.refetch();
    void quality.refetch();
    void outcomes.refetch();
    void freshness.refetch();
  };

  const pendingResults = results.data?.filter((r) => PENDING_RESULT_STATUSES.has(r.status)).length ?? null;
  const openClaims = claims.data?.filter((c) => OPEN_CLAIM_STATUSES.has(c.status)).length ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="KPI Overview"
        description="Platform-wide clinical, revenue and data-quality health."
      />

      {/* --- Stat cards ------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {loading ? (
          Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-[92px] w-full" />
          ))
        ) : (
          <>
            <StatCard
              label="Patients"
              icon={Users}
              tone="brand"
              value={patients.isError ? '—' : formatNumber(patients.data?.length ?? 0)}
              hint={patients.isError ? 'Unavailable' : 'Golden records in MDM'}
            />
            <StatCard
              label="Results pending review"
              icon={Hourglass}
              tone="warning"
              value={results.isError ? '—' : formatNumber(pendingResults ?? 0)}
              hint="Collected / in progress / reviewed"
            />
            <StatCard
              label="Open claims"
              icon={Wallet}
              tone="purple"
              value={claims.isError ? '—' : formatNumber(openClaims ?? 0)}
              hint="Draft / submitted / pending"
            />
            <StatCard
              label="DQ score"
              icon={quality.data?.criticalFailures ? AlertOctagon : CheckCircle2}
              tone={quality.data && quality.data.criticalFailures > 0 ? 'danger' : 'success'}
              value={quality.isError ? '—' : formatPercent(quality.data?.overallScore ?? null, 0)}
              hint={
                quality.data
                  ? `${quality.data.passedRules}/${quality.data.totalRules} rules passing`
                  : 'Awaiting scorecard'
              }
            />
            <StatCard
              label="Duplicate rate (after MDM)"
              icon={Merge}
              tone="success"
              value={outcomes.isError ? '—' : formatPercent(outcomes.data?.duplicateRateAfter ?? null, 2)}
              hint={
                outcomes.data
                  ? `was ${formatPercent(outcomes.data.duplicateRateBefore, 2)} before MDM`
                  : 'Awaiting outcome KPIs'
              }
            />
          </>
        )}
      </div>

      {(patients.isError || results.isError || claims.isError) && (
        <ErrorState error={patients.error ?? results.error ?? claims.error} onRetry={retryAll} />
      )}

      {/* --- Charts ----------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Results by month</CardTitle>
            <CardDescription>Laboratory results resulted in the last 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            {results.isLoading ? (
              <ChartSkeleton />
            ) : results.isError ? (
              <ErrorState compact error={results.error} onRetry={() => void results.refetch()} />
            ) : (results.data?.length ?? 0) === 0 ? (
              <EmptyState title="No results yet" description="Released lab results will trend here." icon={FlaskConical} />
            ) : (
              <ResultsByMonthChart data={monthBuckets(results.data ?? [])} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Claims by status</CardTitle>
            <CardDescription>Revenue-cycle distribution across the claims lifecycle</CardDescription>
          </CardHeader>
          <CardContent>
            {claims.isLoading ? (
              <ChartSkeleton />
            ) : claims.isError ? (
              <ErrorState compact error={claims.error} onRetry={() => void claims.refetch()} />
            ) : (claims.data?.length ?? 0) === 0 ? (
              <EmptyState title="No claims" description="Claims submitted to payers will appear here." icon={Wallet} />
            ) : (
              <ClaimsByStatusChart data={claimStatusCounts(claims.data ?? [])} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* --- Freshness SLA strip ---------------------------------------- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-1.5">
              <Database className="h-4 w-4 text-slate-400" aria-hidden /> Freshness SLA strip
            </CardTitle>
            <CardDescription>Batch table staleness vs configured SLA thresholds</CardDescription>
          </div>
          <Badge variant={freshness.data?.some((f) => f.isStale) ? 'danger' : 'success'} dot>
            {freshness.data?.filter((f) => f.isStale).length ?? 0} breached
          </Badge>
        </CardHeader>
        <CardContent>
          {freshness.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : freshness.isError ? (
            <ErrorState compact error={freshness.error} onRetry={() => void freshness.refetch()} />
          ) : !freshness.data || freshness.data.length === 0 ? (
            <EmptyState title="No freshness monitors" description="Pipeline SLA monitors will be listed here." />
          ) : (
            <div className="flex flex-wrap gap-2">
              {freshness.data.map((entry) => {
                const tone = freshnessTone(entry);
                return (
                  <span
                    key={entry.tableName}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
                    title={`SLA ${entry.maxStalenessMinutes} min · staleness ${entry.stalenessMinutes ?? '—'} min`}
                  >
                    <span
                      className={
                        tone === 'success'
                          ? 'h-1.5 w-1.5 rounded-full bg-emerald-500'
                          : tone === 'warning'
                            ? 'h-1.5 w-1.5 rounded-full bg-amber-500'
                            : 'h-1.5 w-1.5 rounded-full bg-rose-500'
                      }
                      aria-hidden
                    />
                    <span className="font-mono text-[11px] text-slate-700">{entry.tableName}</span>
                    <Badge
                      variant={tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'danger'}
                    >
                      {FRESHNESS_LABEL[tone]}
                    </Badge>
                  </span>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 }).format(value);
}

function BillingOverview() {
  const report = useApiQuery<ComplianceReport>(
    ['compliance', 'report'],
    ENDPOINTS.governanceComplianceReport.path,
  );
  const claims = useApiList<Claim>(['billing', 'claims'], ENDPOINTS.claims.path);
  const data = report.data;
  const loading = report.isLoading || claims.isLoading;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Billing Compliance Overview"
        description="Healthcare / Billing · CDC integration · HIPAA governance · Compliance Reports"
        actions={
          <Link
            href="/compliance"
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            <FileText className="h-4 w-4" aria-hidden />
            Open report
          </Link>
        }
      />

      {report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <Database className="h-4 w-4 text-slate-400" aria-hidden /> Where this data comes from
          </CardTitle>
          <CardDescription>
            Billing is the only source in this profile; every batch is captured for CDC.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              ['Source file', 'fixtures/billing/claims.csv'],
              ['Extract', 'billing connector'],
              ['Staging', 'staging.billing_claims'],
              ['Warehouse', 'app.Claim / app.Invoice'],
              ['Change feed', 'app.OutboxEvent'],
            ].map(([label, value], index, all) => (
              <span key={label} className="inline-flex items-center gap-1.5">
                <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {label}
                  </span>
                  <span className="font-mono text-[11px] text-slate-700">{value}</span>
                </span>
                {index < all.length - 1 ? (
                  <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden />
                ) : null}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {loading ? (
          Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-[92px] w-full" />
          ))
        ) : (
          <>
            <StatCard
              label="Claims"
              icon={Wallet}
              tone="brand"
              value={formatNumber(data?.billing.totalClaims ?? 0)}
              hint="Billing source records"
            />
            <StatCard
              label="Open claims"
              icon={Hourglass}
              tone="warning"
              value={formatNumber(data?.billing.openClaims ?? 0)}
              hint="Draft / submitted / pending"
            />
            <StatCard
              label="Total billed"
              icon={FileText}
              tone="purple"
              value={money(data?.billing.totalBilled)}
              hint={`paid ${money(data?.billing.totalPaid)}`}
            />
            <StatCard
              label="DQ score"
              icon={data?.quality.criticalFailures ? AlertOctagon : CheckCircle2}
              tone={data && data.quality.criticalFailures > 0 ? 'danger' : 'success'}
              value={formatPercent(data?.quality.overallScore ?? null, 0)}
              hint={
                data ? `${data.quality.passedRules}/${data.quality.totalRules} rules passing` : 'Awaiting scorecard'
              }
            />
            <StatCard
              label="CDC queue"
              icon={Database}
              tone="success"
              value={formatNumber(data?.cdc.pendingEvents ?? 0)}
              hint="Pending outbox events"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Claims by status</CardTitle>
            <CardDescription>Revenue-cycle distribution across the billing source</CardDescription>
          </CardHeader>
          <CardContent>
            {claims.isLoading ? (
              <ChartSkeleton />
            ) : claims.isError ? (
              <ErrorState compact error={claims.error} onRetry={() => void claims.refetch()} />
            ) : (claims.data?.length ?? 0) === 0 ? (
              <EmptyState title="No claims" description="Claims submitted to payers will appear here." icon={Wallet} />
            ) : (
              <ClaimsByStatusChart data={claimStatusCounts(claims.data ?? [])} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Compliance report</CardTitle>
            <CardDescription>HIPAA evidence captured by the platform</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-600">Audit events (24h)</span>
              <span className="font-medium tabular-nums">{formatNumber(data?.audit.eventsLast24h ?? 0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">Audit events (total)</span>
              <span className="font-medium tabular-nums">{formatNumber(data?.audit.totalEvents ?? 0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">CDC delivered</span>
              <span className="font-medium tabular-nums">{formatNumber(data?.cdc.deliveredEvents ?? 0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">Failed DQ rules</span>
              <Badge variant={data && data.quality.failedRules > 0 ? 'danger' : 'success'}>
                {data?.quality.failedRules ?? 0}
              </Badge>
            </div>
            <p className="pt-1 text-xs text-slate-500">
              Last billing run: {data?.billing.lastRunAt ? toDate(data.billing.lastRunAt)?.toLocaleString() : '—'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-1.5">
              <Database className="h-4 w-4 text-slate-400" aria-hidden /> Freshness SLA strip
            </CardTitle>
            <CardDescription>Staleness of the tables monitored for compliance</CardDescription>
          </div>
          <Badge variant={data?.freshness.some((f) => f.isStale) ? 'danger' : 'success'} dot>
            {data?.freshness.filter((f) => f.isStale).length ?? 0} breached
          </Badge>
        </CardHeader>
        <CardContent>
          {report.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : !data || data.freshness.length === 0 ? (
            <EmptyState title="No freshness monitors" description="SLA monitors will be listed here." />
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.freshness.map((entry) => (
                <span
                  key={entry.tableName}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
                  title={`SLA ${entry.maxStalenessMinutes} min · staleness ${entry.stalenessMinutes ?? '—'} min`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${entry.isStale ? 'bg-rose-500' : 'bg-emerald-500'}`}
                    aria-hidden
                  />
                  <span className="font-mono text-[11px] text-slate-700">{entry.tableName}</span>
                  <Badge variant={entry.isStale ? 'danger' : 'success'}>
                    {entry.isStale ? 'Breach' : 'OK'}
                  </Badge>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function OverviewPage() {
  return IS_BILLING_SCOPE ? <BillingOverview /> : <FullOverview />;
}
