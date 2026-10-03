import { describe, expect, it } from 'vitest';
import { parseAmount, parseDate, parseStatement } from '../../src/client/parsers/statement';
import { d, hdfcCard, hdfcSavings, iciciCardCsv, iciciSavingsCsv } from './statement-builders';

const brief = (rows: { date: string; type: string; amount: number; description: string; note?: string }[]) =>
  rows.map((r) => `${r.date} ${r.type} ${r.amount} ${r.description}${r.note ? ' [flagged]' : ''}`);

describe('parseDate', () => {
  it.each([
    ['05/04/26', '2026-04-05'],
    ['05-04-2026', '2026-04-05'],
    ['5 Apr 2026', '2026-04-05'],
    ['05-Apr-26', '2026-04-05'],
    ['2026-04-05', '2026-04-05'],
    ['05/04/2026 10:31', '2026-04-05'],
  ])('%s → %s (day first)', (raw, iso) => expect(parseDate(raw)).toBe(iso));

  it.each(['31/02/2026', '13/13/26', '', 'Opening Balance', '********'])('rejects %s', (raw) => expect(parseDate(raw)).toBeNull());
});

describe('parseAmount', () => {
  it.each([
    ['1,23,456.78', 123456.78],
    ['₹ 500.00 Cr', 500],
    ['-150.00', -150],
    ['(150.00)', -150],
    ['-', 0],
    ['', 0],
    ['abc', 0],
  ])('%s → %s', (raw, n) => expect(parseAmount(raw)).toBe(n));
});

describe('HDFC savings', () => {
  it('B1: a wrapped narration row is joined, and later rows are still imported', async () => {
    const r = await parseStatement(
      hdfcSavings([
        ['01/04/26', 'UPI-SWIGGY-SWIGGY8@YBL-LONG NARRATION', '0001', '01/04/26', '450.00', '', '9,550.00'],
        ['', 'CONTINUED-412398712', '', '', '', '', ''],
        ['02/04/26', 'NEFT CR-ACME SALARY', '0002', '02/04/26', '', '5,000.00', '14,550.00'],
        ['20/04/26', 'POS BLINKIT', '0003', '20/04/26', '1,050.00', '', '13,500.00'],
      ]),
      'hdfc',
      'savings',
    );
    expect(brief(r.rows)).toEqual([
      '2026-04-01 debit 450 UPI-SWIGGY-SWIGGY8@YBL-LONG NARRATION CONTINUED-412398712',
      '2026-04-02 credit 5000 NEFT CR-ACME SALARY',
      '2026-04-20 debit 1050 POS BLINKIT',
    ]);
    expect(r.joined).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(r.last4).toBe('1234');
  });

  it('B2: real Excel date cells keep their true date whatever the display format', async () => {
    for (const fmt of ['m/d/yy', 'dd/mm/yyyy', 'd-mmm-yy']) {
      const r = await parseStatement(
        hdfcSavings(
          [
            [d(2026, 4, 5), 'UPI-A', '1', d(2026, 4, 5), 100, '', 900],
            [d(2026, 4, 20), 'UPI-B', '2', d(2026, 4, 20), 50, '', 850],
          ],
          { dateFormat: fmt, book: 'xlsx' },
        ),
        'hdfc',
        'savings',
      );
      expect(r.rows.map((x) => x.date), fmt).toEqual(['2026-04-05', '2026-04-20']);
    }
  });

  it('B3: a negative withdrawal is imported as a flagged credit', async () => {
    const r = await parseStatement(hdfcSavings([['05/04/26', 'REVERSAL UPI-123', '1', '', '-150.00', '', '900']]), 'hdfc', 'savings');
    expect(brief(r.rows)).toEqual(['2026-04-05 credit 150 REVERSAL UPI-123 [flagged]']);
  });

  it('B4: a row with both a withdrawal and a deposit keeps both, flagged', async () => {
    const r = await parseStatement(hdfcSavings([['05/04/26', 'ODD ROW', '1', '', '10.00', '20.00', '1']]), 'hdfc', 'savings');
    expect(brief(r.rows)).toEqual(['2026-04-05 debit 10 ODD ROW [flagged]', '2026-04-05 credit 20 ODD ROW [flagged]']);
  });

  it('reports rows it cannot read instead of dropping them silently', async () => {
    const r = await parseStatement(
      hdfcSavings([
        ['01/04/26', 'UPI-A', '1', '', '10.00', '', '1'],
        ['??/04/26', 'UPI-GARBLED', '2', '', '20.00', '', '1'],
        ['03/04/26', 'UPI-C', '3', '', '30.00', '', '1'],
      ]),
      'hdfc',
      'savings',
    );
    expect(r.rows.map((x) => x.description)).toEqual(['UPI-A', 'UPI-C']);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'Has an amount but no readable date' })]);
  });

  it('numeric amount cells are read as numbers', async () => {
    const r = await parseStatement(hdfcSavings([['05/04/26', 'UPI-N', '1', '', 1234.5, 0, 900]]), 'hdfc', 'savings');
    expect(brief(r.rows)).toEqual(['2026-04-05 debit 1234.5 UPI-N']);
  });
});

