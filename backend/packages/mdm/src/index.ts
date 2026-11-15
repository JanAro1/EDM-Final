/**
 * @medidata/mdm — master data management.
 *
 * Deterministic, explainable patient matching (no black box):
 *   1. Block on date of birth, then score every candidate pair with weighted
 *      fuzzball string similarity (name, phone, sex, city, address).
 *   2. Pairs at/above AUTO_MERGE_THRESHOLD become one golden record
 *      immediately. Pairs in the review band become `gov.MdmMergeCandidate`
 *      rows for a human steward (HITL) — nothing is auto-merged silently.
 *   3. Survivorship: EMR > LIS > BILLING > INSURANCE > LEGACY, then the most
 *      complete record, then the lowest MRN. `gov.MdmMaster` maps every source
 *      record (patient) to its golden id so the warehouse loader can collapse
 *      duplicates into one `warehouse.DimPatient`.
 *
 * Everything is idempotent: re-running produces the same golden ids and
 * upserts (never duplicates) master rows / pending candidates.
 */
import { createHash } from 'node:crypto';
import { prisma, type Patient, type PrismaClient, type SourceSystem } from '@medidata/db';
import fuzzball from 'fuzzball';

// `fuzzball` is CommonJS (`module.exports = fuzzball`), so Node's ESM loader
// cannot statically detect its named exports. Import the default object and
// destructure at runtime.
const { ratio } = fuzzball;

export type MdmDb = PrismaClient;

/** Similarity at/above this is safe to merge without human review. */
export const AUTO_MERGE_THRESHOLD = 0.97;
/** Similarity at/above this is queued for steward review. */
export const REVIEW_THRESHOLD = 0.85;

const SOURCE_PRECEDENCE: Record<SourceSystem, number> = {
  EMR: 5,
  LIS: 4,
  BILLING: 3,
  INSURANCE: 2,
  LEGACY: 1,
};

export interface MdmPairScore {
  score: number;
  reasons: string[];
}

export interface MdmClusterMember {
  patientId: string;
  mrn: string;
  sourceSystem: SourceSystem;
  matchScore: number;
  isGolden: boolean;
}

export interface MdmRunResult {
  patients: number;
  goldenRecords: number;
  mergedRecords: number;
  autoMerged: number;
  pendingCandidates: number;
  duplicatesFound: number;
  durationMs: number;
}

export interface MdmCandidateView {
  id: string;
  goldenId: string;
  leftPatientId: string;
  rightPatientId: string;
  matchScore: number;
  matchReasons: string[];
  survivorshipRule: string;
  status: 'PENDING' | 'MERGED' | 'REJECTED';
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedById: string | null;
  leftPatient: { mrn: string; fullName: string; dateOfBirth: Date; city: string | null } | null;
  rightPatient: { mrn: string; fullName: string; dateOfBirth: Date; city: string | null } | null;
}

export class MdmError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'ALREADY_REVIEWED' | 'INVALID_DECISION',
    message: string,
  ) {
    super(message);
    this.name = 'MdmError';
  }
}

// ---------------------------------------------------------------------------
// Pure matching helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Last 10 digits of a phone number — ignores +63 / (632) formatting noise. */
export function normalizePhone(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '').slice(-10);
}

