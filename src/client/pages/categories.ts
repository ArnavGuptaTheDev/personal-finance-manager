import { del, post } from '../api';
import { $, errorMessage, formValues, h, replace, run, toast } from '../dom';
import { loadCategories } from '../shell';
import type { Category } from '../types';

const form = $<HTMLFormElement>('#cat-form');
const KIND_LABEL = { expense: 'Expense', income: 'Income', transfer: 'Transfer' } as const;

async function load() {
  const categories = await loadCategories(true);
  // Own categories first, then built-in.
  categories.sort((a, b) => Number(a.builtin) - Number(b.builtin));
  replace($('#cat-list'), ...categories.map(card));
}

function card(cat: Category): HTMLElement {
  const chips = h('div', { class: 'chips' },
    ...cat.keywords.map((k) => {
      const text = k.keyword ?? `/${k.regex}/`;
      if (k.builtin) return h('span', { class: 'badge', title: 'Built-in rule' }, text);
      const x = h('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove ${text}` }, '×');
      x.addEventListener('click', () =>
        run(x, async () => {
          await del(`/categories/keywords/${k.id}`);
          toast('Rule removed');
          await load();
        }),
      );
      return h('span', { class: 'badge badge-own' }, text, x);
    }),
  );

  const kwForm = h('form', { class: 'row kw-form' },
    h('input', { name: 'value', placeholder: 'Add keyword, or /regex/', maxlength: 200, required: true, 'aria-label': 'New rule' }),
    h('button', { class: 'btn btn-sm', type: 'submit' }, 'Add'),
  );
  kwForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = formValues(kwForm).value ?? '';
    const isRegex = raw.length > 2 && raw.startsWith('/') && raw.endsWith('/');
    run(kwForm.querySelector('button'), async () => {
      await post(`/categories/${cat.id}/keywords`, isRegex ? { regex: raw.slice(1, -1) } : { keyword: raw });
      toast('Rule added');
      await load();
    });
  });

  let remove: HTMLButtonElement | null = null;
  if (!cat.builtin) {
    remove = h('button', { class: 'btn btn-ghost btn-sm btn-danger', type: 'button' }, 'Delete');
    remove.addEventListener('click', () =>
      run(remove, async () => {
        if (!confirm(`Delete "${cat.name}"? Its transactions become Uncategorized.`)) return;
        await del(`/categories/${cat.id}`);
        toast('Category deleted');
        await load();
      }),
    );
  }

  return h('article', { class: 'card stack' },
    h('div', { class: 'row' },
      h('h2', null, cat.name),
      h('span', { class: 'badge' }, KIND_LABEL[cat.kind]),
      cat.builtin && h('span', { class: 'badge' }, 'Built-in'),
      h('span', { class: 'spacer' }),
      remove,
    ),
    cat.keywords.length ? chips : h('p', { class: 'muted small' }, 'No rules yet.'),
    kwForm,
  );
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(form);
  run($<HTMLButtonElement>('#cat-save'), async () => {
    await post('/categories', { name: v.name, kind: v.kind });
    toast('Category added');
    form.reset();
    await load();
  });
});

load().catch((err) => toast(errorMessage(err), 'error'));
