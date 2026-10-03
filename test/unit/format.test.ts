import { describe, expect, it } from 'vitest';
import { inrShort, parseMoney } from '../../src/client/format';

describe('parseMoney', () => {
  it.each([
    ['1,234.50', 1234.5],
    ['1234', 1234],
    ['₹ 5,70,000', 570000],
    ['0.01', 0.01],
    [' 99.9 ', 99.9],
  ])('reads %s', (raw, expected) => expect(parseMoney(raw)).toBe(expected));

  it.each(['', '0', '-5', '1.234', 'abc', '1,2a', '12.'])('rejects %s', (raw) => expect(parseMoney(raw)).toBeNaN());
});

describe('inrShort', () => {
  it('uses lakh and crore', () => {
    expect(inrShort(570000)).toBe('₹5.7L');
    expect(inrShort(12_345_678)).toBe('₹1.2Cr');
  });
});
