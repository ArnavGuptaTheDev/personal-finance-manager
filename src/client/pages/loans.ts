import { del, get, post, put } from '../api';
import { $, emptyState, errorMessage, formValues, h, replace, run, toast } from '../dom';
import { fmtDate, inr, today } from '../format';
import type { Loan, Person } from '../types';

const loanForm = $<HTMLFormElement>('#loan-form');
const personForm = $<HTMLFormElement>('#person-form');

function resetLoanForm() {
  loanForm.reset();
  (loanForm.elements.namedItem('date') as HTMLInputElement).value = today();
}

async function load() {
  const [people, loans] = await Promise.all([get<Person[]>('/people'), get<Loan[]>('/loans')]);

  replace(
    $('#loan-person'),
    ...(people.length ? people.map((p) => h('option', { value: p.id }, p.name)) : [h('option', { value: '' }, 'Add a person first')]),
  );
  replace($('#people'), ...(people.length ? people.map(personItem) : [h('li', { class: 'muted small' }, 'No people yet.')]));

  const owedToMe = loans.filter((l) => l.direction === 'lent').reduce((s, l) => s + Math.max(0, l.outstanding), 0);
  const iOwe = loans.filter((l) => l.direction === 'borrowed').reduce((s, l) => s + Math.max(0, l.outstanding), 0);
  $('#owed-to-me').textContent = inr(owedToMe);
  $('#i-owe').textContent = inr(iOwe);

  replace($('#loan-list'), ...(loans.length ? loans.map(loanCard) : [h('div', { class: 'card' }, emptyState('No loans recorded.'))]));
}

function personItem(p: Person): HTMLElement {
  const rename = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Rename');
  rename.addEventListener('click', () => {
    const name = prompt('New name', p.name)?.trim();
    if (!name || name === p.name) return;
    run(rename, async () => {
      await put(`/people/${p.id}`, { name, note: p.note });
      await load();
    });
  });
  const remove = h('button', { class: 'btn btn-ghost btn-sm btn-danger', type: 'button' }, 'Delete');
  remove.addEventListener('click', () =>
    run(remove, async () => {
      if (!confirm(`Delete ${p.name}? Their loans and payments are deleted too.`)) return;
      await del(`/people/${p.id}`);
      toast('Person deleted');
      await load();
    }),
  );
  return h('li', { class: 'row' }, h('span', null, p.name), h('span', { class: 'spacer' }), rename, remove);
}

function loanCard(l: Loan): HTMLElement {
  const settled = l.outstanding <= 0;
  const payForm = h('form', { class: 'row' },
    h('input', { name: 'amount', type: 'number', min: '0.01', step: '0.01', required: true, placeholder: 'Amount', 'aria-label': 'Payment amount', inputmode: 'decimal' }),
    h('input', { name: 'date', type: 'date', required: true, value: today(), 'aria-label': 'Payment date' }),
    h('button', { class: 'btn btn-sm', type: 'submit' }, l.direction === 'lent' ? 'Record repayment' : 'Record payment'),
  );
  payForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(payForm);
    run(payForm.querySelector('button'), async () => {
      await post(`/loans/${l.id}/payments`, { amount: Number(v.amount), date: v.date });
      toast('Payment recorded');
      await load();
    });
  });

  const remove = h('button', { class: 'btn btn-ghost btn-sm btn-danger', type: 'button' }, 'Delete loan');
  remove.addEventListener('click', () =>
    run(remove, async () => {
      if (!confirm(`Delete "${l.title}" and its payments?`)) return;
      await del(`/loans/${l.id}`);
      toast('Loan deleted');
      await load();
    }),
  );

  const payments = l.payments.length
    ? h('ul', { class: 'plain-list small' },
        ...l.payments.map((p) => {
          const x = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Delete payment' }, '×');
          x.addEventListener('click', () =>
            run(x, async () => {
              await del(`/loans/${l.id}/payments/${p.id}`);
              await load();
            }),
          );
          return h('li', { class: 'row' }, h('span', { class: 'muted' }, fmtDate(p.date)), h('span', { class: 'num' }, inr(p.amount)), x);
        }),
      )
    : null;

  return h('article', { class: 'card stack' },
    h('div', { class: 'row' },
      h('h2', null, l.title),
      h('span', { class: 'badge' }, l.direction === 'lent' ? `Lent to ${l.person_name}` : `Borrowed from ${l.person_name}`),
      settled && h('span', { class: 'badge' }, 'Settled'),
      h('span', { class: 'spacer' }),
      remove,
    ),
    h('p', { class: 'muted small' },
      `${inr(l.amount)} on ${fmtDate(l.date)} · paid back ${inr(l.paid)} · `,
      h('strong', { class: settled ? 'income' : 'spend' }, `${inr(Math.max(0, l.outstanding))} outstanding`),
    ),
    payments,
    !settled && payForm,
  );
}

loanForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(loanForm);
  if (!v.person_id) return toast('Add a person first', 'error');
  run($<HTMLButtonElement>('#loan-save'), async () => {
    await post('/loans', { person_id: Number(v.person_id), direction: v.direction, title: v.title, amount: Number(v.amount), date: v.date });
    toast('Loan added');
    resetLoanForm();
    await load();
  });
});

personForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(personForm);
  run($<HTMLButtonElement>('#person-save'), async () => {
    await post('/people', { name: v.name });
    personForm.reset();
    await load();
  });
});

resetLoanForm();
load().catch((err) => toast(errorMessage(err), 'error'));
