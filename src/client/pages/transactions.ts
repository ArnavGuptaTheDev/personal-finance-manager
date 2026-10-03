import { del, get, patch, post } from '../api';
import { $, categoryOptions, errorMessage, formValues, h, replace } from '../dom';
import { fmtDate, inr, moneyInput, parseMoney, parseNaturalDate, qs, signedInr } from '../format';
import { loadCategories, pageHooks } from '../shell';
import type { Category, Transaction, TransferCandidate } from '../types';
import { button, linkButton } from '../ui/button';
import { confirmDialog } from '../ui/confirm';
import { categoryField, pickCategory, rememberCategory } from '../ui/category-picker';
import { bindForm, clearErrors, naturalDateField, setValues } from '../ui/form';
import { listNav } from '../ui/list-nav';
import { createDialog, openDialog } from '../ui/modal';
import { emptyState, renderList, renderTable, tableError, td } from '../ui/table';
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
let addAnother = false;
const selected = new Set<number>();
const setTxnCategory = categoryField($('#txn-category-field'), () => categories);
const refreshDateHint = naturalDateField(txnForm.elements.namedItem('date') as HTMLInputElement);

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
    void backfillMerchants();
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

  // The merchant name leads; the raw bank description stays visible (and searchable) under it.
  const sub = [t.merchant ? t.description : null, t.remark, sourceOf(t)].filter(Boolean).join(' · ');
  const tr = h('tr', { 'data-id': t.id, 'aria-label': describe(t) },
    td({ role: 'check' }, h('label', { class: 'check' }, check)),
    td({ role: 'meta', class: 'num' }, fmtDate(t.date)),
    td({ role: 'primary', class: 'desc' },
      t.merchant || t.description,
      t.transfer_pair_id && h('span', { class: 'badge badge-brand pair-badge', title: 'Transfer between your own accounts: left out of income and spending' }, 'Transfer'),
      sub && h('span', { class: 'cell-sub' }, sub),
    ),
    td({ label: 'Category' }, cat),
    td({ role: 'amount', class: `right num ${t.type === 'credit' ? 'income' : ''}` }, signedInr(t.amount, t.type)),
    td({ role: 'actions' },
      h('div', { class: 'row' },
        t.transfer_pair_id ? button('Unpair', { variant: 'ghost', size: 'sm', onClick: () => void unpair(t.transfer_pair_id!) }) : null,
        button('Edit', { variant: 'ghost', size: 'sm', onClick: () => openEditor(t) }),
        button('Delete', { variant: 'ghost-danger', size: 'sm', onClick: () => void remove(t) }),
      ),
    ),
  );
  return tr;
}

function describe(t: Transaction) {
  return `${t.merchant || t.description}, ${signedInr(t.amount, t.type)}, ${fmtDate(t.date)}, ${t.category_name ?? 'Uncategorized'}`;
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
    rememberCategory(categoryId);
    const hadFocus = rowEl(t.id)?.contains(document.activeElement);
    replaceItem(updated);
    if (hadFocus) rowEl(t.id)?.focus();
    toast(`Moved to ${updated.category_name ?? 'Uncategorized'}`, {
      action: { label: 'Undo', run: async () => replaceItem(await patch<Transaction>(`/transactions/${t.id}`, { category_id: previous })) },
    });
    if (updated.merchant && categoryId !== null) void offerRule(updated.merchant, categoryId);
  } catch (err) {
    if (select) select.value = previous ? String(previous) : '';
    toast(errorMessage(err), 'error');
  }
}

/** After a correction: "Always put Swiggy in Food? 12 other transactions will change." */
async function offerRule(merchant: string, categoryId: number) {
  const category = categories.find((c) => c.id === categoryId);
  if (!category || merchant.length < 2) return;
  const preview = await get<{ matches: number; changes: number }>(`/transactions/rule-preview${qs({ merchant, category_id: categoryId })}`).catch(() => null);
  if (!preview?.changes) return;
  toast(`Always put ${merchant} in ${category.name}? ${preview.changes} other transaction${preview.changes === 1 ? '' : 's'} will change.`, {
    action: {
      label: 'Always',
      run: async () => {
        const keyword = merchant.toLowerCase();
        // The rule also sorts future imports; skip it if this category already has it.
        if (!category.keywords.some((k) => k.keyword === keyword)) {
          const k = await post<Category['keywords'][number]>(`/categories/${categoryId}/keywords`, { keyword });
          category.keywords.push(k);
        }
        const res = await post<{ updated: number }>('/transactions/apply-rule', { merchant, category_id: categoryId });
        toast(`Rule added; moved ${res.updated} transaction${res.updated === 1 ? '' : 's'} to ${category.name}`);
        await load();
      },
    },
  });
}

// ---- transfers between your own accounts ----

async function unpair(pairId: number) {
  try {
    await del(`/transactions/pairs/${pairId}`);
  } catch (err) {
    toast(errorMessage(err), 'error');
    return;
  }
  toast('No longer marked as a transfer; check the two categories');
  await load();
}

