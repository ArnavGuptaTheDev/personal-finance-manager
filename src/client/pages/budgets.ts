import { del, get, put } from '../api';
import { barList } from '../charts';
import { $, emptyState, errorMessage, formValues, h, replace, run, toast } from '../dom';
import { fmtMonth, inr, today } from '../format';
import { loadCategories } from '../shell';
import type { Budget } from '../types';

const monthInput = $<HTMLInputElement>('#month');
const form = $<HTMLFormElement>('#budget-form');
monthInput.value = today().slice(0, 7);

async function load() {
  const month = monthInput.value || today().slice(0, 7);
  const { items } = await get<{ items: Budget[] }>(`/budgets?month=${month}`);
  $('#budget-title').textContent = fmtMonth(month);

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
  // Add a remove button to each row.
  [...list.children].forEach((li, i) => {
    const b = items[i]!;
    const remove = h('button', { class: 'btn btn-ghost btn-sm btn-danger', type: 'button' }, 'Remove');
    remove.addEventListener('click', () =>
      run(remove, async () => {
        if (!confirm(`Remove the ${b.name} budget?`)) return;
        await del(`/budgets/${b.id}`);
        toast('Budget removed');
        await load();
      }),
    );
    li.querySelector('.bar-row')?.append(remove);
  });

  replace(
    $('#budget-list'),
    h('p', { class: 'muted' }, `Spent ${inr(totalSpent)} of ${inr(totalBudget)} budgeted.`),
    list,
  );
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(form);
  run($<HTMLButtonElement>('#budget-save'), async () => {
    await put('/budgets', { category_id: Number(v.category_id), amount: Number(v.amount) });
    toast('Budget saved');
    form.reset();
    await load();
  });
});

monthInput.addEventListener('change', () => load().catch((err) => toast(errorMessage(err), 'error')));

(async () => {
  try {
    const categories = (await loadCategories()).filter((c) => c.kind === 'expense');
    replace($('#budget-category'), ...categories.map((c) => h('option', { value: c.id }, c.name)));
    await load();
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
})();
