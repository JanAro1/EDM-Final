import { describe, expect, it } from 'vitest';
import {
  AUTO_MERGE_THRESHOLD,
  clusterGoldenId,
  normalizePhone,
  pickSurvivor,
  scorePatientPair,
  standaloneGoldenId,
} from '../packages/mdm/src/index.js';

const patient = (over: Record<string, unknown>) => ({
  id: 'p1',
  mrn: 'MRN-1',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  fullNameNormalized: 'JUAN DELA CRUZ',
  dateOfBirth: new Date('1985-03-14T00:00:00Z'),
  sex: 'MALE' as const,
  phone: '(632) 555-0100',
  email: null,
  address: '12 Rizal St',
  city: 'Manila',
  sourceSystem: 'EMR' as const,
  ...over,
});

describe('normalizePhone', () => {
  it('keeps the last 10 digits, ignoring punctuation and country code', () => {
    expect(normalizePhone('+63 (632) 555-0100')).toBe('6325550100');
    expect(normalizePhone(null)).toBe('');
  });
});

describe('scorePatientPair', () => {
  const left = patient({});

  it('scores an exact match at or above the auto-merge threshold', () => {
    const { score, reasons } = scorePatientPair(left, patient({ id: 'p2', mrn: 'MRN-2' }));
    expect(score).toBeGreaterThanOrEqual(AUTO_MERGE_THRESHOLD);
    expect(reasons).toContain('date_of_birth_exact');
    expect(reasons).toContain('phone_exact');
  });

  it('scores obviously different patients low', () => {
    const { score } = scorePatientPair(
      left,
      patient({
        id: 'p3',
        mrn: 'MRN-3',
        firstName: 'Maria',
        lastName: 'Santos',
        fullNameNormalized: 'MARIA SANTOS',
        dateOfBirth: new Date('1990-12-01T00:00:00Z'),
        phone: '(632) 555-9999',
        city: 'Cebu',
      }),
    );
    expect(score).toBeLessThan(0.5);
  });
});

describe('pickSurvivor', () => {
  it('prefers EMR over every other source', () => {
    const survivor = pickSurvivor([
      patient({ id: 'lis', mrn: 'MRN-2', sourceSystem: 'LIS' }),
      patient({ id: 'emr', mrn: 'MRN-9', sourceSystem: 'EMR' }),
      patient({ id: 'billing', mrn: 'MRN-1', sourceSystem: 'BILLING' }),
    ]);
    expect(survivor.id).toBe('emr');
  });

  it('breaks ties by completeness, then lowest MRN', () => {
    const complete = patient({ id: 'a', mrn: 'MRN-5', phone: '1', email: 'x@y.z', address: 'A', city: 'C' });
    const sparse = patient({ id: 'b', mrn: 'MRN-1', phone: null, email: null, address: null, city: null });
    expect(pickSurvivor([sparse, complete]).id).toBe('a');

    const first = patient({ id: 'c', mrn: 'MRN-2' });
    const second = patient({ id: 'd', mrn: 'MRN-1' });
    expect(pickSurvivor([first, second]).id).toBe('d');
  });
});

describe('golden ids', () => {
  it('is deterministic per patient', () => {
    expect(standaloneGoldenId('p1')).toBe(standaloneGoldenId('p1'));
    expect(standaloneGoldenId('p1')).not.toBe(standaloneGoldenId('p2'));
  });

  it('is independent of cluster input order', () => {
    expect(clusterGoldenId(['a', 'b', 'c'])).toBe(clusterGoldenId(['c', 'a', 'b']));
    expect(clusterGoldenId(['a', 'b'])).not.toBe(clusterGoldenId(['a', 'b', 'c']));
  });
});
