import { patch, post } from '../api';
import { Categorizer } from '../categorize';
import { $, categoryOptions, errorMessage, formValues, h, replace, run, toast } from '../dom';
import { fmtDate, inr } from '../format';
import type { AccountType, Bank, ParsedRow, SkippedRow } from '../parsers/statement';
import { loadCategories } from '../shell';
import type { Category, NewTransaction } from '../types';

type Match = { id: number; date: string; description: string; type: 'debit' | 'credit'; account_last4: string | null };
type Reconciled = { status: 'new' | 'duplicate' | 'changed'; match?: Match; changes?: string[] };
type Draft = ParsedRow & Reconciled & { category_id: number | null; include: boolean; fix: boolean };

const form = $<HTMLFormElement>('#parse-form');
const preview = $('#preview');
const tbody = $('#preview-rows');
const allBox = $<HTMLInputElement>('#all');
const saveBtn = $<HTMLButtonElement>('#save');
const fixBtn = $<HTMLButtonElement>('#apply-corrections');

let drafts: Draft[] = [];
let context: { bank: Bank; account: AccountType; last4: string | null } | null = null;
let categories: Category[] = [];
let summary: { skipped: SkippedRow[]; joined: number } = { skipped: [], joined: 0 };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function updateSaveLabel() {
  const n = drafts.filter((d) => d.include).length;
  saveBtn.textContent = `Import ${plural(n, 'transaction')}`;
  saveBtn.disabled = n === 0;
}

function statusLabel(d: Draft) {
  if (d.status === 'duplicate') return h('span', { class: 'badge' }, 'Already imported');
  if (d.status === 'changed') return h('span', { class: 'badge outcome-failure' }, 'Stored with different details, see above');
  return null;
}

function renderSummary() {
  const counts = {
    new: drafts.filter((d) => d.status === 'new').length,
    duplicate: drafts.filter((d) => d.status === 'duplicate').length,
    changed: drafts.filter((d) => d.status === 'changed').length,
    flagged: drafts.filter((d) => d.note && d.status === 'new').length,
  };
  const lines = [
    `Read ${plural(drafts.length, 'transaction')}: ${counts.new} new, ${counts.duplicate} already imported` +
      (counts.changed ? `, ${counts.changed} stored with different details` : '') + '.',
    summary.joined ? `${plural(summary.joined, 'wrapped description line')} joined onto the transaction above.` : null,
    counts.flagged ? `${plural(counts.flagged, 'row')} ${counts.flagged === 1 ? 'needs' : 'need'} a look and ${counts.flagged === 1 ? 'is' : 'are'} unticked: see the notes below.` : null,
  ].filter(Boolean) as string[];

  const parts: (HTMLElement | string)[] = lines.map((l) => h('p', { class: 'muted' }, l));
  if (summary.skipped.length) {
    parts.push(
      h('details', null,
        h('summary', null, `${plural(summary.skipped.length, 'row')} in the file were not imported`),
        h('ul', { class: 'plain-list' },
          ...summary.skipped.map((s) => h('li', null, h('strong', null, `Line ${s.line}: ${s.reason}. `), h('span', { class: 'muted' }, s.text))),
        ),
      ),
    );
  }
  replace($('#parse-summary'), ...parts);
}

function renderCorrections() {
  const changed = drafts.filter((d) => d.status === 'changed' && d.match);
  $('#corrections').hidden = changed.length === 0;
  replace(
    $('#correction-list'),
    ...changed.map((d) => {
      const m = d.match!;
      const box = h('input', { type: 'checkbox', checked: d.fix, 'aria-label': 'Correct this transaction' });
      box.addEventListener('change', () => (d.fix = box.checked));
      const diffs = (d.changes ?? []).map((c) => {
        if (c === 'date') return `date ${fmtDate(m.date)} → ${fmtDate(d.date)}`;
        if (c === 'description') return `description "${m.description}" → "${d.description}"`;
        if (c === 'type') return `${m.type} → ${d.type}`;
        return `account ••${m.account_last4 ?? '—'} → ••${context?.last4 ?? '—'}`;
      });
      return h('li', { class: 'row' }, box, h('span', null, `${inr(d.amount)} · ${diffs.join('; ')}`));
    }),
  );
}

function render() {
  const uncategorized = drafts.filter((d) => d.include && d.category_id === null).length;
  $('#preview-meta').textContent = [context?.last4 ? `account ••${context.last4}` : null, uncategorized ? `${uncategorized} uncategorized` : null]
    .filter(Boolean)
    .join(' · ');
  renderSummary();
  renderCorrections();

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
        h('td', { class: 'desc' }, d.description, statusLabel(d) && h('div', null, statusLabel(d)), d.note && h('div', { class: 'small spend' }, d.note)),
        h('td', null, select),
        h('td', { class: `right num ${d.type === 'credit' ? 'income' : ''}` }, `${d.type === 'credit' ? '+' : '−'}${inr(d.amount)}`),
      );
      return tr;
    }),
  );
  allBox.checked = drafts.length > 0 && drafts.every((d) => d.include);
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
    context = { bank, account, last4: result.last4 };
    summary = { skipped: result.skipped, joined: result.joined };

    const { results } = await post<{ results: Reconciled[] }>('/transactions/reconcile', {
      rows: result.rows.map((r) => ({ date: r.date, amount: r.amount, type: r.type, description: r.description, bank, account_last4: result.last4 })),
    });
    const categorizer = new Categorizer(categories);
    drafts = result.rows.map((r, i) => {
      const rec = results[i] ?? { status: 'new' as const };
      return {
        ...r,
        ...rec,
        category_id: categorizer.categorize(r.description),
        // Only new rows that need no human look are ticked; nothing is re-added or dropped silently.
        include: rec.status === 'new' && !r.note,
        fix: rec.status === 'changed',
      };
    });
    render();
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

fixBtn.addEventListener('click', () =>
  run(fixBtn, async () => {
    const todo = drafts.filter((d) => d.status === 'changed' && d.fix && d.match);
    let done = 0;
    for (const d of todo) {
      const body: Record<string, unknown> = {};
      for (const c of d.changes ?? []) {
        if (c === 'date') body.date = d.date;
        if (c === 'description') body.description = d.description;
        if (c === 'type') body.type = d.type;
        if (c === 'account') body.account_last4 = context?.last4 ?? null;
      }
      await patch(`/transactions/${d.match!.id}`, body);
      d.status = 'duplicate';
      d.include = false;
      done++;
    }
    toast(`Corrected ${plural(done, 'stored transaction')}`);
    render();
  }),
);

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
    toast(`Imported ${res.inserted}${res.skipped ? `, skipped ${plural(res.skipped, 'duplicate')}` : ''}`);
    drafts = [];
    preview.hidden = true;
    form.reset();
  }).catch((err) => toast(errorMessage(err), 'error')),
);
