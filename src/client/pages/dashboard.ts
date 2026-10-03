import { get } from '../api';
import { barList, monthlyBars } from '../charts';
import { $, errorMessage, h, replace } from '../dom';
import { fmtDate, inr, inrShort, qs, rangeFor, signedInr, today } from '../format';
import type { Budget, Summary, Transaction } from '../types';
import { linkButton } from '../ui/button';
import { emptyState, errorState } from '../ui/table';

const rangeSelect = $<HTMLSelectElement>('#range');

/** KPI value: compact (₹5.7L), with the exact amount on hover. */
function kpi(id: string, amount: number) {
  const el = $(`#kpi-${id}`);
  el.textContent = inrShort(amount);
  el.title = inr(amount);
}

async function loadSummary() {
  const [from, to] = rangeFor(rangeSelect.value);
  let s: Summary;
  try {
    s = await get<Summary>(`/summary${qs({ from, to })}`);
  } catch (err) {
    for (const id of ['monthly', 'by-category']) replace($(`#${id}`), errorState(errorMessage(err), () => void loadSummary()));
    return;
  }

  kpi('income', s.income);
  kpi('spend', s.spend);
  kpi('net', s.net);
  $('#kpi-net').className = `value ${s.net >= 0 ? 'income' : 'spend'}`;
  $('#kpi-count').textContent = s.count.toLocaleString('en-IN');
  // The uncategorized prompt lives inside the Transactions card, so it never pushes the page down.
  replace(
    $('#kpi-count-sub'),
    s.uncategorized
      ? h('a', { href: `/app/transactions/${qs({ category: 'none', type: 'debit', from, to })}` }, `${s.uncategorized} uncategorized spend${s.uncategorized === 1 ? '' : 's'}`)
      : '',
  );

  replace($('#monthly'), s.months.length ? monthlyBars(s.months) : emptyState('No transactions in this period yet.'));

  const href = (id: number | null) => `/app/transactions/${qs({ category: id ?? 'none', type: 'debit', from, to })}`;
  const top = s.by_category.slice(0, 8);
  replace(
    $('#by-category'),
    top.length
      ? barList(top.map((c) => ({ label: c.name, value: c.spend, note: inrShort(c.spend), href: href(c.category_id) })))
      : emptyState('No spending in this period.'),
  );
}

async function loadBudgets() {
  try {
    const { items } = await get<{ items: Budget[] }>(`/budgets${qs({ month: today().slice(0, 7) })}`);
    replace(
      $('#budgets'),
      items.length
        ? barList(items.map((b) => ({ label: b.name, value: b.spent, max: b.amount, note: `${inrShort(b.spent)} / ${inrShort(b.amount)}` })))
        : emptyState('No budgets yet.', linkButton('Set a budget', '/app/budgets/', { size: 'sm' })),
    );
  } catch (err) {
    replace($('#budgets'), errorState(errorMessage(err), () => void loadBudgets()));
  }
}

async function loadRecent() {
  try {
    const { items } = await get<{ items: Transaction[] }>('/transactions?limit=8');
    replace(
      $('#recent'),
      items.length
        ? h('ul', { class: 'plain-list recent-list' },
            ...items.map((t) =>
              h('li', null,
                h('div', { class: 'recent-main' },
                  h('span', { class: 'recent-desc' }, t.description),
                  h('span', { class: `num ${t.type === 'credit' ? 'income' : ''}` }, signedInr(t.amount, t.type)),
                ),
                h('div', { class: 'cell-sub' }, `${fmtDate(t.date)} · ${t.category_name ?? 'Uncategorized'}`),
              ),
            ),
          )
        : emptyState('Nothing here yet.', linkButton('Import a statement', '/app/import/', { variant: 'primary', size: 'sm' })),
    );
  } catch (err) {
    replace($('#recent'), errorState(errorMessage(err), () => void loadRecent()));
  }
}

rangeSelect.addEventListener('change', () => void loadSummary());
void loadSummary();
void loadBudgets();
void loadRecent();
