import { get } from '../api';
import { barList, monthlyBars } from '../charts';
import { $, emptyState, errorMessage, h, replace, toast } from '../dom';
import { fmtDate, inr, qs, rangeFor } from '../format';
import type { Budget, Summary, Transaction } from '../types';

const rangeSelect = $<HTMLSelectElement>('#range');

async function loadSummary() {
  const [from, to] = rangeFor(rangeSelect.value);
  const s = await get<Summary>(`/summary${qs({ from, to })}`);

  $('#kpi-income').textContent = inr(s.income);
  $('#kpi-spend').textContent = inr(s.spend);
  const net = $('#kpi-net');
  net.textContent = inr(s.net);
  net.className = `value ${s.net >= 0 ? 'income' : 'spend'}`;
  $('#kpi-count').textContent = s.count.toLocaleString('en-IN');

  const note = $('#uncat-note');
  note.hidden = s.uncategorized === 0;
  replace(
    note,
    `${s.uncategorized} transaction${s.uncategorized === 1 ? ' is' : 's are'} uncategorized. `,
    h('a', { href: '/app/transactions/?category=none' }, 'Review them'),
    ' to make these numbers more useful.',
  );

  replace($('#monthly'), s.months.length ? monthlyBars(s.months) : emptyState('No transactions in this period yet.'));

  const href = (id: number | null) => `/app/transactions/${qs({ category: id ?? 'none', from, to })}`;
  const top = s.by_category.slice(0, 8);
  replace(
    $('#by-category'),
    top.length
      ? barList(top.map((c) => ({ label: c.name, value: c.spend, href: href(c.category_id) })))
      : emptyState('No spending in this period.'),
  );
}

async function loadBudgets() {
  const { items } = await get<{ items: Budget[] }>('/budgets');
  replace(
    $('#budgets'),
    items.length
      ? barList(items.map((b) => ({ label: b.name, value: b.spent, max: b.amount, note: `${inr(b.spent)} / ${inr(b.amount)}` })))
      : emptyState('No budgets yet.'),
  );
}

async function loadRecent() {
  const { items } = await get<{ items: Transaction[] }>('/transactions?limit=8');
  replace(
    $('#recent'),
    items.length
      ? h('div', { class: 'table-wrap' },
          h('table', null,
            h('tbody', null,
              ...items.map((t) =>
                h('tr', null,
                  h('td', { class: 'muted small num' }, fmtDate(t.date)),
                  h('td', { class: 'desc' }, t.description, h('div', { class: 'muted small' }, t.category_name ?? 'Uncategorized')),
                  h('td', { class: `right num ${t.type === 'credit' ? 'income' : ''}` }, `${t.type === 'credit' ? '+' : '−'}${inr(t.amount)}`),
                ),
              ),
            ),
          ),
        )
      : h('div', { class: 'empty' }, 'Nothing here yet. ', h('a', { href: '/app/import/' }, 'Import a statement'), ' to get started.'),
  );
}

function guard(p: Promise<void>) {
  p.catch((err) => toast(errorMessage(err), 'error'));
}

rangeSelect.addEventListener('change', () => guard(loadSummary()));
guard(loadSummary());
guard(loadBudgets());
guard(loadRecent());
