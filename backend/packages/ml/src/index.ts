/**
 * @medidata/ml — deterministic, explainable patient risk scoring.
 *
 * No ML library and no training step: a fixed logistic model with documented
 * weights. Every score comes with the top contributing factors, so a clinician
 * can see *why* a patient is HIGH risk.
 *
 * Reliability gate (the "AI reliability" story): `evaluateDqGate(patientId)`
 * re-checks the patient's own rows against the critical DQ invariants before
 * the model is allowed to score. If the patient's data is broken we refuse to
 * predict instead of producing a confident wrong answer. The gate is
 * patient-scoped on purpose: a handful of deliberately dirty demo rows must
 * not block scoring for the other 115 patients.
 */
import { prisma, type PrismaClient } from '@medidata/db';
import type { RiskScore } from '@medidata/shared';
import { getGoldenId } from '@medidata/mdm';

export type MlDb = PrismaClient;

export interface DqGateFailure {
  code: string;
  name: string;
  severity: 'CRITICAL' | 'WARNING';
  failedCount: number;
}

export interface DqGateResult {
  ok: boolean;
  passed: boolean;
  patientId: string;
  checkedAt: Date;
  rulesEvaluated: number;
  failures: DqGateFailure[];
}

const CHRONIC_PREFIXES = ['E11', 'I10', 'J18', 'N39', 'K29'] as const;

const MODEL_VERSION = 'medidata-risk-v1.0 (deterministic logistic, fixed weights)';

/** Fixed model weights — the whole model, fully auditable. */
export const MODEL_WEIGHTS = {
  intercept: -2.2,
  agePerYear: 0.028,
  abnormalRatio: 1.4,
  chronicDiagnoses: 0.55,
  emergencyVisits: 0.45,
  inpatientStays: 0.25,
  deniedClaims: 0.4,
  encounterCount: 0.08,
  avgInpatientLos: 0.12,
} as const;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const round = (n: number, places = 3): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

function ageOf(dateOfBirth: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) age -= 1;
  return Math.max(0, age);
}

function bandFor(score: number): RiskScore['riskBand'] {
  if (score < 0.34) return 'LOW';
  if (score < 0.67) return 'MEDIUM';
  return 'HIGH';
}

// ---------------------------------------------------------------------------
// DQ gate (patient-scoped)
// ---------------------------------------------------------------------------

/**
 * Evaluate the critical data-quality invariants that matter for this patient.
 * Each invariant mirrors a global DQ rule but is restricted to the patient's
 * rows. Returns ok:false when any invariant is violated.
 */
export async function evaluateDqGate(
  patientId: string,
  opts: { client?: MlDb; now?: Date } = {},
): Promise<DqGateResult> {
  const client = opts.client ?? prisma;
  const checkedAt = opts.now ?? new Date();

  const [patient, results, claims] = await Promise.all([
    client.patient.findUnique({ where: { id: patientId } }),
    client.labResult.findMany({
      where: { patientId },
      select: { collectedAt: true, resultedAt: true, valueNumeric: true, valueText: true, abnormalFlag: true },
    }),
    client.claim.findMany({
      where: { patientId },
      select: { billedAmount: true, paidAmount: true },
    }),
  ]);

  if (!patient) {
    throw Object.assign(new Error(`Patient ${patientId} not found`), { code: 'NOT_FOUND' });
  }

  // Duplicate check needs name+DOB, so do it with the patient row we have.
  const duplicatePartners = await client.patient.count({
    where: {
      id: { not: patientId },
      fullNameNormalized: patient.fullNameNormalized,
      dateOfBirth: patient.dateOfBirth,
    },
  });

  const failures: DqGateFailure[] = [];
  const push = (code: string, name: string, severity: DqGateFailure['severity'], failedCount: number): void => {
    if (failedCount > 0) failures.push({ code, name, severity, failedCount });
  };

  push('PAT-DOB', 'Patient must have a date of birth', 'CRITICAL', patient.dateOfBirth ? 0 : 1);
  push(
    'LAB-TAT-ORDER',
    'Resulted timestamp must not precede collection',
    'CRITICAL',
    results.filter((r) => r.resultedAt !== null && r.collectedAt > r.resultedAt).length,
  );
  push(
    'LAB-VALUE',
    'A result must carry a numeric or textual value',
    'CRITICAL',
    results.filter((r) => r.valueNumeric === null && (r.valueText === null || r.valueText === '')).length,
  );
  push(
    'BILL-NEGATIVE',
    'Claim amounts must never be negative',
    'CRITICAL',
    claims.filter((c) => Number(c.billedAmount) < 0 || (c.paidAmount !== null && Number(c.paidAmount) < 0)).length,
  );
  push(
    'BILL-PAID-GT-BILLED',
    'Paid amount must not exceed billed amount',
    'CRITICAL',
    claims.filter((c) => c.paidAmount !== null && Number(c.paidAmount) > Number(c.billedAmount)).length,
  );
  push('DUP-PATIENT', 'Probable duplicate patient record', 'CRITICAL', duplicatePartners);

  return {
    ok: failures.length === 0,
    passed: failures.length === 0,
    patientId,
    checkedAt,
    rulesEvaluated: 6,
    failures,
  };
}

/** Alias kept for the API's dynamic-import probe (`getRiskGate`). */
export const getRiskGate = evaluateDqGate;

// ---------------------------------------------------------------------------
// Risk model
// ---------------------------------------------------------------------------

export interface RiskExplanation {
  score: RiskScore;
  features: Record<string, number>;
}

