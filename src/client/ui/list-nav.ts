// Keyboard model for row lists: j/k or ↓/↑ move a roving focus between rows, and
// single-key actions (x, e, c, Delete…) apply to the focused row. The focused row is
// announced through a polite live region.
import { h } from '../dom';
import { keymap } from './keys';

type RowAction = { keys: string; description: string; run: (row: HTMLTableRowElement) => void; hidden?: boolean };

function liveRegion(): HTMLElement {
  let el = document.getElementById('sr-status');
  if (!el) {
    el = h('div', { id: 'sr-status', class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  return el;
}

export function listNav(
  body: HTMLElement,
  opts: { group: string; rowSelector?: string; describe: (row: HTMLTableRowElement) => string; actions: RowAction[]; when?: () => boolean },
) {
  const selector = opts.rowSelector ?? 'tr[data-id]';
  const rows = () => [...body.querySelectorAll<HTMLTableRowElement>(selector)];
  const enabled = () => !opts.when || opts.when();
  let current = 0;

  // Rows are re-rendered often: keep exactly one of them in the tab order.
  const sync = () => {
    const all = rows();
    if (!all.length) return;
    current = Math.min(current, all.length - 1);
    all.forEach((r, i) => (r.tabIndex = i === current ? 0 : -1));
  };
  new MutationObserver(sync).observe(body, { childList: true });

  const focus = (i: number) => {
    const all = rows();
    if (!all.length) return;
    current = Math.max(0, Math.min(i, all.length - 1));
    all.forEach((r, j) => (r.tabIndex = j === current ? 0 : -1));
    const row = all[current]!;
    row.focus();
    liveRegion().textContent = `Row ${current + 1} of ${all.length}: ${opts.describe(row)}`;
  };

  body.addEventListener('focusin', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLTableRowElement>(selector);
    const i = row ? rows().indexOf(row) : -1;
    if (i >= 0) current = i;
  });

  const focusedRow = () => {
    const row = (document.activeElement as HTMLElement | null)?.closest<HTMLTableRowElement>(selector);
    return row && body.contains(row) ? row : null;
  };
  const step = (delta: number) => () => {
    if (!focusedRow()) focus(current);
    else focus(current + delta);
  };

  keymap.add(
    { keys: 'j', description: 'Next row (or ↓)', group: opts.group, run: step(1), when: enabled },
    // Arrows only take over once a row has focus, so they still scroll the page otherwise.
    { keys: 'arrowdown', description: 'Next row', group: opts.group, run: step(1), when: () => enabled() && focusedRow() !== null, hidden: true },
    { keys: 'k', description: 'Previous row (or ↑)', group: opts.group, run: step(-1), when: enabled },
    { keys: 'arrowup', description: 'Previous row', group: opts.group, run: step(-1), when: () => enabled() && focusedRow() !== null, hidden: true },
    ...opts.actions.map((a) => ({
      keys: a.keys,
      description: a.description,
      group: opts.group,
      hidden: a.hidden,
      when: () => enabled() && focusedRow() !== null,
      run: () => {
        const row = focusedRow();
        if (row) a.run(row);
      },
    })),
  );

  return { focus, refocus: () => focus(current) };
}