function normalizedName(p: Pick<Patient, 'fullNameNormalized' | 'firstName' | 'lastName'>): string {
  return (p.fullNameNormalized || `${p.firstName} ${p.lastName}`).toUpperCase().replace(/\s+/g, ' ').trim();
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Weighted pair score in [0,1] plus human-readable reasons. The weights sum
 * to 1 so the score is directly interpretable.
 */
export function scorePatientPair(
  left: Pick<Patient, 'fullNameNormalized' | 'firstName' | 'lastName' | 'dateOfBirth' | 'sex' | 'phone' | 'city' | 'address'>,
  right: Pick<Patient, 'fullNameNormalized' | 'firstName' | 'lastName' | 'dateOfBirth' | 'sex' | 'phone' | 'city' | 'address'>,
): MdmPairScore {
  const reasons: string[] = [];
  let score = 0;

  if (dateKey(left.dateOfBirth) === dateKey(right.dateOfBirth)) {
    score += 0.35;
    reasons.push('date_of_birth_exact');
  }

  const nameSimilarity = ratio(normalizedName(left), normalizedName(right)) / 100;
  score += 0.35 * nameSimilarity;
  if (nameSimilarity >= 0.9) reasons.push(`name_similarity_${Math.round(nameSimilarity * 100)}`);

  const leftPhone = normalizePhone(left.phone);
  const rightPhone = normalizePhone(right.phone);
  if (leftPhone && leftPhone === rightPhone) {
    score += 0.15;
    reasons.push('phone_exact');
  }

  if (left.sex === right.sex) {
    score += 0.05;
    reasons.push('sex_match');
  }

  const citySimilarity = ratio((left.city ?? '').toUpperCase(), (right.city ?? '').toUpperCase()) / 100;
  score += 0.05 * citySimilarity;
  if (citySimilarity >= 0.9) reasons.push('city_match');

  const addressSimilarity = ratio((left.address ?? '').toUpperCase(), (right.address ?? '').toUpperCase()) / 100;
  score += 0.05 * addressSimilarity;
  if (addressSimilarity >= 0.9) reasons.push('address_match');

  return { score: Math.round(Math.min(1, score) * 1000) / 1000, reasons };
}

/** Deterministic golden id for a standalone patient (stable across runs). */
export function standaloneGoldenId(patientId: string): string {
  const hash = createHash('sha1').update(`medidata-golden:${patientId}`).digest('hex').slice(0, 24);
  return `golden-${hash}`;
}

/** Deterministic golden id for a cluster (independent of input order). */
export function clusterGoldenId(patientIds: readonly string[]): string {
  const hash = createHash('sha1')
    .update(`medidata-cluster:${[...patientIds].sort().join('|')}`)
    .digest('hex')
    .slice(0, 24);
  return `golden-${hash}`;
}

/** Survivorship: source precedence → completeness → lowest MRN. */
export function pickSurvivor<T extends Pick<Patient, 'id' | 'mrn' | 'sourceSystem' | 'phone' | 'email' | 'address' | 'city'>>(
  members: readonly T[],
): T {
  const completeness = (p: T): number =>
    [p.phone, p.email, p.address, p.city].filter((v) => typeof v === 'string' && v.trim() !== '').length;
  return [...members].sort((a, b) => {
    const bySource = SOURCE_PRECEDENCE[b.sourceSystem] - SOURCE_PRECEDENCE[a.sourceSystem];
    if (bySource !== 0) return bySource;
    const byCompleteness = completeness(b) - completeness(a);
    if (byCompleteness !== 0) return byCompleteness;
    return a.mrn.localeCompare(b.mrn);
  })[0]!;
}

/** Union-find over patient ids for auto-merge clusters. */
class UnionFind {
  private readonly parent = new Map<string, string>();

  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent || parent === id) {
      this.parent.set(id, id);
      return id;
    }
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  groups(ids: readonly string[]): string[][] {
    const byRoot = new Map<string, string[]>();
    for (const id of ids) {
      const root = this.find(id);
      const list = byRoot.get(root);
      if (list) list.push(id);
      else byRoot.set(root, [id]);
    }
    return [...byRoot.values()];
  }
}

// ---------------------------------------------------------------------------
// Matching run
// ---------------------------------------------------------------------------

export interface RunMdmOptions {
  client?: MdmDb;
  /** Delete existing master rows + PENDING candidates first (keeps human decisions). */
  reset?: boolean;
  log?: (event: string, meta?: Record<string, unknown>) => void;
}

