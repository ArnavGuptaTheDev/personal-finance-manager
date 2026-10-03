import { del, get, post, put } from '../api';
import { $, errorMessage, h, replace } from '../dom';
import { fmtDate, inr, inrShort, moneyInput, parseMoney, today } from '../format';
import type { Loan, Person } from '../types';
import { button } from '../ui/button';
import { bindForm, clearErrors, setValues } from '../ui/form';
import { openDialog } from '../ui/modal';
import { bindTabs } from '../ui/tabs';
import { emptyState, errorState, renderList } from '../ui/table';
import { toast, undoToast } from '../ui/toast';

const loanDialog = $<HTMLDialogElement>('#loan-dialog');
const loanForm = $<HTMLFormElement>('#loan-form');
const personDialog = $<HTMLDialogElement>('#person-dialog');
const personEdit = $<HTMLFormElement>('#person-edit');
const personForm = $<HTMLFormElement>('#person-form');

let people: Person[] = [];
let loans: Loan[] = [];
let view = 'active';
let editingLoan: Loan | null = null;
let editingPerson: Person | null = null;

const settled = (l: Loan) => l.outstanding <= 0;

async function load() {
  try {
    [people, loans] = await Promise.all([get<Person[]>('/people'), get<Loan[]>('/loans')]);
  } catch (err) {
    replace($('#loan-list'), errorState(errorMessage(err), () => void load()));
    return;
  }
  render();
}

function render() {
  renderList($('#people'), people, personItem, h('li', { class: 'muted small' }, 'No people yet. Add someone to record a loan.'));

  const owedToMe = loans.filter((l) => l.direction === 'lent').reduce((s, l) => s + Math.max(0, l.outstanding), 0);
  const iOwe = loans.filter((l) => l.direction === 'borrowed').reduce((s, l) => s + Math.max(0, l.outstanding), 0);
  for (const [id, amount] of [['owed-to-me', owedToMe], ['i-owe', iOwe]] as const) {
    const el = $(`#${id}`);
    el.textContent = inrShort(amount);
    el.title = inr(amount);
  }

  // Active loans first, newest first within each group.
  const shown = loans
    .filter((l) => view === 'all' || (view === 'settled') === settled(l))
    .sort((a, b) => Number(settled(a)) - Number(settled(b)) || b.date.localeCompare(a.date));
  const empty = view === 'settled' ? 'No settled loans yet.' : view === 'active' && loans.length ? 'Everything is settled.' : 'No loans recorded.';
  renderList($('#loan-list'), shown, loanCard, h('div', { class: 'card' }, emptyState(empty)));
}

function personItem(p: Person): HTMLElement {
  return h('li', { class: 'row' },
    h('span', null, p.name, p.note && h('span', { class: 'cell-sub' }, p.note)),
    h('span', { class: 'spacer' }),
    button('Edit', { variant: 'ghost', size: 'sm', onClick: () => openPerson(p) }),
    button('Delete', { variant: 'ghost-danger', size: 'sm', onClick: () => void removePerson(p) }),
  );
}

