// Table and list rendering with shared empty, loading and error states. Cells carry
// data-label/data-cell so .table-cards can stack rows into cards on phones.
import { h, replace } from '../dom';
import { button } from './button';

type Child = Node | string | number | null | undefined | false;
export type CellRole = 'check' | 'primary' | 'amount' | 'meta' | 'actions';
type CellOptions = { label?: string; role?: CellRole; class?: string; colspan?: number };

export function td(opts: CellOptions, ...children: Child[]): HTMLTableCellElement {
  return h('td', { class: opts.class, 'data-label': opts.label, 'data-cell': opts.role, colspan: opts.colspan }, ...children);
}

export function emptyState(text: string, action?: HTMLElement): HTMLElement {
  return h('div', { class: 'empty' }, h('p', { class: 'small' }, text), action ?? null);
}

export function errorState(message: string, retry?: () => void): HTMLElement {
  return h('div', { class: 'empty error-state', role: 'alert' },
    h('p', { class: 'small' }, `Couldn't load this: ${message}`),
    retry ? button('Try again', { size: 'sm', onClick: retry }) : null,
  );
}

const wide = (colspan: number, child: Node) => h('tr', null, td({ colspan }, child));

export function renderTable<T>(
  tbody: HTMLElement,
  items: T[],
  row: (item: T) => HTMLTableRowElement,
  opts: { colspan: number; empty: string | HTMLElement },
) {
  if (!items.length) {
    replace(tbody, wide(opts.colspan, typeof opts.empty === 'string' ? emptyState(opts.empty) : opts.empty));
    return;
  }
  replace(tbody, ...items.map(row));
}

export function renderList<T>(list: HTMLElement, items: T[], item: (x: T) => HTMLElement, empty: string | HTMLElement) {
  if (!items.length) {
    replace(list, typeof empty === 'string' ? emptyState(empty) : empty);
    return;
  }
  replace(list, ...items.map(item));
}

export function skeletonRows(tbody: HTMLElement, colspan: number, count = 6) {
  replace(tbody, ...Array.from({ length: count }, () => wide(colspan, h('span', { class: 'skeleton skeleton-row' }))));
}

export function tableError(tbody: HTMLElement, colspan: number, message: string, retry?: () => void) {
  replace(tbody, wide(colspan, errorState(message, retry)));
}