export async function runMdm(opts: RunMdmOptions = {}): Promise<MdmRunResult> {
  const client = opts.client ?? prisma;
  const startedAt = Date.now();
  const log = opts.log ?? (() => undefined);

  const patients = await client.patient.findMany({
    orderBy: { mrn: 'asc' },
  });

  if (opts.reset) {
    await client.mdmMergeCandidate.deleteMany({ where: { status: 'PENDING' } });
    await client.mdmMaster.deleteMany();
  }

  // 1) Block on DOB so we never do a full cross-join.
  const blocks = new Map<string, Patient[]>();
  for (const p of patients) {
    const key = dateKey(p.dateOfBirth);
    const list = blocks.get(key);
    if (list) list.push(p);
    else blocks.set(key, [p]);
  }

  const uf = new UnionFind();
  const pairs: Array<{ left: Patient; right: Patient; score: number; reasons: string[] }> = [];

  for (const block of blocks.values()) {
    for (let i = 0; i < block.length; i++) {
      for (let j = i + 1; j < block.length; j++) {
        const left = block[i]!;
        const right = block[j]!;
        const { score, reasons } = scorePatientPair(left, right);
        if (score < REVIEW_THRESHOLD) continue;
        pairs.push({ left, right, score, reasons });
        if (score >= AUTO_MERGE_THRESHOLD) uf.union(left.id, right.id);
      }
    }
  }

  // 2) Golden assignment for auto-merged clusters + singletons.
  const clusters = uf.groups(patients.map((p) => p.id));
  const patientById = new Map(patients.map((p) => [p.id, p]));
  const goldenByPatient = new Map<string, string>();
  const survivorByGolden = new Map<string, Patient>();
  let autoMerged = 0;

  for (const cluster of clusters) {
    const members = cluster.map((id) => patientById.get(id)!).filter(Boolean);
    const survivor = pickSurvivor(members);
    const goldenId = members.length > 1 ? clusterGoldenId(members.map((m) => m.id)) : standaloneGoldenId(survivor.id);
    survivorByGolden.set(goldenId, survivor);
    for (const member of members) {
      goldenByPatient.set(member.id, goldenId);
      if (member.id !== survivor.id) autoMerged += 1;
    }
  }

  // 3) Upsert gov.MdmMaster for every patient (idempotent on patientId).
  const existingMasters = await client.mdmMaster.findMany({ select: { id: true, patientId: true } });
  const masterByPatient = new Map(existingMasters.map((m) => [m.patientId, m.id]));

  for (const patient of patients) {
    const goldenId = goldenByPatient.get(patient.id) ?? standaloneGoldenId(patient.id);
    const survivor = survivorByGolden.get(goldenId);
    const isGolden = !survivor || survivor.id === patient.id;
    const data = {
      goldenId,
      sourceSystem: patient.sourceSystem,
      sourceRecordId: patient.mrn,
      patientId: patient.id,
      matchScore: isGolden ? 1 : (pairs.find(
        (p) =>
          (p.left.id === patient.id && goldenByPatient.get(p.right.id) === goldenId) ||
          (p.right.id === patient.id && goldenByPatient.get(p.left.id) === goldenId),
      )?.score ?? REVIEW_THRESHOLD),
      isGolden,
      survivorshipRule: 'EMR>LIS>BILLING>INSURANCE>LEGACY, then completeness, then lowest MRN',
    };
    const existingId = masterByPatient.get(patient.id);
    if (existingId) {
      await client.mdmMaster.update({ where: { id: existingId }, data });
    } else {
      await client.mdmMaster.create({ data });
    }
  }

  // Remove master rows for patients that no longer exist.
  const patientIds = new Set(patients.map((p) => p.id));
  const stale = existingMasters.filter((m) => !patientIds.has(m.patientId));
  if (stale.length > 0) {
    await client.mdmMaster.deleteMany({ where: { id: { in: stale.map((m) => m.id) } } });
  }

  // 4) Queue review-band pairs (one row per unordered pair).
  let pendingCandidates = 0;
  const queued = new Set<string>();
  for (const pair of pairs) {
    if (pair.score >= AUTO_MERGE_THRESHOLD) continue;
    const [leftId, rightId] = [pair.left.id, pair.right.id].sort() as [string, string];
    const key = `${leftId}:${rightId}`;
    if (queued.has(key)) continue;
    queued.add(key);

    const leftGolden = goldenByPatient.get(leftId) ?? standaloneGoldenId(leftId);
    const rightGolden = goldenByPatient.get(rightId) ?? standaloneGoldenId(rightId);
    if (leftGolden === rightGolden) continue;

    await client.mdmMergeCandidate.upsert({
      where: { leftPatientId_rightPatientId: { leftPatientId: leftId, rightPatientId: rightId } },
      create: {
        goldenId: leftGolden,
        leftPatientId: leftId,
        rightPatientId: rightId,
        matchScore: pair.score,
        matchReasons: pair.reasons as never,
        survivorshipRule: 'steward approval required (review band 0.85-0.97)',
        status: 'PENDING',
      },
      update: {
        // Never overwrite a human decision — only refresh the evidence.
        matchScore: pair.score,
        matchReasons: pair.reasons as never,
      },
    });
    pendingCandidates += 1;
  }

  const result: MdmRunResult = {
    patients: patients.length,
    goldenRecords: survivorByGolden.size,
    mergedRecords: patients.length - survivorByGolden.size,
    autoMerged,
    pendingCandidates,
    duplicatesFound: pairs.length,
    durationMs: Date.now() - startedAt,
  };
  log('mdm.run.done', { ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

function toCandidateView(
  row: {
    id: string;
    goldenId: string;
    leftPatientId: string;
    rightPatientId: string;
    matchScore: number;
    matchReasons: unknown;
    survivorshipRule: string;
    status: string;
    createdAt: Date;
    reviewedAt: Date | null;
    reviewedById: string | null;
  },
  patients: Map<string, Pick<Patient, 'mrn' | 'firstName' | 'lastName' | 'dateOfBirth' | 'city'>>,
): MdmCandidateView {
  const summary = (id: string) => {
    const p = patients.get(id);
    return p
      ? { mrn: p.mrn, fullName: `${p.firstName} ${p.lastName}`, dateOfBirth: p.dateOfBirth, city: p.city }
      : null;
  };
  return {
    ...row,
    matchReasons: Array.isArray(row.matchReasons) ? (row.matchReasons as string[]) : [],
    status: row.status as MdmCandidateView['status'],
    leftPatient: summary(row.leftPatientId),
    rightPatient: summary(row.rightPatientId),
  };
}

export async function listMergeCandidates(
  opts: { client?: MdmDb; status?: 'PENDING' | 'MERGED' | 'REJECTED'; limit?: number } = {},
): Promise<MdmCandidateView[]> {
  const client = opts.client ?? prisma;
  const rows = await client.mdmMergeCandidate.findMany({
    where: opts.status ? { status: opts.status } : undefined,
    orderBy: [{ status: 'asc' }, { matchScore: 'desc' }, { createdAt: 'asc' }],
    take: opts.limit ?? 100,
  });
  const ids = new Set(rows.flatMap((r) => [r.leftPatientId, r.rightPatientId]));
  const patients = await client.patient.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, city: true },
  });
  const byId = new Map(patients.map((p) => [p.id, p]));
  return rows.map((r) => toCandidateView(r, byId as never));
}