async function findTransfers() {
  let candidates: TransferCandidate[];
  try {
    candidates = await get<TransferCandidate[]>('/transactions/pairs');
  } catch (err) {
    toast(errorMessage(err), 'error');
    return;
  }
  const side = (s: TransferCandidate['debit'], label: string) =>
    h('div', { class: 'pair-side' },
      h('span', { class: 'cell-sub' }, `${label} · ${fmtDate(s.date)} · ${[s.bank?.toUpperCase(), s.account_last4 && `••${s.account_last4}`].filter(Boolean).join(' ') || 'no account'}`),
      s.description,
    );
  const list = h('ul', { class: 'plain-list' });
  const close = button('Close');
  close.dataset.close = '';
  const dialog = createDialog('dialog-form',
    h('div', { class: 'form' },
      h('h2', null, 'Transfers between your accounts'),
      h('p', { class: 'muted small' },
        'A debit and a credit of the same amount on two of your accounts within three days. Marking them as a pair leaves both out of income and spending.'),
      list,
      h('div', { class: 'form-actions' }, close),
    ),
  );
  const paint = () =>
    renderList(list, candidates, (p) => {
      const mark = (kind: 'self_transfer' | 'card_payment') => async () => {
        try {
          const before = [p.debit.id, p.credit.id].map((id) => ({ id, category_id: items.find((x) => x.id === id)?.category_id ?? null }));
          const made = await post<{ pair_id: number }>('/transactions/pairs', { debit_id: p.debit.id, credit_id: p.credit.id, kind });
          candidates = candidates.filter((c) => c !== p);
          paint();
          void load();
          undoToast('Marked as a transfer', async () => {
            await del(`/transactions/pairs/${made.pair_id}`);
            for (const b of before) if (items.some((x) => x.id === b.id)) await patch(`/transactions/${b.id}`, { category_id: b.category_id });
            await load();
          });
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      };
      return h('li', { class: 'stack-sm' },
        h('div', { class: 'row' }, h('strong', { class: 'num' }, inr(p.amount)), h('span', { class: 'spacer' }),
          button('Self transfer', { size: 'sm', onClick: mark('self_transfer') }),
          button('Card payment', { size: 'sm', onClick: mark('card_payment') }),
        ),
        side(p.debit, 'Out'),
        side(p.credit, 'In'),
      );
    }, 'No likely transfers found.');
  paint();
  dialog.showModal();
}

$('#find-transfers').addEventListener('click', () => void findTransfers());

// ---- merchant names for rows saved before they existed ----

let backfilling = false;
async function backfillMerchants() {
  if (backfilling || !items.some((t) => t.merchant === null)) return;
  backfilling = true;
  try {
    for (let i = 0; i < 50; i++) {
      const res = await post<{ updated: number; remaining: number }>('/transactions/merchants/backfill', {});
      if (!res.remaining || !res.updated) break;
    }
    await load();
  } catch {
    /* names stay as descriptions; nothing is lost */
  } finally {
    backfilling = false;
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
  $('#txn-another').hidden = Boolean(t);
  setTxnCategory(t?.category_id ?? null);
  setValues(txnForm, {
    date: t ? fmtDate(t.date) : 'today',
    amount: t ? moneyInput(t.amount) : '',
    type: t?.type ?? 'debit',
    description: t?.description ?? '',
    remark: t?.remark ?? '',
  });
  refreshDateHint();
  openDialog(dialog);
  if (!t) (txnForm.elements.namedItem('amount') as HTMLInputElement).focus();
}

bindForm(txnForm, async (v) => {
  const another = addAnother;
  addAnother = false;
  const body = {
    date: parseNaturalDate(v.date ?? ''),
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
    rememberCategory(body.category_id);
    toast('Transaction added');
    if (another) {
      // Keep date and type; clear the rest and start again at the amount.
      setValues(txnForm, { amount: '', description: '', remark: '' });
      setTxnCategory(null);
      clearErrors(txnForm);
      (txnForm.elements.namedItem('amount') as HTMLInputElement).focus();
      void load();
    } else {
      dialog.close();
      await load();
    }
  }
});

$('#txn-another').addEventListener('click', () => (addAnother = true));
txnForm.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !editing) {
    e.preventDefault();
    addAnother = true;
    txnForm.requestSubmit();
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

pageHooks.newTransaction = () => openEditor(null);

listNav(rowsEl, {
  group: 'Transactions list',
  describe: (row) => row.getAttribute('aria-label') ?? '',
  actions: [
    {
      keys: 'x',
      description: 'Select or unselect the row',
      run: (row) => row.querySelector<HTMLInputElement>('td[data-cell=check] input')?.click(),
    },
    { keys: 'e', description: 'Edit the row', run: (row) => withItem(row, openEditor) },
    { keys: 'enter', description: 'Edit the row', run: (row) => withItem(row, openEditor), hidden: true },
    {
      keys: 'c',
      description: 'Change the category',
      run: (row) =>
        withItem(row, async (t) => {
          const id = await pickCategory(categories, `Category for ${t.description.slice(0, 40)}`);
          if (id !== undefined && id !== t.category_id) await setCategory(t, id);
          rowEl(t.id)?.focus();
        }),
    },
    { keys: 'delete', description: 'Delete the row (with Undo)', run: (row) => withItem(row, remove) },
  ],
});

function withItem(row: HTMLTableRowElement, fn: (t: Transaction) => unknown) {
  const t = items.find((x) => String(x.id) === row.dataset.id);
  if (t) void fn(t);
}

const wantsNew = new URLSearchParams(location.search).has('new');
const initial = urlFilters();
if (Object.values(initial).some(Boolean)) $('#filters').classList.add('is-open');
setValues(filtersForm, initial);
void categoriesReady().then(() => setValues(filtersForm, { category: initial.category }), () => undefined);
// load() rewrites the URL from the filters, which also drops ?new=1.
void load(initial);
if (wantsNew) void categoriesReady().then(() => openEditor(null), () => openEditor(null));
