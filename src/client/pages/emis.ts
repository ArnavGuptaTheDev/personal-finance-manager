import { del, get, post } from '../api';
import { $, emptyState, errorMessage, formValues, h, replace, run, toast } from '../dom';
import { fmtDate, inr } from '../format';
import type { Emi } from '../types';

const form = $<HTMLFormElement>('#emi-form');

/** Rough per-month equivalent of an instalment, for the summary tile. */
function perMonth(e: Emi): number {
  const per = { days: 30.44, weeks: 4.345, months: 1, years: 1 / 12 }[e.frequency_unit];
  return (e.installment * per) / e.frequency_value;
}

async function load() {
  const emis = await get<Emi[]>('/emis');
  const active = emis.filter((e) => e.next_due);
  $('#monthly').textContent = inr(active.reduce((s, e) => s + perMonth(e), 0));
  $('#remaining').textContent = inr(emis.reduce((s, e) => s + e.remaining_amount, 0));

  if (!emis.length) {
    replace($('#emi-rows'), h('tr', null, h('td', { colspan: 6 }, emptyState('No EMIs yet.'))));
    return;
  }
  replace(
    $('#emi-rows'),
    ...emis.map((e) => {
      const remove = h('button', { class: 'btn btn-ghost btn-sm btn-danger', type: 'button' }, 'Delete');
      remove.addEventListener('click', () =>
        run(remove, async () => {
          if (!confirm(`Delete "${e.title}"?`)) return;
          await del(`/emis/${e.id}`);
          toast('EMI deleted');
          await load();
        }),
      );
      const fill = h('span', { class: 'bar-fill' });
      fill.style.width = `${e.installments_total ? (e.installments_done / e.installments_total) * 100 : 0}%`;
      const every = e.frequency_value === 1 ? e.frequency_unit.replace(/s$/, '') : `${e.frequency_value} ${e.frequency_unit}`;
      return h('tr', null,
        h('td', null, e.title, h('div', { class: 'muted small' }, [e.lender, `every ${every}`].filter(Boolean).join(' · '))),
        h('td', { class: 'right num' }, inr(e.installment)),
        h('td', { class: 'progress-cell' },
          h('div', { class: 'small muted' }, `${e.installments_done} of ${e.installments_total} paid`),
          h('div', { class: 'bar-track' }, fill),
        ),
        h('td', { class: 'num small' }, e.next_due ? fmtDate(e.next_due) : h('span', { class: 'badge' }, 'Completed')),
        h('td', { class: 'right num' }, inr(e.remaining_amount)),
        h('td', { class: 'right' }, remove),
      );
    }),
  );
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(form);
  run($<HTMLButtonElement>('#emi-save'), async () => {
    await post('/emis', {
      title: v.title,
      lender: v.lender || null,
      installment: Number(v.installment),
      frequency_unit: v.frequency_unit,
      frequency_value: Number(v.frequency_value),
      start_date: v.start_date,
      end_date: v.end_date,
    });
    toast('EMI added');
    form.reset();
    await load();
  });
});

load().catch((err) => toast(errorMessage(err), 'error'));
