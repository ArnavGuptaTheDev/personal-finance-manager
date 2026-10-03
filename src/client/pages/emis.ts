import { del, get, post, put } from '../api';
import { $, errorMessage, h } from '../dom';
import { fmtDate, inr, inrShort, moneyInput, parseMoney, qs, today } from '../format';
import type { Emi } from '../types';
import { button } from '../ui/button';
import { bindForm, clearErrors, setValues } from '../ui/form';
import { openDialog } from '../ui/modal';
import { renderTable, tableError, td } from '../ui/table';
import { toast, undoToast } from '../ui/toast';

const COLS = 6;
const dialog = $<HTMLDialogElement>('#emi-dialog');
const form = $<HTMLFormElement>('#emi-form');
let editing: Emi | null = null;

/** Rough per-month equivalent of an instalment, for the summary tile. */
function perMonth(e: Emi): number {
  const per = { days: 30.44, weeks: 4.345, months: 1, years: 1 / 12 }[e.frequency_unit];
  return (e.installment * per) / e.frequency_value;
}

function kpi(id: string, amount: number) {
  const el = $(`#${id}`);
  el.textContent = inrShort(amount);
  el.title = inr(amount);
}

async function load() {
  let emis: Emi[];
  try {
    emis = await get<Emi[]>(`/emis${qs({ today: today() })}`);
  } catch (err) {
    tableError($('#emi-rows'), COLS, errorMessage(err), () => void load());
    return;
  }
  kpi('monthly', emis.filter((e) => e.next_due).reduce((s, e) => s + perMonth(e), 0));
  kpi('remaining', emis.reduce((s, e) => s + e.remaining_amount, 0));
  renderTable($('#emi-rows'), emis, row, { colspan: COLS, empty: 'No EMIs yet.' });
}

function row(e: Emi): HTMLTableRowElement {
  const fill = h('span', { class: 'bar-fill' });
  fill.style.width = `${e.installments_total ? (e.installments_done / e.installments_total) * 100 : 0}%`;
  const every = e.frequency_value === 1 ? e.frequency_unit.replace(/s$/, '') : `${e.frequency_value} ${e.frequency_unit}`;
  return h('tr', null,
    td({ role: 'primary' }, e.title, h('span', { class: 'cell-sub' }, [e.lender, `every ${every}`].filter(Boolean).join(' · '))),
    td({ role: 'amount', class: 'right num' }, inr(e.installment)),
    td({ label: 'Progress', class: 'progress-cell' },
      h('div', { class: 'small muted' }, `${e.installments_done} of ${e.installments_total} paid`),
      h('div', { class: 'bar-track' }, fill),
    ),
    td({ label: 'Next due', class: 'num' }, e.next_due ? fmtDate(e.next_due) : h('span', { class: 'badge badge-positive' }, 'Completed')),
    td({ label: 'Remaining', class: 'right num' }, inr(e.remaining_amount)),
    td({ role: 'actions' },
      h('div', { class: 'row' },
        button('Edit', { variant: 'ghost', size: 'sm', onClick: () => openEditor(e) }),
        button('Delete', { variant: 'ghost-danger', size: 'sm', onClick: () => void remove(e) }),
      ),
    ),
  );
}

function openEditor(e: Emi | null) {
  editing = e;
  form.reset();
  clearErrors(form);
  $('#emi-dialog-title').textContent = e ? 'Edit EMI' : 'Add EMI';
  setValues(form, {
    title: e?.title ?? '',
    lender: e?.lender ?? '',
    installment: e ? moneyInput(e.installment) : '',
    frequency_value: e?.frequency_value ?? 1,
    frequency_unit: e?.frequency_unit ?? 'months',
    start_date: e?.start_date ?? '',
    end_date: e?.end_date ?? '',
    note: e?.note ?? '',
  });
  openDialog(dialog);
}

async function remove(e: Emi) {
  try {
    await del(`/emis/${e.id}`);
  } catch (err) {
    toast(errorMessage(err), 'error');
    return;
  }
  await load();
  undoToast(`Deleted "${e.title}"`, async () => {
    await post(`/emis/${e.id}/restore`, {});
    await load();
  });
}

bindForm(form, async (v) => {
  const body = {
    title: v.title,
    lender: v.lender || null,
    installment: parseMoney(v.installment ?? ''),
    frequency_unit: v.frequency_unit,
    frequency_value: Number(v.frequency_value),
    start_date: v.start_date,
    end_date: v.end_date,
    note: v.note || null,
  };
  if (editing) await put(`/emis/${editing.id}`, body);
  else await post('/emis', body);
  dialog.close();
  toast(editing ? 'EMI updated' : 'EMI added');
  await load();
});

$('#add-emi').addEventListener('click', () => openEditor(null));
void load();
