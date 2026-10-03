import { del, get, patch, post } from '../api';
import { Categorizer } from '../categorize';
import { $, categoryOptions, errorMessage, formValues, h, replace, run } from '../dom';
import { fmtDate, inr, signedInr } from '../format';
import { mappingProblem, mappingToFormat, type ColumnMapping } from '../parsers/formats';
import type { MappingChoice, MappingRole } from '../parsers/mapping';
import type { AccountType, Bank, ParsedRow, ParseResult, SkippedRow } from '../parsers/statement';
import { loadCategories } from '../shell';
import type { Category, NewTransaction } from '../types';
import { pickCategory, rememberCategory } from '../ui/category-picker';
import { listNav } from '../ui/list-nav';
import { td } from '../ui/table';
import { button } from '../ui/button';
import { toast, undoToast } from '../ui/toast';

type Match = { id: number; date: string; description: string; type: 'debit' | 'credit'; account_last4: string | null };
type Reconciled = { status: 'new' | 'duplicate' | 'changed'; match?: Match; changes?: string[] };
type Draft = ParsedRow & Reconciled & { category_id: number | null; include: boolean; fix: boolean };
type SavedFormat = { id: number; name: string; mapping: ColumnMapping };

const form = $<HTMLFormElement>('#parse-form');
const preview = $('#preview');
const tbody = $('#preview-rows');
const allBox = $<HTMLInputElement>('#all');
const saveBtn = $<HTMLButtonElement>('#save');
const fixBtn = $<HTMLButtonElement>('#apply-corrections');

let drafts: Draft[] = [];
let context: { bank: string; account: AccountType; last4: string | null; last4Source: ParseResult['last4Source'] } | null = null;
let categories: Category[] = [];
let summary: { skipped: SkippedRow[]; joined: number; balance: ParseResult['balance'] } = { skipped: [], joined: 0, balance: null };
let parsedRows: ParsedRow[] = [];
let savedFormats: SavedFormat[] = [];

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

function balanceLine(): string | null {
  const b = summary.balance;
  if (!b?.checked) return null;
  if (!b.mismatches) return `Running balance checked on ${plural(b.checked, 'row')}: everything adds up.`;
  return `Running balance: ${plural(b.mismatches, 'row')} of ${b.checked} ${b.mismatches === 1 ? "doesn't" : "don't"} add up; a row may be missing or misread (flagged below).`;
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
    balanceLine(),
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
  $('#preview-meta').textContent = uncategorized ? `${uncategorized} uncategorized` : '';
  $<HTMLInputElement>('#last4').value = context?.last4 ?? '';
  $('#last4-source').textContent = context?.last4Source ? `(read from the ${context.last4Source})` : context?.last4 ? '' : '(not found; type it if you know it)';
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
    const [parser, cats] = await Promise.all([import('../parsers/statement'), loadCategories()]);
    categories = cats;
    const account = v.account as AccountType;
    $('#mapping').hidden = true;
    const saved = savedFormats.find((f) => `fmt:${f.id}` === v.bank);
    try {
      if (v.bank === 'other') throw new parser.UnrecognisedStatementError('Map the columns of this statement once; you can save the result as a format.');
      const result = saved
        ? await parser.parseStatementWith(file, mappingToFormat(saved.mapping, saved.name))
        : await parser.parseStatement(file, v.bank as Bank, account);
      await review(result, saved ? bankFor(saved.name) : (v.bank ?? 'other'), account);
    } catch (err) {
      if (!(err instanceof parser.UnrecognisedStatementError)) throw err;
      preview.hidden = true;
      await showMapping(file, err.message);
    }
  });
});

/** The bank label stored with imported rows (and part of their duplicate fingerprint). */
const bankFor = (formatName: string) => formatName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'other';

async function review(result: ParseResult, bank: string, account: AccountType) {
  context = { bank, account, last4: result.last4, last4Source: result.last4Source };
  summary = { skipped: result.skipped, joined: result.joined, balance: result.balance };
  parsedRows = result.rows;
  drafts = [];
  await reconcile();
}

/** Classifies parsed rows against stored ones (again after the account digits change). */
async function reconcile() {
  if (!context) return;
  const { bank, last4 } = context;
  const { results } = await post<{ results: Reconciled[] }>('/transactions/reconcile', {
    rows: parsedRows.map((r) => ({ date: r.date, amount: r.amount, type: r.type, description: r.description, bank, account_last4: last4 })),
  });
  const categorizer = new Categorizer(categories);
  // Keep categories already chosen in the review when re-checking.
  const chosen = new Map(drafts.map((d, i) => [i, d.category_id]));
  drafts = parsedRows.map((r, i) => {
    const rec = results[i] ?? { status: 'new' as const };
    return {
      ...r,
      ...rec,
      category_id: chosen.has(i) ? chosen.get(i)! : categorizer.categorize(r.description),
      // Only new rows that need no human look are ticked; nothing is re-added or dropped silently.
      include: rec.status === 'new' && !r.note,
      fix: rec.status === 'changed',
    };
  });
  render();
}

$<HTMLInputElement>('#last4').addEventListener('change', (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const value = input.value.trim();
  if (value && !/^\d{4}$/.test(value)) {
    toast('Enter the last four digits of the account or card', 'error');
    input.value = context?.last4 ?? '';
    return;
  }
  if (!context) return;
  context.last4 = value || null;
  context.last4Source = null;
  void reconcile().catch((err) => toast(errorMessage(err), 'error'));
});

// ---- manual column mapping (unrecognised layouts) ----

