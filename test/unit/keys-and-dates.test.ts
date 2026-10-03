import { describe, expect, it } from 'vitest';
import { parseNaturalDate } from '../../src/client/format';
import { createKeymap, isTypingTarget, normalizeKey } from '../../src/client/ui/keys';

const TODAY = '2026-10-03';

describe('parseNaturalDate (always day first)', () => {
  it.each([
    ['today', '2026-10-03'],
    ['Yesterday', '2026-10-02'],
    ['3/10', '2026-10-03'],
    ['12/4', '2026-04-12'],
    ['5/4/26', '2026-04-05'],
    ['05-04-2026', '2026-04-05'],
    ['5.4.2026', '2026-04-05'],
    ['3 Oct', '2026-10-03'],
    ['3rd October 2026', '2026-10-03'],
    ['1 sept', '2026-09-01'],
    ['Oct 3', '2026-10-03'],
    ['Oct 3, 2025', '2025-10-03'],
    ['2026-02-28', '2026-02-28'],
    ['28/12', '2025-12-28'],
    ['20/10', '2026-10-20'],
  ])('%s → %s', (raw, expected) => expect(parseNaturalDate(raw, TODAY)).toBe(expected));

  it.each(['', 'soon', '31/2', '13/13', '0/1', '3 Foo', '2026-02-30', '1/2/3/4'])('rejects %s', (raw) => {
    expect(parseNaturalDate(raw, TODAY)).toBeNull();
  });

  it('crosses month and year boundaries for yesterday', () => {
    expect(parseNaturalDate('yesterday', '2026-01-01')).toBe('2025-12-31');
  });
});

describe('keyboard shortcuts', () => {
  const setup = () => {
    const km = createKeymap();
    const fired: string[] = [];
    km.add(
      { keys: 'n', description: 'New', group: 'g', run: () => fired.push('n') },
      { keys: 'g d', description: 'Dashboard', group: 'g', run: () => fired.push('g d') },
      { keys: 'mod+k', description: 'Palette', group: 'g', run: () => fired.push('mod+k') },
      { keys: '?', description: 'Help', group: 'g', run: () => fired.push('?') },
    );
    const press = (key: string, ctx = { typing: false, modalOpen: false }, mods: Partial<KeyboardEvent> = {}, now = 0) => {
      km.handle({ key, ...mods }, { ...ctx, now })?.run();
    };
    return { km, fired, press };
  };

  it('fires single keys, sequences and modifier combos', () => {
    const { fired, press } = setup();
    press('n');
    press('g', undefined, {}, 0);
    press('d', undefined, {}, 300);
    press('k', undefined, { ctrlKey: true });
    press('?', undefined, { shiftKey: true });
    expect(fired).toEqual(['n', 'g d', 'mod+k', '?']);
  });

  it('never fires while typing, not even Ctrl+K', () => {
    const { fired, press } = setup();
    const typing = { typing: true, modalOpen: false };
    press('n', typing);
    press('g', typing);
    press('d', typing);
    press('k', typing, { ctrlKey: true });
    expect(fired).toEqual([]);
  });

  it('never fires while a dialog is open', () => {
    const { fired, press } = setup();
    press('n', { typing: false, modalOpen: true });
    press('?', { typing: false, modalOpen: true });
    expect(fired).toEqual([]);
  });

  it('drops a sequence after a second, or when typing starts in between', () => {
    const { fired, press } = setup();
    press('g', undefined, {}, 0);
    press('d', undefined, {}, 1500);
    press('g', undefined, {}, 2000);
    press('x', { typing: true, modalOpen: false }, {}, 2100);
    press('d', undefined, {}, 2200);
    expect(fired).toEqual([]);
  });

  it('respects when() guards', () => {
    const km = createKeymap();
    let on = false;
    let hits = 0;
    km.add({ keys: 'x', description: 'Select', group: 'List', run: () => hits++, when: () => on });
    km.handle({ key: 'x' }, { typing: false, modalOpen: false })?.run();
    on = true;
    km.handle({ key: 'x' }, { typing: false, modalOpen: false })?.run();
    expect(hits).toBe(1);
  });

  it('knows which elements take typing', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'TR' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('normalises keys', () => {
    expect(normalizeKey({ key: 'K', ctrlKey: true })).toBe('mod+k');
    expect(normalizeKey({ key: 'k', metaKey: true })).toBe('mod+k');
    expect(normalizeKey({ key: '?', shiftKey: true })).toBe('?');
    expect(normalizeKey({ key: 'ArrowDown' })).toBe('arrowdown');
    expect(normalizeKey({ key: 'Enter', ctrlKey: true })).toBe('mod+enter');
  });
});

describe('type-ahead and palette matching', async () => {
  const { filterOptions } = await import('../../src/client/ui/typeahead');
  const { fuzzyScore } = await import('../../src/client/ui/palette');

  it('lists prefix matches before substring matches', () => {
    const opts = ['Groceries', 'Food & Dining', 'Fuel', 'Fast food'].map((label) => ({ value: label, label }));
    expect(filterOptions(opts, 'f').map((o) => o.label)).toEqual(['Food & Dining', 'Fuel', 'Fast food']);
    expect(filterOptions(opts, 'food').map((o) => o.label)).toEqual(['Food & Dining', 'Fast food']);
  });

  it('matches palette commands by subsequence', () => {
    expect(fuzzyScore('New transaction', 'new')).toBe(0);
    expect(fuzzyScore('New transaction', 'nwtrn')).not.toBeNull();
    expect(fuzzyScore('Budgets', 'zz')).toBeNull();
    expect(fuzzyScore('Go to Budgets', 'bud')!).toBeLessThan(fuzzyScore('Go to Budgets', 'gbs')!);
  });
});
