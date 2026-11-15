import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../packages/etl-core/src/elt.js';
import { dateKeyOf, fallbackGoldenId } from '../packages/etl-core/src/warehouse-loader.js';
import { looseName, parseLooseDate } from '../packages/etl-core/src/transforms/helpers.js';

describe('splitSqlStatements', () => {
  it('splits on semicolons, strips comments and keeps quoted semicolons', () => {
    const sql = [
      '-- a comment',
      'CREATE TABLE a (x int);',
      '',
      '-- another comment',
      "INSERT INTO a VALUES ('semi;colon');",
      'SELECT 1',
    ].join('\n');
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE TABLE a');
    expect(statements[1]).toContain("'semi;colon'");
    expect(statements[2]).toBe('SELECT 1');
  });
});

describe('dateKeyOf', () => {
  it('builds a YYYYMMDD integer key in UTC', () => {
    expect(dateKeyOf(new Date('2024-03-09T22:30:00Z'))).toBe(20240309);
    expect(dateKeyOf(new Date('2024-12-31T00:00:00Z'))).toBe(20241231);
  });
});

describe('fallbackGoldenId', () => {
  it('is deterministic for the same name + DOB', () => {
    expect(fallbackGoldenId('Juan Dela Cruz', '1985-03-14')).toBe(
      fallbackGoldenId('juan  dela cruz', '1985-03-14'),
    );
    expect(fallbackGoldenId('Juan Dela Cruz', '1985-03-14')).not.toBe(
      fallbackGoldenId('Maria Santos', '1985-03-14'),
    );
  });
});

describe('loose date parsing', () => {
  it('reads US and day-first slash dates', () => {
    expect(parseLooseDate('03/14/1985')).toEqual({ value: '1985-03-14', dateOnly: true });
    expect(parseLooseDate('14/03/1985')).toEqual({ value: '1985-03-14', dateOnly: true });
    expect(parseLooseDate('2024-01-05')).toEqual({ value: '2024-01-05', dateOnly: true });
  });

  it('returns null for blank/invalid input', () => {
    expect(parseLooseDate('')).toEqual({ value: null, dateOnly: true });
    expect(parseLooseDate('99/99/9999')).toEqual({ value: null, dateOnly: true });
  });
});

describe('looseName', () => {
  it('uppercases, strips punctuation and collapses whitespace', () => {
    expect(looseName('Juan  D. Cruz')).toBe('JUAN D CRUZ');
    expect(looseName(null)).toBe('');
  });
});
