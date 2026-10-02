import { del, get, patch, post } from '../api';
import { $, categoryOptions, emptyState, errorMessage, formValues, h, replace, run, toast } from '../dom';
import { fmtDate, inr, qs, today } from '../format';
import { loadCategories } from '../shell';
import type { Category, Transaction } from '../types';

const PAGE = 50;
const filtersForm = $<HTMLFormElement>('#filters');
const rowsEl = $('#rows');
const selectAll = $<HTMLInputElement>('#select-all');
const dialog = $<HTMLDialogElement>('#txn-dialog');
const txnForm = $<HTMLFormElement>('#txn-form');

let categories: Category[] = [];
let offset = 0;
let total = 0;
let editing: Transaction | null = null;
const selected = new Set<number>();

function currentFilters() {
  const v = formValues(filtersForm);
  return { q: v.q, category: v.category, type: v.type, from: v.from, to: v.to };
}

/** Pre-fill filters from the URL (dashboard links here with ?category=…&from=…). */
function filtersFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const name of ['q', 'category', 'type', 'from', 'to']) {
    const value = params.get(name);
    const field = filtersForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    if (value && field) field.value = value;
  }
}

async function load() {
  const f = currentFilters();
  history.replaceState(null, '', `${location.pathname}${qs(f)}`);
  const data = await get<{ items: Transaction[]; total: number }>(`/transactions${qs({ ...f, limit: PAGE, offset })}`);
  total = data.total;
  selected.clear();
  selectAll.checked = false;
  updateBulk();

  $('#count').textContent = `${total.toLocaleString('en-IN')} transaction${total === 1 ? '' : 's'}`;
  $('#page-info').textContent = total ? `${offset + 1}–${Math.min(offset + PAGE, total)}` : '';
  $<HTMLButtonElement>('#prev').disabled = offset === 0;
  $<HTMLButtonElement>('#next').disabled = offset + PAGE >= total;

  if (!data.items.length) {
    replace(rowsEl, h('tr', null, h('td', { colspan: 6 }, emptyState('No transactions match these filters.'))));
    return;
  }
  replace(rowsEl, ...data.items.map(row));
}

function row(t: Transaction): HTMLTableRowElement {
  const check = h('input', { type: 'checkbox', 'aria-label': 'Select transaction' });
  check.addEventListener('change', () => {
    if (check.checked) selected.add(t.id);
    else selected.delete(t.id);
    updateBulk();
  });

  const cat = h('select', { 'aria-label': 'Category' }, ...categoryOptions(categories, t.category_id));
  cat.addEventListener('change', async () => {
    try {
      await patch(`/transactions/${t.id}`, { category_id: cat.value ? Number(cat.value) : null });
      toast('Category updated');
    } catch (err) {
      toast(errorMessage(err), 'error');
      cat.value = t.category_id ? String(t.category_id) : '';
    }
  });

  const edit = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Edit');
  edit.addEventListener('click', () => openDialog(t));
  const remove = h('button', { class: 'btn btn-ghost btn-sm btn-danger', type: 'button' }, 'Delete');
  remove.addEventListener('click', () =>
    run(remove, async () => {
      if (!confirm(`Delete "${t.description}"?`)) return;
      await del(`/transactions/${t.id}`);
      toast('Transaction deleted');
      await load();
    }),
  );

  const source = [t.bank?.toUpperCase(), t.account_type === 'credit_card' ? 'Card' : t.account_type === 'savings' ? 'Savings' : null, t.account_last4 && `••${t.account_last4}`]
    .filter(Boolean)
    .join(' ');

  return h('tr', null,
    h('td', null, check),
    h('td', { class: 'num small' }, fmtDate(t.date)),
    h('td', { class: 'desc' }, t.description,
      (t.remark || source) && h('div', { class: 'muted small' }, [t.remark, source].filter(Boolean).join(' · '))),
    h('td', null, cat),
    h('td', { class: `right num ${t.type === 'credit' ? 'income' : ''}` }, `${t.type === 'credit' ? '+' : '−'}${inr(t.amount)}`),
    h('td', { class: 'right' }, h('div', { class: 'row' }, edit, remove)),
  );
}

function updateBulk() {
  $('#bulk-box').hidden = selected.size === 0;
  $('#bulk-count').textContent = `${selected.size} selected`;
}

function openDialog(t: Transaction | null) {
  editing = t;
  txnForm.reset();
  $('#txn-dialog-title').textContent = t ? 'Edit transaction' : 'Add transaction';
  replace($('#txn-category'), ...categoryOptions(categories, t?.category_id ?? null));
  const set = (name: string, value: string) => ((txnForm.elements.namedItem(name) as HTMLInputElement).value = value);
  set('date', t?.date ?? today());
  set('amount', t ? String(t.amount) : '');
  set('type', t?.type ?? 'debit');
  set('description', t?.description ?? '');
  set('remark', t?.remark ?? '');
  dialog.showModal();
}

txnForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(txnForm);
  const body = {
    date: v.date,
    amount: Number(v.amount),
    type: v.type,
    description: v.description,
    category_id: v.category_id ? Number(v.category_id) : null,
    remark: v.remark || null,
  };
  run($<HTMLButtonElement>('#txn-save'), async () => {
    if (editing) await patch(`/transactions/${editing.id}`, body);
    else await post('/transactions', { ...body, account_type: 'cash' });
    dialog.close();
    toast(editing ? 'Transaction updated' : 'Transaction added');
    await load();
  });
});

$('#txn-cancel').addEventListener('click', () => dialog.close());
$('#add-btn').addEventListener('click', () => openDialog(null));

selectAll.addEventListener('change', () => {
  rowsEl.querySelectorAll<HTMLInputElement>('td:first-child input[type=checkbox]').forEach((cb) => {
    if (cb.checked !== selectAll.checked) cb.click();
  });
});

$('#bulk-apply').addEventListener('click', (e) =>
  run(e.currentTarget as HTMLButtonElement, async () => {
    const value = $<HTMLSelectElement>('#bulk-category').value;
    const res = await post<{ updated: number }>('/transactions/recategorize', {
      ids: [...selected],
      category_id: value ? Number(value) : null,
    });
    toast(`Updated ${res.updated} transaction${res.updated === 1 ? '' : 's'}`);
    await load();
  }),
);

filtersForm.addEventListener('submit', (e) => {
  e.preventDefault();
  offset = 0;
  load().catch((err) => toast(errorMessage(err), 'error'));
});
filtersForm.addEventListener('reset', () =>
  setTimeout(() => {
    offset = 0;
    load().catch((err) => toast(errorMessage(err), 'error'));
  }),
);
$('#prev').addEventListener('click', () => {
  offset = Math.max(0, offset - PAGE);
  load().catch((err) => toast(errorMessage(err), 'error'));
});
$('#next').addEventListener('click', () => {
  offset += PAGE;
  load().catch((err) => toast(errorMessage(err), 'error'));
});

(async () => {
  try {
    categories = await loadCategories();
    const filterCat = $<HTMLSelectElement>('#filter-category');
    filterCat.append(h('option', { value: 'none' }, 'Uncategorized'), ...categories.map((c) => h('option', { value: c.id }, c.name)));
    replace($('#bulk-category'), ...categoryOptions(categories, null));
    filtersFromUrl();
    await load();
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
})();
