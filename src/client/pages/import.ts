import { post } from '../api';
import { Categorizer } from '../categorize';
import { $, categoryOptions, errorMessage, formValues, h, replace, run, toast } from '../dom';
import { fmtDate, inr } from '../format';
import type { AccountType, Bank, ParsedRow } from '../parsers/statement';
import { loadCategories } from '../shell';
import type { Category, NewTransaction } from '../types';

type Draft = ParsedRow & { category_id: number | null; include: boolean };

const form = $<HTMLFormElement>('#parse-form');
const preview = $('#preview');
const tbody = $('#preview-rows');
const allBox = $<HTMLInputElement>('#all');
const saveBtn = $<HTMLButtonElement>('#save');

let drafts: Draft[] = [];
let context: { bank: Bank; account: AccountType; last4: string | null } | null = null;
let categories: Category[] = [];

function updateSaveLabel() {
  const n = drafts.filter((d) => d.include).length;
  saveBtn.textContent = `Import ${n} transaction${n === 1 ? '' : 's'}`;
  saveBtn.disabled = n === 0;
}

function render() {
  const uncategorized = drafts.filter((d) => d.category_id === null).length;
  $('#preview-meta').textContent = [
    `${drafts.length} rows`,
    context?.last4 ? `account ••${context.last4}` : null,
    uncategorized ? `${uncategorized} uncategorized` : 'all categorized',
  ]
    .filter(Boolean)
    .join(' · ');

  replace(
    tbody,
    ...drafts.map((d) => {
      const tr = h('tr', { 'data-muted': !d.include });
      const box = h('input', { type: 'checkbox', checked: d.include, 'aria-label': 'Include' });
      box.addEventListener('change', () => {
        d.include = box.checked;
        tr.dataset.muted = String(!d.include);
        updateSaveLabel();
      });
      const select = h('select', { 'aria-label': 'Category' }, ...categoryOptions(categories, d.category_id));
      select.addEventListener('change', () => (d.category_id = select.value ? Number(select.value) : null));
      tr.append(
        h('td', null, box),
        h('td', { class: 'num small' }, fmtDate(d.date)),
        h('td', { class: 'desc' }, d.description),
        h('td', null, select),
        h('td', { class: `right num ${d.type === 'credit' ? 'income' : ''}` }, `${d.type === 'credit' ? '+' : '−'}${inr(d.amount)}`),
      );
      return tr;
    }),
  );
  allBox.checked = drafts.every((d) => d.include);
  updateSaveLabel();
  preview.hidden = false;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(form);
  const file = ($<HTMLInputElement>('input[type=file]', form).files ?? [])[0];
  if (!file) return toast('Choose a statement file first', 'error');

  run($<HTMLButtonElement>('#parse-btn'), async () => {
    // SheetJS is large, so the parser is only downloaded on this page, when needed.
    const [{ parseStatement }, cats] = await Promise.all([import('../parsers/statement'), loadCategories()]);
    categories = cats;
    const bank = v.bank as Bank;
    const account = v.account as AccountType;
    const result = await parseStatement(file, bank, account);
    const categorizer = new Categorizer(categories);
    drafts = result.rows.map((r) => ({ ...r, category_id: categorizer.categorize(r.description), include: true }));
    context = { bank, account, last4: result.last4 };
    render();
    toast(`Read ${drafts.length} transactions`);
  });
});

allBox.addEventListener('change', () => {
  drafts.forEach((d) => (d.include = allBox.checked));
  render();
});

$('#discard').addEventListener('click', () => {
  drafts = [];
  preview.hidden = true;
  form.reset();
});

saveBtn.addEventListener('click', () =>
  run(saveBtn, async () => {
    if (!context) return;
    const rows: NewTransaction[] = drafts
      .filter((d) => d.include)
      .map((d) => ({
        date: d.date,
        amount: d.amount,
        type: d.type,
        description: d.description,
        category_id: d.category_id,
        bank: context!.bank,
        account_type: context!.account,
        account_last4: context!.last4,
      }));
    const res = await post<{ inserted: number; skipped: number }>('/transactions/bulk', rows);
    toast(`Imported ${res.inserted}${res.skipped ? `, skipped ${res.skipped} duplicate${res.skipped === 1 ? '' : 's'}` : ''}`);
    drafts = [];
    preview.hidden = true;
    form.reset();
  }).catch((err) => toast(errorMessage(err), 'error')),
);