describe('HDFC credit card', () => {
  it('reads debits, Cr refunds and wrapped descriptions', async () => {
    const r = await parseStatement(
      hdfcCard([
        ['Domestic', 'TEST USER', '02/04/2026', 'AMAZON PAY INDIA', '1,299.00', ''],
        ['Domestic', 'TEST USER', '03/04/2026', 'REFUND AMAZON', '299.00', 'Cr'],
        ['', '', '', 'BANGALORE IN', '', ''],
        ['Domestic', 'TEST USER', '04/04/2026', 'PAYMENT RECEIVED', '5,000.00 Cr', ''],
      ]),
      'hdfc',
      'credit_card',
    );
    expect(brief(r.rows)).toEqual([
      '2026-04-02 debit 1299 AMAZON PAY INDIA',
      '2026-04-03 credit 299 REFUND AMAZON BANGALORE IN',
      '2026-04-04 credit 5000 PAYMENT RECEIVED',
    ]);
    expect(r.last4).toBe('9876');
  });
});

describe('ICICI savings CSV', () => {
  it('skips the B/F row, reads both directions, stops at the legend', async () => {
    const r = await parseStatement(
      iciciSavingsCsv([
        '1,01/04/2026,,B/F,,,"10,000.00"',
        '2,03/04/2026,UPI,UPI/ZOMATO/123,,"250.00","9,750.00"',
        '3,15/04/2026,NEFT,NEFT-SALARY ACME,"50,000.00",,"59,750.00"',
      ]),
      'icici',
      'savings',
    );
    expect(brief(r.rows)).toEqual(['2026-04-03 debit 250 UPI/ZOMATO/123', '2026-04-15 credit 50000 NEFT-SALARY ACME']);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'Balance brought forward' })]);
    expect(r.last4).toBe('5678');
  });
});

describe('ICICI credit card CSV', () => {
  it('reads CR as a credit and appends the serial number', async () => {
    const r = await parseStatement(
      iciciCardCsv([
        '05/04/2026,11111,UBER INDIA,2,0,350.00,',
        '07/04/2026,11112,PAYMENT RECEIVED THANK YOU,0,0,"5,000.00",CR',
      ]),
      'icici',
      'credit_card',
    );
    expect(brief(r.rows)).toEqual([
      '2026-04-05 debit 350 UBER INDIA (Sr:11111)',
      '2026-04-07 credit 5000 PAYMENT RECEIVED THANK YOU (Sr:11112)',
    ]);
    expect(r.last4).toBe('2468');
  });
});

describe('errors', () => {
  it('explains when the transaction table is not found', async () => {
    await expect(parseStatement(iciciCardCsv([]), 'hdfc', 'savings')).rejects.toThrow(/Couldn't find the transaction table/);
  });
  it('rejects unsupported file types', async () => {
    await expect(parseStatement(new File(['x'], 'a.pdf'), 'hdfc', 'savings')).rejects.toThrow(/\.csv, \.xls or \.xlsx/);
  });
});
