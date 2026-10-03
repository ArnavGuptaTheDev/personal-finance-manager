import { del, get, patch, post } from '../api';
import { $, categoryOptions, errorMessage, formValues, h, replace } from '../dom';
import { fmtDate, inr, moneyInput, parseMoney, qs, signedInr, today } from '../format';
import { loadCategories } from '../shell';
import type { Category, Transaction } from '../types';
import { button, linkButton } from '../ui/button';
import { confirmDialog } from '../ui/confirm';
import { bindForm, clearErrors, setValues } from '../ui/form';
import { openDialog } from '../ui/modal';
import { emptyState, renderTable, tableError, td } from '../ui/table';
import { toast, undoToast } from '../ui/toast';

type Page = { items: Transaction[]; total: number; totals: { debit: number; credit: number } };

const PAGE = 50;
const COLS = 6;
const filtersForm = $<HTMLFormElement>('#filters');
const rowsEl = $('#rows');
const selectAll = $<HTMLInputElement>('#select-all');
const dialog = $<HTMLDialogElement>('#txn-dialog');
const txnForm = $<HTMLFormElement>('#txn-form');

let categories: Category[] = [];
let items: Transaction[] = [];
let offset = 0;
let total = 0;
let editing: Transaction | null = null;
const selected = new Set<number>();

function currentFilters() {
  const v = formValues(filtersForm);
  return { q: v.q, category: v.category, type: v.type, from: v.from, to: v.to };
}

/** Filters from the URL (dashboard links here with ?category=…&from=…). */
function urlFilters() {
  const params = new URLSearchParams(location.search);
  return { q: params.get('q') ?? '', category: params.get('category') ?? '', type: params.get('type') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '' };
}

