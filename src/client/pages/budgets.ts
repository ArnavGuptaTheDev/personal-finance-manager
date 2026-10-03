import { del, get, post, put } from '../api';
import { barList } from '../charts';
import { $, errorMessage, h, replace } from '../dom';
import { fmtMonth, inr, moneyInput, parseMoney, qs, today } from '../format';
import { loadCategories } from '../shell';
import type { Budget } from '../types';
import { button } from '../ui/button';
import { bindForm, setValues } from '../ui/form';
import { emptyState, errorState } from '../ui/table';
import { toast, undoToast } from '../ui/toast';

const monthInput = $<HTMLInputElement>('#month');
const form = $<HTMLFormElement>('#budget-form');
monthInput.value = today().slice(0, 7);

async function load() {
  const month = monthInput.value || today().slice(0, 7);
  $('#budget-title').textContent = fmtMonth(month);
  let items: Budget[];
  try {
    items = (await get<{ items: Budget[] }>(`/budgets${qs({ month })}`)).items;
  } catch (err) {
    replace($('#budget-list'), errorState(errorMessage(err), () => void load()));
    return;
  }

  if (!items.length) {
    replace($('#budget-list'), emptyState('No budgets yet. Add one above.'));
    return;
  }
  const totalBudget = items.reduce((s, b) => s + b.amount, 0);
  const totalSpent = items.reduce((s, b) => s + b.spent, 0);

  const list = barList(
    items.map((b) => ({
      label: b.name,
      value: b.spent,
      max: b.amount,
      note: `${inr(b.spent)} of ${inr(b.amount)}${b.spent > b.amount ? ` · over by ${inr(b.spent - b.amount)}` : ''}`,
    })),
  );
  [...list.children].forEach((li, i) => {
    const b = items[i]!;
    li.querySelector('.bar-row')?.append(
      h('span', { class: 'row' },
        button('Edit', {
          variant: 'ghost',
          size: 'sm',
          onClick: () => {
            setValues(form, { category_id: b.category_id, amount: moneyInput(b.amount) });
            form.querySelector<HTMLInputElement>('[name=amount]')?.focus();
          },
        }),
        button('Remove', { variant: 'ghost-danger', size: 'sm', onClick: () => void remove(b) }),
      ),
    );
  });

  replace($('#budget-list'), h('p', { class: 'muted small' }, `Spent ${inr(totalSpent)} of ${inr(totalBudget)} budgeted.`), list);
}

async function remove(b: Budget) {
  try {
    await del(`/budgets/${b.id}`);
  } catch (err) {
    toast(errorMessage(err), 'error');
    return;
  }
  await load();
  undoToast(`Removed the ${b.name} budget`, async () => {
    await post(`/budgets/${b.id}/restore`, {});
    await load();
  });
}

bindForm(form, async (v) => {
  await put('/budgets', { category_id: Number(v.category_id), amount: parseMoney(v.amount ?? '') });
  toast('Budget saved');
  setValues(form, { amount: '' });
  await load();
});

monthInput.addEventListener('change', () => void load());

loadCategories()
  .then((cats) => replace($('#budget-category'), ...cats.filter((c) => c.kind === 'expense').map((c) => h('option', { value: c.id }, c.name))))
  .catch((err) => toast(errorMessage(err), 'error'));
void load();
