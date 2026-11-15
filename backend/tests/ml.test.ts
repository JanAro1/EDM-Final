import { describe, expect, it } from 'vitest';
import { evaluateDqGate, evaluatePatientRisk } from '../packages/ml/src/index.js';

const patient = (over: Record<string, unknown> = {}) => ({
  id: 'pat-1',
  mrn: 'MRN-1',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  fullNameNormalized: 'JUAN DELA CRUZ',
  dateOfBirth: new Date('1985-03-14T00:00:00Z'),
  sex: 'MALE',
  phone: null,
  email: null,
  address: null,
  city: null,
  sourceSystem: 'EMR',
  ...over,
});

interface FakeOptions {
  patient?: ReturnType<typeof patient> | null;
  duplicates?: number;
  labResults?: Array<Record<string, unknown>>;
  encounters?: Array<Record<string, unknown>>;
  claims?: Array<Record<string, unknown>>;
}

function fakeClient(opts: FakeOptions = {}) {
  const row = opts.patient === undefined ? patient() : opts.patient;
  return {
    patient: {
      findUnique: async () => row,
      count: async () => opts.duplicates ?? 0,
    },
    labResult: { findMany: async () => opts.labResults ?? [] },
    encounter: { findMany: async () => opts.encounters ?? [] },
    claim: { findMany: async () => opts.claims ?? [] },
    mdmMaster: { findFirst: async () => ({ goldenId: 'golden-1' }) },
  };
}

describe('evaluateDqGate', () => {
  it('passes a clean patient', async () => {
    const result = await evaluateDqGate('pat-1', { client: fakeClient() as never });
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.rulesEvaluated).toBe(6);
  });

  it('fails only the patient-scoped invariants that are violated', async () => {
    const result = await evaluateDqGate('pat-1', {
      client: fakeClient({
        duplicates: 1,
        labResults: [
          {
            collectedAt: new Date('2024-01-02T10:00:00Z'),
            resultedAt: new Date('2024-01-02T09:00:00Z'),
            valueNumeric: null,
            valueText: null,
            abnormalFlag: null,
          },
        ],
        claims: [{ billedAmount: -10, paidAmount: null }],
      }) as never,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code).sort()).toEqual(
      ['BILL-NEGATIVE', 'DUP-PATIENT', 'LAB-TAT-ORDER', 'LAB-VALUE'].sort(),
    );
  });

  it('flags paid > billed without flagging a healthy claim', async () => {
    const bad = await evaluateDqGate('pat-1', {
      client: fakeClient({ claims: [{ billedAmount: 100, paidAmount: 150 }] }) as never,
    });
    expect(bad.failures.map((f) => f.code)).toContain('BILL-PAID-GT-BILLED');

    const good = await evaluateDqGate('pat-1', {
      client: fakeClient({ claims: [{ billedAmount: 150, paidAmount: 100 }] }) as never,
    });
    expect(good.failures.map((f) => f.code)).not.toContain('BILL-PAID-GT-BILLED');
  });

  it('throws NOT_FOUND for an unknown patient', async () => {
    await expect(
      evaluateDqGate('missing', { client: fakeClient({ patient: null }) as never }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('evaluatePatientRisk', () => {
  const now = new Date('2024-06-15T00:00:00Z');

  it('scores a sparse young patient LOW and a heavy-utilisation patient HIGH', async () => {
    const low = await evaluatePatientRisk('pat-1', {
      client: fakeClient({ patient: patient({ dateOfBirth: new Date('1994-06-15T00:00:00Z') }) }) as never,
      now,
    });
    expect(low.riskBand).toBe('LOW');
    expect(low.goldenId).toBe('golden-1');
    expect(low.modelVersion).toContain('medidata-risk');

    const high = await evaluatePatientRisk('pat-1', {
      client: fakeClient({
        patient: patient({ dateOfBirth: new Date('1934-06-15T00:00:00Z') }),
        labResults: Array.from({ length: 4 }, () => ({ abnormalFlag: 'H', testCode: 'HBA1C' })),
        encounters: [
          ...Array.from({ length: 6 }, () => ({ type: 'INPATIENT', diagnosisCode: 'E11.9', admittedAt: new Date('2024-01-01T00:00:00Z'), dischargedAt: new Date('2024-01-15T00:00:00Z') })),
          ...Array.from({ length: 6 }, () => ({ type: 'EMERGENCY', diagnosisCode: 'I10', admittedAt: new Date('2024-02-01T00:00:00Z'), dischargedAt: null })),
        ],
        claims: Array.from({ length: 5 }, () => ({ status: 'DENIED' })),
      }) as never,
      now,
    });
    expect(high.riskBand).toBe('HIGH');
    expect(high.riskScore).toBeGreaterThan(low.riskScore);
    expect(high.topFactors.length).toBeGreaterThan(0);
    expect(high.topFactors.length).toBeLessThanOrEqual(3);
  });
});