function renderSummary(page: Pick<Page, 'total' | 'totals'>) {
  total = page.total;
  const parts: (string | Node)[] = [`${total.toLocaleString('en-IN')} transaction${total === 1 ? '' : 's'}`];
  if (total) {
    parts.push(' · ', h('span', { class: 'num' }, `${inr(page.totals.debit)} out`), ' · ', h('span', { class: 'num income' }, `${inr(page.totals.credit)} in`));
  }
  replace($('#summary-line'), ...parts);
  $('#page-info').textContent = total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total.toLocaleString('en-IN')}` : '';
  $<HTMLButtonElement>('#prev').disabled = offset === 0;
  $<HTMLButtonElement>('#next').disabled = offset + PAGE >= total;
}

// Category selects can only render once categories are in; they load in parallel with the first page.
let categoriesPromise: Promise<void> | null = null;
let categoriesFailed = false;
function categoriesReady(): Promise<void> {
  categoriesPromise ??= loadCategories(categoriesFailed)
    .then((cats) => {
      categories = cats;
      replace($('#filter-category'), h('option', { value: '' }, 'All categories'), h('option', { value: 'none' }, 'Uncategorized'), ...cats.map((c) => h('option', { value: c.id }, c.name)));
      replace($('#bulk-category'), ...categoryOptions(cats, null));
    })
    .catch((err) => {
      categoriesPromise = null;
      categoriesFailed = true;
      throw err;
    });
  return categoriesPromise;
}

let loadSeq = 0;
async function load(f = currentFilters()) {
  const seq = ++loadSeq;
  history.replaceState(null, '', `${location.pathname}${qs(f)}`);
  try {
    const [page] = await Promise.all([get<Page>(`/transactions${qs({ ...f, limit: PAGE, offset })}`), categoriesReady()]);
    if (seq !== loadSeq) return;
    items = page.items;
    selected.clear();
    selectAll.checked = false;
    updateBulk();
    renderSummary(page);
    renderRows();
  } catch (err) {
    if (seq === loadSeq) tableError(rowsEl, COLS, errorMessage(err), () => void load());
  }
}

/** Re-reads only the count and totals after rows were patched in place. */
async function refreshSummary() {
  const page = await get<Page>(`/transactions${qs({ ...currentFilters(), limit: 1, offset: 0 })}`).catch(() => null);
  if (page) renderSummary(page);
}

function renderRows() {
  const hasFilters = Object.values(currentFilters()).some(Boolean);
  renderTable(rowsEl, items, row, {
    colspan: COLS,
    empty: hasFilters
      ? emptyState('No transactions match these filters.', button('Clear filters', { size: 'sm', onClick: () => filtersForm.reset() }))
      : emptyState('No transactions yet.', linkButton('Import a statement', '/app/import/', { variant: 'primary', size: 'sm' })),
  });
}

function sourceOf(t: Transaction) {
  return [t.bank?.toUpperCase(), t.account_type === 'credit_card' ? 'Card' : t.account_type === 'savings' ? 'Savings' : null, t.account_last4 && `••${t.account_last4}`]
    .filter(Boolean)
    .join(' ');
}

function row(t: Transaction): HTMLTableRowElement {
  const check = h('input', { type: 'checkbox', 'aria-label': `Select ${t.description}`, checked: selected.has(t.id) });
  check.addEventListener('change', () => {
    if (check.checked) selected.add(t.id);
    else selected.delete(t.id);
    updateBulk();
  });

  const cat = h('select', { 'aria-label': 'Category' }, ...categoryOptions(categories, t.category_id));
  cat.addEventListener('change', () => void setCategory(t, cat.value ? Number(cat.value) : null, cat));

  const sub = [t.remark, sourceOf(t)].filter(Boolean).join(' · ');
  const tr = h('tr', { 'data-id': t.id },
    td({ role: 'check' }, h('label', { class: 'check' }, check)),
    td({ role: 'meta', class: 'num' }, fmtDate(t.date)),
    td({ role: 'primary', class: 'desc' }, t.description, sub && h('span', { class: 'cell-sub' }, sub)),
    td({ label: 'Category' }, cat),
    td({ role: 'amount', class: `right num ${t.type === 'credit' ? 'income' : ''}` }, signedInr(t.amount, t.type)),
    td({ role: 'actions' },
      h('div', { class: 'row' },
        button('Edit', { variant: 'ghost', size: 'sm', onClick: () => openEditor(t) }),
        button('Delete', { variant: 'ghost-danger', size: 'sm', onClick: () => void remove(t) }),
      ),
    ),
  );
  return tr;
}

function rowEl(id: number) {
  return rowsEl.querySelector<HTMLTableRowElement>(`tr[data-id="${id}"]`);
}

function replaceItem(t: Transaction) {
  const i = items.findIndex((x) => x.id === t.id);
  if (i >= 0) items[i] = t;
  rowEl(t.id)?.replaceWith(row(t));
}

/** Optimistic: the select already shows the new value; roll back if the server refuses. */
async function setCategory(t: Transaction, categoryId: number | null, select?: HTMLSelectElement) {
  const previous = t.category_id;
  try {
    const updated = await patch<Transaction>(`/transactions/${t.id}`, { category_id: categoryId });
    replaceItem(updated);
    toast(`Moved to ${updated.category_name ?? 'Uncategorized'}`, {
      action: { label: 'Undo', run: async () => replaceItem(await patch<Transaction>(`/transactions/${t.id}`, { category_id: previous })) },
    });
  } catch (err) {
    if (select) select.value = previous ? String(previous) : '';
    toast(errorMessage(err), 'error');
  }
}

async function remove(t: Transaction) {
  const index = items.findIndex((x) => x.id === t.id);
  const tr = rowEl(t.id);
  tr?.classList.add('is-removing');
  try {
    await del(`/transactions/${t.id}`);
  } catch (err) {
    tr?.classList.remove('is-removing');
    toast(errorMessage(err), 'error');
    return;
  }
  items = items.filter((x) => x.id !== t.id);
  selected.delete(t.id);
  updateBulk();
  tr?.remove();
  if (!items.length) renderRows();
  void refreshSummary();
  undoToast('Transaction deleted', async () => {
    const restored = await post<Transaction>(`/transactions/${t.id}/restore`, {});
    items.splice(Math.min(index, items.length), 0, restored);
    renderRows();
    void refreshSummary();
  });
}

function updateBulk() {
  $('#bulk-box').hidden = selected.size === 0;
  $('#summary-line').hidden = selected.size > 0;
  $('#bulk-count').textContent = `${selected.size} selected`;
}

function openEditor(t: Transaction | null) {
  editing = t;
  txnForm.reset();
  clearErrors(txnForm);
  $('#txn-dialog-title').textContent = t ? 'Edit transaction' : 'Add transaction';
  replace($('#txn-category'), ...categoryOptions(categories, t?.category_id ?? null));
  setValues(txnForm, {
    date: t?.date ?? today(),
    amount: t ? moneyInput(t.amount) : '',
    type: t?.type ?? 'debit',
    description: t?.description ?? '',
    remark: t?.remark ?? '',
  });
  openDialog(dialog);
}

bindForm(txnForm, async (v) => {
  const body = {
    date: v.date,
    amount: parseMoney(v.amount ?? ''),
    type: v.type,
    description: v.description,
    category_id: v.category_id ? Number(v.category_id) : null,
    remark: v.remark || null,
  };
  if (editing) {
    replaceItem(await patch<Transaction>(`/transactions/${editing.id}`, body));
    dialog.close();
    toast('Transaction updated');
    void refreshSummary();
  } else {
    await post('/transactions', { ...body, account_type: 'cash' });
    dialog.close();
    toast('Transaction added');
    await load();
  }
});

$('#add-btn').addEventListener('click', () => openEditor(null));
$('#filters-toggle').addEventListener('click', (e) => {
  const open = $('#filters').classList.toggle('is-open');
  (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(open));
});

selectAll.addEventListener('change', () => {
  for (const t of items) {
    if (selectAll.checked) selected.add(t.id);
    else selected.delete(t.id);
  }
  rowsEl.querySelectorAll<HTMLInputElement>('td[data-cell=check] input').forEach((cb) => (cb.checked = selectAll.checked));
  updateBulk();
});

$('#bulk-apply').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  const value = $<HTMLSelectElement>('#bulk-category').value;
  const categoryId = value ? Number(value) : null;
  const ids = [...selected];
  const before = new Map(items.filter((t) => selected.has(t.id)).map((t) => [t.id, t.category_id]));
  btn.disabled = true;
  try {
    const res = await post<{ updated: number }>('/transactions/recategorize', { ids, category_id: categoryId });
    const name = categories.find((c) => c.id === categoryId)?.name ?? null;
    for (const t of items) if (before.has(t.id)) replaceItem({ ...t, category_id: categoryId, category_name: name });
    selected.clear();
    selectAll.checked = false;
    updateBulk();
    undoToast(`Updated ${res.updated} transaction${res.updated === 1 ? '' : 's'}`, async () => {
      // Put each row back in the category it had, one request per original category.
      const groups = new Map<number | null, number[]>();
      for (const [id, cat] of before) groups.set(cat, [...(groups.get(cat) ?? []), id]);
      for (const [cat, group] of groups) await post('/transactions/recategorize', { ids: group, category_id: cat });
      await load();
    });
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#bulk-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  const ids = [...selected];
  const ok = await confirmDialog({
    title: `Delete ${ids.length} transaction${ids.length === 1 ? '' : 's'}?`,
    message: 'You can undo this for a few seconds afterwards.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    const res = await post<{ deleted: number }>('/transactions/delete', { ids });
    await load();
    undoToast(`Deleted ${res.deleted} transaction${res.deleted === 1 ? '' : 's'}`, async () => {
      await post('/transactions/restore', { ids });
      await load();
    });
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    btn.disabled = false;
  }
});

let debounce: number | undefined;
function refilter(delay = 0) {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => {
    offset = 0;
    void load();
  }, delay);
}
filtersForm.addEventListener('submit', (e) => {
  e.preventDefault();
  refilter();
});
filtersForm.addEventListener('input', (e) => refilter((e.target as HTMLInputElement).type === 'search' ? 300 : 0));
filtersForm.addEventListener('reset', () => setTimeout(() => refilter()));
$('#prev').addEventListener('click', () => {
  offset = Math.max(0, offset - PAGE);
  void load();
});
$('#next').addEventListener('click', () => {
  offset += PAGE;
  void load();
});

const initial = urlFilters();
if (Object.values(initial).some(Boolean)) $('#filters').classList.add('is-open');
setValues(filtersForm, initial);
void categoriesReady().then(() => setValues(filtersForm, { category: initial.category }), () => undefined);
void load(initial);