function loanCard(l: Loan): HTMLElement {
  const isSettled = settled(l);
  const payForm = h('form', { class: 'form-inline' },
    h('label', { class: 'field' }, h('span', null, 'Amount (₹)'),
      h('input', { name: 'amount', type: 'text', inputmode: 'decimal', 'data-money': '', autocomplete: 'off', required: true, placeholder: '0.00' }),
      h('span', { class: 'field-error' })),
    h('label', { class: 'field' }, h('span', null, 'Date'), h('input', { name: 'date', type: 'date', required: true, value: today() }), h('span', { class: 'field-error' })),
    button(l.direction === 'lent' ? 'Record repayment' : 'Record payment', { type: 'submit' }),
  );
  bindForm(payForm, async (v) => {
    await post(`/loans/${l.id}/payments`, { amount: parseMoney(v.amount ?? ''), date: v.date });
    toast('Payment recorded');
    await load();
  });

  const payments = l.payments.length
    ? h('ul', { class: 'plain-list small' },
        ...l.payments.map((p) =>
          h('li', { class: 'row' },
            h('span', { class: 'muted num' }, fmtDate(p.date)),
            h('span', { class: 'num' }, inr(p.amount)),
            h('span', { class: 'spacer' }),
            button('×', { variant: 'ghost', size: 'sm', icon: true, ariaLabel: `Delete payment of ${inr(p.amount)}`, onClick: () => void removePayment(l, p.id) }),
          ),
        ),
      )
    : null;

  return h('article', { class: 'card stack-sm' },
    h('div', { class: 'card-head' },
      h('h2', null, l.title),
      h('span', { class: 'badge' }, l.direction === 'lent' ? `Lent to ${l.person_name}` : `Borrowed from ${l.person_name}`),
      isSettled && h('span', { class: 'badge badge-positive' }, 'Settled'),
      h('span', { class: 'spacer' }),
      button('Edit', { variant: 'ghost', size: 'sm', onClick: () => openLoan(l) }),
      button('Delete', { variant: 'ghost-danger', size: 'sm', onClick: () => void removeLoan(l) }),
    ),
    h('p', { class: 'muted small' },
      `${inr(l.amount)} on ${fmtDate(l.date)} · paid back ${inr(l.paid)} · `,
      h('strong', { class: isSettled ? 'income' : 'spend' }, `${inr(Math.max(0, l.outstanding))} outstanding`),
    ),
    l.note && h('p', { class: 'small' }, l.note),
    payments,
    !isSettled && payForm,
  );
}

function openLoan(l: Loan | null) {
  if (!people.length) {
    toast('Add a person first', 'error');
    personForm.querySelector('input')?.focus();
    return;
  }
  editingLoan = l;
  loanForm.reset();
  clearErrors(loanForm);
  $('#loan-dialog-title').textContent = l ? 'Edit loan' : 'Add loan';
  replace($('#loan-person'), ...people.map((p) => h('option', { value: p.id }, p.name)));
  setValues(loanForm, {
    person_id: l?.person_id ?? people[0]?.id,
    direction: l?.direction ?? 'lent',
    title: l?.title ?? '',
    amount: l ? moneyInput(l.amount) : '',
    date: l?.date ?? today(),
    note: l?.note ?? '',
  });
  openDialog(loanDialog);
}

function openPerson(p: Person) {
  editingPerson = p;
  personEdit.reset();
  clearErrors(personEdit);
  setValues(personEdit, { name: p.name, note: p.note ?? '' });
  openDialog(personDialog);
}

bindForm(loanForm, async (v) => {
  const body = { person_id: Number(v.person_id), direction: v.direction, title: v.title, amount: parseMoney(v.amount ?? ''), date: v.date, note: v.note || null };
  if (editingLoan) await put(`/loans/${editingLoan.id}`, body);
  else await post('/loans', body);
  loanDialog.close();
  toast(editingLoan ? 'Loan updated' : 'Loan added');
  await load();
});

bindForm(personEdit, async (v) => {
  if (!editingPerson) return;
  await put(`/people/${editingPerson.id}`, { name: v.name, note: v.note || null });
  personDialog.close();
  toast('Person updated');
  await load();
});

bindForm(personForm, async (v) => {
  await post('/people', { name: v.name });
  personForm.reset();
  await load();
});

async function softRemove(path: string, message: string) {
  try {
    await del(path);
  } catch (err) {
    toast(errorMessage(err), 'error');
    return;
  }
  await load();
  undoToast(message, async () => {
    await post(`${path}/restore`, {});
    await load();
  });
}

const removeLoan = (l: Loan) => softRemove(`/loans/${l.id}`, `Deleted "${l.title}"`);
const removePayment = (l: Loan, id: number) => softRemove(`/loans/${l.id}/payments/${id}`, 'Payment deleted');
const removePerson = (p: Person) => softRemove(`/people/${p.id}`, `Deleted ${p.name} and their loans`);

$('#add-loan').addEventListener('click', () => openLoan(null));
bindTabs($('#loan-tabs'), (value) => {
  view = value;
  render();
});

void load();