const mappingForm = $<HTMLFormElement>('#mapping-form');
let mappingRows: string[][] = [];
let mappingFile: File | null = null;
const ROLES: MappingRole[] = ['date', 'description', 'debit', 'credit', 'amount', 'sign', 'balance'];
const cleanCell = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function fillColumnSelects(header: number, choice?: MappingChoice['columns']) {
  const titles = (mappingRows[header] ?? []).map(cleanCell);
  for (const role of ROLES) {
    const select = mappingForm.elements.namedItem(role) as HTMLSelectElement;
    const keep = choice ? choice[role] : select.value === '' ? undefined : Number(select.value);
    const options = titles.flatMap((t, i) => (t ? [h('option', { value: i, selected: keep === i }, t)] : []));
    replace(select, h('option', { value: '' }, '—'), ...options);
  }
  renderSample(header);
}

function renderSample(header: number) {
  const titles = (mappingRows[header] ?? []).map(cleanCell);
  const body = mappingRows.slice(header + 1).filter((r) => r.some((c) => cleanCell(c))).slice(0, 5);
  replace(
    $('#map-sample'),
    h('thead', null, h('tr', null, ...titles.map((t) => h('th', null, t || '—')))),
    h('tbody', null, ...body.map((r) => h('tr', null, ...titles.map((_, i) => h('td', null, cleanCell(r[i])))))),
  );
}

async function showMapping(file: File, reason: string) {
  const [{ readStatementRows }, { guessChoice }] = await Promise.all([import('../parsers/statement'), import('../parsers/mapping')]);
  mappingFile = file;
  mappingRows = await readStatementRows(file);
  const choice = guessChoice(mappingRows);
  $('#mapping-reason').textContent = reason;
  replace(
    $('#map-header'),
    ...mappingRows.slice(0, 40).flatMap((r, i) => {
      const text = r.map(cleanCell).filter(Boolean).join(' · ').slice(0, 80);
      return text ? [h('option', { value: i, selected: i === choice.header }, `Row ${i + 1}: ${text}`)] : [];
    }),
  );
  (mappingForm.elements.namedItem('amounts') as HTMLSelectElement).value = choice.amounts;
  (mappingForm.elements.namedItem('dateOrder') as HTMLSelectElement).value = choice.dateOrder;
  mappingForm.dataset.amounts = choice.amounts;
  fillColumnSelects(choice.header, choice.columns);
  $('#mapping').hidden = false;
  $('#mapping').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

mappingForm.addEventListener('change', (e) => {
  const target = e.target as HTMLSelectElement;
  if (target.name === 'header') fillColumnSelects(Number(target.value));
  if (target.name === 'amounts') mappingForm.dataset.amounts = target.value;
});

mappingForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(mappingForm);
  run(mappingForm.querySelector<HTMLButtonElement>('button[type=submit]'), async () => {
    if (!mappingFile) return;
    const [{ parseRows, UnrecognisedStatementError }, { toMapping }] = await Promise.all([import('../parsers/statement'), import('../parsers/mapping')]);
    const columns: MappingChoice['columns'] = {};
    for (const role of ROLES) if (v[role]) columns[role] = Number(v[role]);
    const choice: MappingChoice = { header: Number(v.header), amounts: v.amounts as MappingChoice['amounts'], dateOrder: v.dateOrder as MappingChoice['dateOrder'], columns };
    const mapping = toMapping(mappingRows, choice);
    const problem = mappingProblem(mapping);
    if (problem) throw new Error(problem);
    const name = v.save_name ?? '';
    let result: ParseResult;
    try {
      result = parseRows(mappingRows, mappingToFormat(mapping, name || 'this mapping'), mappingFile.name);
    } catch (err) {
      if (err instanceof UnrecognisedStatementError) throw new Error(`Still no transactions with these choices: ${err.message}`);
      throw err;
    }
    if (name) {
      const saved = await post<SavedFormat>('/import-formats', { name, mapping });
      savedFormats.push(saved);
      renderFormats();
      $<HTMLSelectElement>('#bank-select').value = `fmt:${saved.id}`;
      toast(`Saved "${saved.name}" for next time`);
    }
    $('#mapping').hidden = true;
    await review(result, name ? bankFor(name) : 'other', formValues(form).account as AccountType);
  });
});

// ---- saved formats ----

async function removeFormat(f: SavedFormat) {
  try {
    await del(`/import-formats/${f.id}`);
  } catch (err) {
    toast(errorMessage(err), 'error');
    return;
  }
  savedFormats = savedFormats.filter((x) => x.id !== f.id);
  renderFormats();
  undoToast(`Deleted "${f.name}"`, async () => {
    await post(`/import-formats/${f.id}/restore`, {});
    savedFormats = await get<SavedFormat[]>('/import-formats');
    renderFormats();
  });
}

function renderFormats() {
  const bankSelect = $<HTMLSelectElement>('#bank-select');
  bankSelect.querySelector('optgroup')?.remove();
  if (savedFormats.length) {
    bankSelect.append(h('optgroup', { label: 'Your formats' }, ...savedFormats.map((f) => h('option', { value: `fmt:${f.id}` }, f.name))));
  }
  $('#formats-box').hidden = savedFormats.length === 0;
  replace(
    $('#formats-list'),
    ...savedFormats.map((f) =>
      h('li', { class: 'row' }, h('span', null, f.name), h('span', { class: 'spacer' }), button('Delete', { variant: 'ghost-danger', size: 'sm', onClick: () => void removeFormat(f) })),
    ),
  );
}

get<SavedFormat[]>('/import-formats')
  .then((list) => {
    savedFormats = list;
    renderFormats();
  })
  .catch(() => undefined);

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
    parsedRows = [];
    resetImport();
  }).catch((err) => toast(errorMessage(err), 'error')),
);
