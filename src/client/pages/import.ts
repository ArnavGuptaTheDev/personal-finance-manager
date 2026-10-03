import { patch, post } from '../api';
import { Categorizer } from '../categorize';
import { $, categoryOptions, errorMessage, formValues, h, replace, run } from '../dom';
import { fmtDate, inr, signedInr } from '../format';
import type { AccountType, Bank, ParsedRow, SkippedRow } from '../parsers/statement';
import { loadCategories } from '../shell';
import type { Category, NewTransaction } from '../types';
import { pickCategory, rememberCategory } from '../ui/category-picker';
import { listNav } from '../ui/list-nav';
import { td } from '../ui/table';
import { toast } from '../ui/toast';

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
  if (d.status === 'changed') return h('span', { class: 'badge badge-warning' }, 'Stored with different details, see above');
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
      return h('li', { class: 'row' }, h('label', { class: 'check' }, box), h('span', null, `${inr(d.amount)} · ${diffs.join('; ')}`));
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
    ...drafts.map((d, i) => {
      const tr = h('tr', { 'data-muted': !d.include, 'data-id': i, 'aria-label': `${d.description}, ${signedInr(d.amount, d.type)}, ${fmtDate(d.date)}` });
      const box = h('input', { type: 'checkbox', checked: d.include, 'aria-label': 'Include' });
      box.addEventListener('change', () => {
        d.include = box.checked;
        tr.dataset.muted = String(!d.include);
        updateSaveLabel();
      });
      const select = h('select', { 'aria-label': 'Category' }, ...categoryOptions(categories, d.category_id));
      select.addEventListener('change', () => {
        d.category_id = select.value ? Number(select.value) : null;
        rememberCategory(d.category_id);
      });
      tr.append(
        td({ role: 'check' }, h('label', { class: 'check' }, box)),
        td({ role: 'meta', class: 'num' }, fmtDate(d.date)),
        td({ role: 'primary', class: 'desc' }, d.description, statusLabel(d) && h('div', null, statusLabel(d)), d.note && h('div', { class: 'small spend' }, d.note)),
        td({ label: 'Category' }, select),
        td({ role: 'amount', class: `right num ${d.type === 'credit' ? 'income' : ''}` }, signedInr(d.amount, d.type)),
      );
      return tr;
    }),
  );
  allBox.checked = drafts.length > 0 && drafts.every((d) => d.include);
  updateSaveLabel();
  preview.hidden = false;
}

const fileInput = $<HTMLInputElement>('#file-input');
const dropzone = $('#dropzone');
const DEFAULT_FILE_TEXT = $('#file-name').textContent ?? '';

function fileChosen() {
  const file = fileInput.files?.[0];
  $('#file-name').textContent = file ? file.name : DEFAULT_FILE_TEXT;
  if (file) form.requestSubmit();
}
fileInput.addEventListener('change', fileChosen);
for (const type of ['dragenter', 'dragover'] as const) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-over');
  });
}
for (const type of ['dragleave', 'drop'] as const) dropzone.addEventListener(type, () => dropzone.classList.remove('is-over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileChosen();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(form);
  const file = (fileInput.files ?? [])[0];
  if (!file) {
    toast('Choose a statement file first', 'error');
    fileInput.focus();
    return;
  }

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

listNav(tbody, {
  group: 'Import review',
  when: () => !preview.hidden,
  describe: (row) => `${row.getAttribute('aria-label') ?? ''}, ${row.dataset.muted === 'true' ? 'not included' : 'included'}`,
  actions: [
    { keys: 'x', description: 'Include or skip the row', run: (row) => row.querySelector<HTMLInputElement>('td[data-cell=check] input')?.click() },
    {
      keys: 'c',
      description: 'Change the category',
      run: async (row) => {
        const d = drafts[Number(row.dataset.id)];
        if (!d) return;
        const id = await pickCategory(categories, `Category for ${d.description.slice(0, 40)}`);
        if (id !== undefined) {
          d.category_id = id;
          const select = row.querySelector('select');
          if (select) select.value = id == null ? '' : String(id);
        }
        row.focus();
      },
    },
  ],
});

function resetImport() {
  drafts = [];
  preview.hidden = true;
  form.reset();
  $('#file-name').textContent = DEFAULT_FILE_TEXT;
}

$('#discard').addEventListener('click', resetImport);

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
    resetImport();
  }).catch((err) => toast(errorMessage(err), 'error')),
);
