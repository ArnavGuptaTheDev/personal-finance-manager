import { del, patch, post } from '../api';
import { $, errorMessage, h, replace } from '../dom';
import { loadCategories } from '../shell';
import type { Category, CategoryKind } from '../types';
import { button } from '../ui/button';
import { bindForm, clearErrors, setFieldError, setValues } from '../ui/form';
import { openDialog } from '../ui/modal';
import { emptyState, errorState } from '../ui/table';
import { toast, undoToast } from '../ui/toast';

const form = $<HTMLFormElement>('#cat-form');
const list = $('#cat-list');
const search = $<HTMLInputElement>('#cat-search');
const editDialog = $<HTMLDialogElement>('#cat-dialog');
const editForm = $<HTMLFormElement>('#cat-edit');
const KIND_LABEL = { expense: 'Expense', income: 'Income', transfer: 'Transfer' } as const;

let categories: Category[] = [];
let editing: Category | null = null;
const open = new Set<number>();

async function load() {
  try {
    categories = await loadCategories(true);
  } catch (err) {
    replace(list, errorState(errorMessage(err), () => void load()));
    return;
  }
  // Own categories first, then built-in.
  categories.sort((a, b) => Number(a.builtin) - Number(b.builtin));
  render();
}

function matches(cat: Category, q: string) {
  if (!q) return true;
  return cat.name.toLowerCase().includes(q) || cat.keywords.some((k) => (k.keyword ?? k.regex ?? '').toLowerCase().includes(q));
}

function render() {
  const q = search.value.trim().toLowerCase();
  const shown = categories.filter((c) => matches(c, q));
  if (!shown.length) {
    replace(list, emptyState(q ? 'No categories or rules match your search.' : 'No categories yet.'));
    return;
  }
  // While searching, open the matching cards so the matching rules are visible.
  replace(list, ...shown.map((c) => card(c, Boolean(q))));
}

function rerender(cat: Category) {
  const i = categories.findIndex((c) => c.id === cat.id);
  if (i >= 0) categories[i] = cat;
  list.querySelector(`[data-id="${cat.id}"]`)?.replaceWith(card(cat, Boolean(search.value.trim())));
}

function card(cat: Category, forceOpen: boolean): HTMLElement {
  const own = cat.keywords.filter((k) => !k.builtin).length;
  const chips = h('div', { class: 'chips' },
    ...cat.keywords.map((k) => {
      const text = k.keyword ?? `/${k.regex}/`;
      if (k.builtin) return h('span', { class: 'badge', title: 'Built-in rule' }, text);
      const x = h('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove rule ${text}` }, '×');
      x.addEventListener('click', () => void removeRule(cat, k.id, text));
      return h('span', { class: 'badge badge-brand' }, text, x);
    }),
  );

  const kwForm = h('form', { class: 'row kw-form' },
    h('label', { class: 'field kw-field' },
      h('span', { class: 'visually-hidden' }, `New rule for ${cat.name}`),
      h('input', { name: 'value', placeholder: 'Add keyword, or /regex/', maxlength: 200, required: true }),
      h('span', { class: 'field-error' }),
    ),
    button('Add', { size: 'sm', type: 'submit' }),
  );
  bindForm(kwForm, async (v) => {
    const raw = v.value ?? '';
    const isRegex = raw.length > 2 && raw.startsWith('/') && raw.endsWith('/');
    try {
      const k = await post<Category['keywords'][number]>(`/categories/${cat.id}/keywords`, isRegex ? { regex: raw.slice(1, -1) } : { keyword: raw });
      open.add(cat.id);
      rerender({ ...cat, keywords: [...cat.keywords, k] });
      toast('Rule added');
    } catch (err) {
      // Every rule error (too short, invalid regex, ...) belongs to this one input.
      const input = kwForm.querySelector('input')!;
      setFieldError(input, errorMessage(err).replace(/^(keyword|regex): /, ''));
      input.focus();
    }
  });

  const actions = cat.builtin
    ? null
    : h('div', { class: 'row row-end' },
        button('Edit', { variant: 'ghost', size: 'sm', onClick: () => openEditor(cat) }),
        button('Delete', { variant: 'ghost-danger', size: 'sm', onClick: () => void removeCategory(cat) }),
      );

  const details = h('details', { class: 'card collapse', 'data-id': cat.id, open: forceOpen || open.has(cat.id) },
    h('summary', null,
      h('h2', null, cat.name),
      h('span', { class: 'badge' }, KIND_LABEL[cat.kind]),
      cat.builtin && h('span', { class: 'badge' }, 'Built-in'),
      h('span', { class: 'muted small' }, `${cat.keywords.length} rule${cat.keywords.length === 1 ? '' : 's'}${own ? ` · ${own} yours` : ''}`),
    ),
    h('div', { class: 'stack-sm cat-body' },
      cat.keywords.length ? chips : h('p', { class: 'muted small' }, 'No rules yet.'),
      kwForm,
      actions,
    ),
  );
  details.addEventListener('toggle', () => {
    if (details.open) open.add(cat.id);
    else open.delete(cat.id);
  });
  return details;
}

async function removeRule(cat: Category, id: number, text: string) {
  try {
    await del(`/categories/keywords/${id}`);
  } catch (err) {
    toast(errorMessage(err), 'error');
    return;
  }
  const before = cat;
  rerender({ ...cat, keywords: cat.keywords.filter((k) => k.id !== id) });
  undoToast(`Removed rule "${text}"`, async () => {
    await post(`/categories/keywords/${id}/restore`, {});
    rerender(before);
  });
}

async function removeCategory(cat: Category) {
  try {
    await del(`/categories/${cat.id}`);
  } catch (err) {
    toast(errorMessage(err), 'error');
    return;
  }
  categories = categories.filter((c) => c.id !== cat.id);
  render();
  undoToast(`Deleted "${cat.name}"; its transactions are Uncategorized`, async () => {
    await post(`/categories/${cat.id}/restore`, {});
    await load();
  });
}

function openEditor(cat: Category) {
  editing = cat;
  editForm.reset();
  clearErrors(editForm);
  setValues(editForm, { name: cat.name, kind: cat.kind });
  openDialog(editDialog);
}

bindForm(editForm, async (v) => {
  if (!editing) return;
  const updated = await patch<{ id: number; name: string; kind: CategoryKind }>(`/categories/${editing.id}`, { name: v.name, kind: v.kind });
  rerender({ ...editing, name: updated.name, kind: updated.kind });
  editDialog.close();
  toast('Category updated');
});

bindForm(form, async (v) => {
  const created = await post<Category>('/categories', { name: v.name, kind: v.kind });
  toast('Category added');
  form.reset();
  open.add(created.id);
  await load();
});

search.addEventListener('input', render);
$('#toggle-all').addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  const expand = btn.textContent === 'Expand all';
  for (const c of categories) {
    if (expand) open.add(c.id);
    else open.delete(c.id);
  }
  list.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => (d.open = expand));
  btn.textContent = expand ? 'Collapse all' : 'Expand all';
});

void load();
