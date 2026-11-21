import type { NextFunction, Request, Response } from 'express';
import { MdmReviewDecisionSchema } from '@medidata/shared';
import { ok } from '../../lib/envelope.js';
import * as service from './service.js';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

const wrap =
  (fn: (req: Request) => Promise<unknown>): Handler =>
  async (req, res, next) => {
    try {
      res.status(200).json(ok(await fn(req)));
    } catch (err) {
      next(err);
    }
  };

export const catalog = wrap(() => service.catalog());
export const glossary = wrap(() => service.glossary());
export const lineage = wrap(() => service.lineage());
export const quality = wrap((req) => service.quality(req));
export const freshness = wrap(() => service.freshness());

export async function audit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = service.AuditQuerySchema.parse(req.query);
    res.status(200).json(ok(await service.auditLog(req, query)));
  } catch (err) {
    next(err);
  }
}

export async function mdmCandidates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = service.MdmCandidateQuerySchema.parse(req.query);
    res.status(200).json(ok(await service.mdmCandidates(query)));
  } catch (err) {
    next(err);
  }
}

export async function reviewMdmCandidate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = MdmReviewDecisionSchema.parse(req.body);
    res.status(200).json(ok(await service.reviewMdmCandidate(req, req.params.id as string, body)));
  } catch (err) {
    next(err);
  }
}

const csvCell = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;

/** GET /api/governance/compliance-report — JSON, or CSV with `?format=csv`. */
export async function complianceReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const report = await service.complianceReport();
    if (req.query.format === 'csv') {
      const rows: Array<[string, unknown]> = [
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
      const csv = ['metric,value', ...rows.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`)].join('\n');
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="medidata-compliance-report.csv"');
      res.status(200).send(csv);
      return;
    }
    res.status(200).json(ok(report));
  } catch (err) {
    next(err);
  }
}
