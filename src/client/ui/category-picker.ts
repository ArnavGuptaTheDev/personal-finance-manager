// Category type-ahead, as a form field (hidden category_id + text box) or as a
// one-off "Set category" dialog. Recently used categories are listed first; their
// ids (no names or amounts) are kept in sessionStorage for this tab only.
import { h } from '../dom';
import type { Category } from '../types';
import { button } from './button';
import { createDialog } from './modal';
import { type Option, typeahead } from './typeahead';

const RECENT_KEY = 'pfm.recentCategories';
const NONE: Option = { value: '', label: 'Uncategorized' };

export function recentCategoryIds(): number[] {
  try {
    return (JSON.parse(sessionStorage.getItem(RECENT_KEY) ?? '[]') as number[]).filter(Number.isInteger);
  } catch {
    return [];
  }
}

export function rememberCategory(id: number | null) {
  if (id == null) return;
  try {
    sessionStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentCategoryIds().filter((x) => x !== id)].slice(0, 6)));
  } catch {
    /* storage disabled */
  }
}

export function categoryOptionsList(categories: Category[]): Option[] {
  const recent = recentCategoryIds();
  const rank = (c: Category) => (recent.includes(c.id) ? recent.indexOf(c.id) : 100);
  return [
    ...[...categories].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map((c) => ({ value: String(c.id), label: c.name, hint: recent.includes(c.id) ? 'Recent' : undefined })),
    NONE,
  ];
}

/**
 * Turns a field (text input + hidden category_id input in the same .field) into a
 * type-ahead. Returns a setter for the current category.
 */
export function categoryField(field: HTMLElement, getCategories: () => Category[]) {
  const text = field.querySelector<HTMLInputElement>('input[data-typeahead]')!;
  const hidden = field.querySelector<HTMLInputElement>('input[type=hidden]')!;
  const labelFor = (id: string) => getCategories().find((c) => String(c.id) === id)?.name ?? NONE.label;
  typeahead(text, () => categoryOptionsList(getCategories()), (o) => (hidden.value = o.value));
  // Typed text that was never picked: keep an exact match, otherwise go back to the last pick.
  text.addEventListener('change', () => {
    const exact = categoryOptionsList(getCategories()).find((o) => o.label.toLowerCase() === text.value.trim().toLowerCase());
    if (exact) hidden.value = exact.value;
    text.value = labelFor(hidden.value);
  });
  return (id: number | null) => {
    hidden.value = id == null ? '' : String(id);
    text.value = labelFor(hidden.value);
  };
}

/** Resolves the chosen category id (null = Uncategorized), or undefined if cancelled. */
export function pickCategory(categories: Category[], title = 'Set category'): Promise<number | null | undefined> {
  return new Promise((resolve) => {
    let result: number | null | undefined;
    const input = h('input', { 'aria-label': 'Category', placeholder: 'Type a category' });
    const cancel = button('Cancel');
    cancel.dataset.close = '';
    const dialog = createDialog('dialog-sm picker',
      h('div', { class: 'form' },
        h('h2', null, title),
        h('div', { class: 'typeahead' }, input),
        h('p', { class: 'muted small' }, '↑ ↓ to choose, Enter to set, Esc to cancel.'),
        h('div', { class: 'form-actions' }, cancel),
      ),
    );
    typeahead(input, () => categoryOptionsList(categories), (o) => {
      result = o.value ? Number(o.value) : null;
      rememberCategory(result);
      dialog.close();
    });
    dialog.addEventListener('close', () => resolve(result));
    dialog.showModal();
    input.focus();
  });
}