export async function reviewMergeCandidate(
  candidateId: string,
  decision: 'MERGED' | 'REJECTED',
  reviewerId: string,
  opts: { client?: MdmDb; note?: string } = {},
): Promise<MdmCandidateView> {
  if (decision !== 'MERGED' && decision !== 'REJECTED') {
    throw new MdmError('INVALID_DECISION', `Unsupported decision: ${String(decision)}`);
  }
  const client = opts.client ?? prisma;
  const candidate = await client.mdmMergeCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw new MdmError('NOT_FOUND', `MDM candidate ${candidateId} not found`);
  if (candidate.status !== 'PENDING') {
    throw new MdmError('ALREADY_REVIEWED', `MDM candidate ${candidateId} was already ${candidate.status}`);
  }

  const updated = await client.mdmMergeCandidate.update({
    where: { id: candidateId },
    data: {
      status: decision,
      reviewedAt: new Date(),
      reviewedById: reviewerId,
      survivorshipRule:
        opts.note && opts.note.trim()
          ? `${candidate.survivorshipRule} | steward note: ${opts.note.trim()}`
          : candidate.survivorshipRule,
    },
  });

  if (decision === 'MERGED') {
    // Right patient joins the left patient's golden record.
    await client.mdmMaster.updateMany({
      where: { patientId: candidate.rightPatientId },
      data: { goldenId: candidate.goldenId, isGolden: false, matchScore: candidate.matchScore },
    });
    // Any other pending pair for the merged patient is resolved too.
    await client.mdmMergeCandidate.updateMany({
      where: {
        status: 'PENDING',
        OR: [
          { leftPatientId: candidate.rightPatientId },
          { rightPatientId: candidate.rightPatientId },
        ],
        id: { not: candidateId },
      },
      data: { status: 'MERGED', reviewedAt: new Date(), reviewedById: reviewerId },
    });
  }

  const patients = await client.patient.findMany({
    where: { id: { in: [candidate.leftPatientId, candidate.rightPatientId] } },
    select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, city: true },
  });
  return toCandidateView(updated, new Map(patients.map((p) => [p.id, p])) as never);
}

/** Golden id for a patient, or null before MDM has run. */
export async function getGoldenId(patientId: string, opts: { client?: MdmDb } = {}): Promise<string | null> {
  const client = opts.client ?? prisma;
  const master = await client.mdmMaster.findFirst({
    where: { patientId },
    orderBy: [{ isGolden: 'desc' }, { mergedAt: 'desc' }],
    select: { goldenId: true },
  });
  return master?.goldenId ?? null;
}
