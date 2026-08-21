import { normalizeCorsOrigins } from './cors.util';

describe('normalizeCorsOrigins', () => {
  it('should fallback to default localhost:4200 when input is undefined or empty', () => {
    expect(normalizeCorsOrigins()).toEqual(['http://localhost:4200']);
    expect(normalizeCorsOrigins('')).toEqual(['http://localhost:4200']);
    expect(normalizeCorsOrigins('   ')).toEqual(['http://localhost:4200']);
  });

  it('should trim whitespace and remove trailing slashes from single origin', () => {
    expect(normalizeCorsOrigins('http://localhost:4200/')).toEqual([
      'http://localhost:4200',
    ]);
    expect(normalizeCorsOrigins('  http://localhost:4200///  ')).toEqual([
      'http://localhost:4200',
    ]);
  });

  it('should parse multiple comma-separated origins and strip trailing slashes', () => {
    const input = 'http://localhost:4200/, https://nexuscord.app/, http://127.0.0.1:4200';
    expect(normalizeCorsOrigins(input)).toEqual([
      'http://localhost:4200',
      'https://nexuscord.app',
      'http://127.0.0.1:4200',
    ]);
  });

  it('should ignore wildcard * and keep valid origins', () => {
    expect(normalizeCorsOrigins('*, http://localhost:4200/')).toEqual([
      'http://localhost:4200',
    ]);
    expect(normalizeCorsOrigins('*')).toEqual(['http://localhost:4200']);
  });
});