export async function evaluatePatientRisk(
  patientId: string,
  opts: { client?: MlDb; now?: Date } = {},
): Promise<RiskScore> {
  const client = opts.client ?? prisma;
  const now = opts.now ?? new Date();

  const [patient, results, encounters, claims] = await Promise.all([
    client.patient.findUnique({ where: { id: patientId } }),
    client.labResult.findMany({
      where: { patientId },
      select: { abnormalFlag: true, testCode: true },
    }),
    client.encounter.findMany({
      where: { patientId },
      select: { type: true, diagnosisCode: true, admittedAt: true, dischargedAt: true },
    }),
    client.claim.findMany({ where: { patientId }, select: { status: true } }),
  ]);

  if (!patient) {
    throw Object.assign(new Error(`Patient ${patientId} not found`), { code: 'NOT_FOUND' });
  }

  const age = ageOf(patient.dateOfBirth, now);
  const abnormalCount = results.filter((r) => r.abnormalFlag !== null && r.abnormalFlag !== '').length;
  const abnormalRatio = results.length === 0 ? 0 : abnormalCount / results.length;
  const chronicDx = new Set(
    encounters
      .filter((e) => CHRONIC_PREFIXES.some((p) => e.diagnosisCode.startsWith(p)))
      .map((e) => e.diagnosisCode),
  ).size;
  const emergencyVisits = encounters.filter((e) => e.type === 'EMERGENCY').length;
  const inpatientStays = encounters.filter((e) => e.type === 'INPATIENT').length;
  const deniedClaims = claims.filter((c) => c.status === 'DENIED' || c.status === 'APPEALED').length;
  const encounterCount = encounters.length;
  const losValues = encounters
    .filter((e) => e.type === 'INPATIENT' && e.dischargedAt)
    .map((e) => (e.dischargedAt!.getTime() - e.admittedAt.getTime()) / 86_400_000)
    .filter((v) => Number.isFinite(v) && v >= 0);
  const avgInpatientLos = losValues.length === 0 ? 0 : losValues.reduce((s, v) => s + v, 0) / losValues.length;

  const features = {
    age,
    abnormalRatio,
    chronicDx,
    emergencyVisits,
    inpatientStays,
    deniedClaims,
    encounterCount,
    avgInpatientLos,
  };

  const w = MODEL_WEIGHTS;
  const contributions = {
    age: w.agePerYear * Math.min(age, 90),
    abnormalRatio: w.abnormalRatio * abnormalRatio,
    chronicDx: w.chronicDiagnoses * Math.min(chronicDx, 6),
    emergencyVisits: w.emergencyVisits * Math.min(emergencyVisits, 6),
    inpatientStays: w.inpatientStays * Math.min(inpatientStays, 6),
    deniedClaims: w.deniedClaims * Math.min(deniedClaims, 5),
    encounterCount: w.encounterCount * Math.min(encounterCount, 20),
    avgInpatientLos: w.avgInpatientLos * Math.min(avgInpatientLos, 14),
  };

  const z = w.intercept + Object.values(contributions).reduce((s, v) => s + v, 0);
  const riskScore = round(sigmoid(z));

  const labels: Record<keyof typeof contributions, string> = {
    age: `age_${age}`,
    abnormalRatio: `abnormal_result_ratio_${Math.round(abnormalRatio * 100)}pct`,
    chronicDx: `chronic_diagnoses_${chronicDx}`,
    emergencyVisits: `emergency_visits_${emergencyVisits}`,
    inpatientStays: `inpatient_stays_${inpatientStays}`,
    deniedClaims: `denied_claims_${deniedClaims}`,
    encounterCount: `encounters_${encounterCount}`,
    avgInpatientLos: `avg_inpatient_los_${round(avgInpatientLos, 1)}d`,
  };

  const topFactors = (Object.entries(contributions) as Array<[keyof typeof contributions, number]>)
    .map(([key, value]) => ({ factor: labels[key], contribution: round(Math.max(0, value)) }))
    .filter((f) => f.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  const goldenId = await getGoldenId(patientId, { client }).catch(() => null);

  return {
    patientId,
    goldenId,
    riskScore,
    riskBand: bandFor(riskScore),
    topFactors,
    modelVersion: MODEL_VERSION,
    generatedAt: now,
  };
}

/** Alias kept for the API's dynamic-import probe (`scorePatientRisk`). */
export const scorePatientRisk = evaluatePatientRisk;

/** Full explanation (score + raw feature vector) — used by the worker/report. */
export async function explainPatientRisk(
  patientId: string,
  opts: { client?: MlDb; now?: Date } = {},
): Promise<RiskExplanation> {
  const client = opts.client ?? prisma;
  const score = await evaluatePatientRisk(patientId, opts);
  const patient = await client.patient.findUniqueOrThrow({ where: { id: patientId } });
  const results = await client.labResult.findMany({ where: { patientId }, select: { abnormalFlag: true } });
  const encounters = await client.encounter.findMany({
    where: { patientId },
    select: { type: true, diagnosisCode: true, admittedAt: true, dischargedAt: true },
  });
  const claims = await client.claim.findMany({ where: { patientId }, select: { status: true } });
  const abnormalCount = results.filter((r) => r.abnormalFlag).length;
  return {
    score,
    features: {
      age: ageOf(patient.dateOfBirth, opts.now ?? new Date()),
      abnormalRatio: results.length === 0 ? 0 : round(abnormalCount / results.length),
      chronicDx: new Set(
        encounters.filter((e) => CHRONIC_PREFIXES.some((p) => e.diagnosisCode.startsWith(p))).map((e) => e.diagnosisCode),
      ).size,
      emergencyVisits: encounters.filter((e) => e.type === 'EMERGENCY').length,
      inpatientStays: encounters.filter((e) => e.type === 'INPATIENT').length,
      deniedClaims: claims.filter((c) => c.status === 'DENIED' || c.status === 'APPEALED').length,
      encounterCount: encounters.length,
    },
  };
}
