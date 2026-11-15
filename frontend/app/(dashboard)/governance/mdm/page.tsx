'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, GitMerge, RefreshCw, ShieldQuestion, X } from 'lucide-react';
import {
  ENDPOINTS,
  type MdmMergeCandidate,
  type PatientSummary,
  type QualityScorecard,
} from '@medidata/shared';
import { ApiError, apiFetch } from '@/lib/api';
import { useApiList, useApiQuery } from '@/lib/queries';
import { formatDate, formatNumber } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

/**
 * MDM merge-candidate review (human-in-the-loop).
 *
 * The API exposes the review queue at `GET /api/governance/mdm/candidates` and
 * the steward decision at `POST /api/governance/mdm/candidates/:id/review`.
 * Candidates with a match score in the review band (0.85–0.97) are never
 * merged automatically: a steward approves or rejects each pair here.
 */
function MatchScoreBar({ score }: { score: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  const tone = pct >= 97 ? 'bg-rose-500' : pct >= 90 ? 'bg-amber-500' : 'bg-sky-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-100">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-semibold tabular-nums text-slate-700">{pct}%</span>
    </div>
  );
}

const STATUS_VARIANT = {
  PENDING: 'warning',
  MERGED: 'success',
  REJECTED: 'default',
} as const;

export default function MdmPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const candidates = useApiList<MdmMergeCandidate>(['governance', 'mdm', 'candidates'], ENDPOINTS.governanceMdmCandidates.path, {
    staleTime: 15_000,
  });
  const quality = useApiQuery<QualityScorecard>(['governance', 'quality'], ENDPOINTS.governanceQuality.path);
  const patients = useApiList<PatientSummary>(['patients', 'list'], ENDPOINTS.patients.path, { staleTime: 60_000 });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'PENDING' | 'ALL'>('PENDING');

  const reviewMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'MERGED' | 'REJECTED' }) =>
      apiFetch<MdmMergeCandidate>(
        ENDPOINTS.governanceMdmCandidateReview.path.replace(':id', id),
        { method: 'POST', body: { decision } },
      ),
    onMutate: ({ id }) => setBusyId(id),
    onSuccess: (candidate) => {
      toast({
        title: candidate.status === 'MERGED' ? 'Merge approved' : 'Merge rejected',
        description: `Candidate ${candidate.goldenId} · ${candidate.status?.toLowerCase() ?? 'updated'}`,
        variant: candidate.status === 'MERGED' ? 'success' : 'default',
      });
      void queryClient.invalidateQueries({ queryKey: ['governance', 'mdm', 'candidates'] });
      void queryClient.invalidateQueries({ queryKey: ['governance', 'quality'] });
      void queryClient.invalidateQueries({ queryKey: ['patients', 'list'] });
    },
    onError: (error: ApiError) => {
      toast({ title: 'Review failed', description: `${error.code}: ${error.message}`, variant: 'error' });
    },
    onSettled: () => setBusyId(null),
  });

  const rows = useMemo(() => {
    const all = candidates.data ?? [];
    return statusFilter === 'ALL' ? all : all.filter((c) => (c.status ?? 'PENDING') === 'PENDING');
  }, [candidates.data, statusFilter]);

  const pendingCount = useMemo(
    () => (candidates.data ?? []).filter((c) => (c.status ?? 'PENDING') === 'PENDING').length,
    [candidates.data],
  );

  const duplicateRules = useMemo(
    () =>
      (quality.data?.results ?? []).filter((result) =>
        /dup|mdm|merge|golden/i.test(`${result.rule.code} ${result.rule.name} ${result.rule.description}`),
      ),
    [quality.data],
  );

  const duplicatePatients = useMemo(
    () => (patients.data ?? []).filter((patient) => (patient.duplicateCount ?? 0) > 0),
    [patients.data],
  );

  const refreshAll = (): void => {
    void candidates.refetch();
    void quality.refetch();
    void patients.refetch();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="MDM Merge Review"
        description="Golden-record survivorship and duplicate resolution — steward approval required in the 85–97% match band."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setStatusFilter((current) => (current === 'PENDING' ? 'ALL' : 'PENDING'))}
            >
              {statusFilter === 'PENDING' ? 'Show all' : 'Show pending'}
            </Button>
            <Button variant="secondary" size="sm" onClick={refreshAll}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden /> Refresh
            </Button>
            <Badge variant={pendingCount > 0 ? 'warning' : 'success'}>{pendingCount} pending</Badge>
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <GitMerge className="h-4 w-4 text-violet-500" aria-hidden /> Merge candidates
          </CardTitle>
          <CardDescription>
            Pairs that scored in the review band. Approving merges the right record into the golden id;
            rejecting keeps both records separate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {candidates.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : candidates.isError ? (
            <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ShieldQuestion}
              title={statusFilter === 'PENDING' ? 'No pending merge candidates' : 'No merge candidates yet'}
              description={
                statusFilter === 'PENDING'
                  ? 'Everything in the review band has been resolved. Run the pipeline to re-score the patient index.'
                  : 'Run the MDM job (npm run pipeline) to score the patient index and populate the review queue.'
              }
            />
          ) : (
            <ul className="space-y-3">
              {rows.map((candidate) => {
                const status = candidate.status ?? 'PENDING';
                const isPending = status === 'PENDING';
                const id = candidate.id;
                const busy = busyId !== null && busyId === id;
                return (
                  <li
                    key={id ?? `${candidate.leftPatientId}-${candidate.rightPatientId}`}
                    className="rounded-md border border-slate-200 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <MatchScoreBar score={candidate.matchScore} />
                      <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
                      <span className="font-mono text-[11px] text-slate-500">golden {candidate.goldenId.slice(0, 18)}…</span>
                      <span className="ml-auto text-[11px] text-slate-400">{candidate.survivorshipRule}</span>
                    </div>

                    <div className="mt-2 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                      <div className="rounded border border-slate-200 bg-slate-50 p-2">
                        <p className="font-medium text-slate-800">
                          {candidate.leftPatient?.fullName ?? candidate.leftPatientId.slice(0, 8)}
                        </p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {candidate.leftPatient?.mrn ?? '—'} ·{' '}
                          {candidate.leftPatient?.dateOfBirth ? formatDate(candidate.leftPatient.dateOfBirth) : '—'}
                        </p>
                      </div>
                      <div className="rounded border border-slate-200 bg-slate-50 p-2">
                        <p className="font-medium text-slate-800">
                          {candidate.rightPatient?.fullName ?? candidate.rightPatientId.slice(0, 8)}
                        </p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {candidate.rightPatient?.mrn ?? '—'} ·{' '}
                          {candidate.rightPatient?.dateOfBirth ? formatDate(candidate.rightPatient.dateOfBirth) : '—'}
                        </p>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {candidate.matchReasons.map((reason) => (
                        <Badge key={reason} variant="info">
                          {reason}
                        </Badge>
                      ))}
                    </div>

                    {isPending && id ? (
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => reviewMutation.mutate({ id, decision: 'MERGED' })}
                        >
                          <Check className="mr-1 h-3.5 w-3.5" aria-hidden /> Approve merge
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => reviewMutation.mutate({ id, decision: 'REJECTED' })}
                        >
                          <X className="mr-1 h-3.5 w-3.5" aria-hidden /> Reject
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Duplicate signals</CardTitle>
            <CardDescription>From the patient index and the latest DQ scorecard — the inputs merge review acts on</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {quality.isLoading || patients.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : quality.isError && patients.isError ? (
              <ErrorState compact error={quality.error} onRetry={refreshAll} />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">Patients with duplicates</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
                      {patients.data ? formatNumber(duplicatePatients.length) : '—'}
                    </p>
                  </div>
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">Duplicate-related DQ rules</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
                      {quality.data ? formatNumber(duplicateRules.length) : '—'}
                    </p>
                  </div>
                </div>
                {duplicateRules.length > 0 ? (
                  <ul className="space-y-1.5">
                    {duplicateRules.map((result) => (
                      <li key={result.id} className="flex items-center gap-2 rounded border border-slate-200 px-2.5 py-1.5 text-xs">
                        <Badge variant={result.passed ? 'success' : 'danger'}>{result.passed ? 'PASS' : 'FAIL'}</Badge>
                        <span className="truncate font-medium text-slate-700">{result.rule.name}</span>
                        <span className="ml-auto tabular-nums text-slate-500">{formatNumber(result.failedCount)} rows</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-500">
                    No duplicate-related rules in the latest scorecard
                    {quality.isError ? ' (scorecard unavailable)' : ''}.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Survivorship rules</CardTitle>
            <CardDescription>How the winning field values are chosen when a merge is approved</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-xs leading-5 text-slate-600">
              <li>
                <span className="font-semibold text-slate-800">Source priority:</span> EMR &gt; LIS &gt; BILLING &gt;
                INSURANCE &gt; LEGACY.
              </li>
              <li>
                <span className="font-semibold text-slate-800">Completeness:</span> when sources tie, the record with
                the most populated demographics wins.
              </li>
              <li>
                <span className="font-semibold text-slate-800">Stable tie-break:</span> the lowest MRN survives, so
                re-runs are deterministic.
              </li>
              <li>
                <span className="font-semibold text-slate-800">Never discard:</span> losing records remain as aliases
                mapped to the golden id in <span className="font-mono">gov.MdmMaster</span>.
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
