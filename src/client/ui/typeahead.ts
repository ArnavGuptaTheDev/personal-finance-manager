// Accessible combobox: type to filter, ↑/↓ to move, Enter to pick, Esc to close the list.
import { h, replace } from '../dom';

export type Option = { value: string; label: string; hint?: string };

let uid = 0;

/** Options whose label starts with the query first, then those containing it. */
export function filterOptions(options: Option[], query: string, limit = 8): Option[] {
  const q = query.trim().toLowerCase();
  if (!q) return options.slice(0, limit);
  const starts = options.filter((o) => o.label.toLowerCase().startsWith(q));
  const contains = options.filter((o) => !o.label.toLowerCase().startsWith(q) && o.label.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

export function typeahead(input: HTMLInputElement, getOptions: () => Option[], onPick: (o: Option) => void) {
  const id = `ta-${++uid}`;
  const list = h('ul', { class: 'typeahead-list', role: 'listbox', id, hidden: true });
  input.after(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';

  let shown: Option[] = [];
  let active = 0;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const paint = () => {
    replace(
      list,
      ...shown.map((o, i) =>
        h('li', { role: 'option', id: `${id}-${i}`, 'aria-selected': i === active ? 'true' : 'false', 'data-i': i },
          o.label,
          o.hint ? h('span', { class: 'cell-sub' }, o.hint) : null,
        ),
      ),
    );
    if (shown.length) input.setAttribute('aria-activedescendant', `${id}-${active}`);
    list.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  };

  const openList = () => {
    shown = filterOptions(getOptions(), input.value);
    active = 0;
    list.hidden = shown.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    paint();
  };

  const pick = (o: Option | undefined) => {
    if (!o) return;
    input.value = o.label;
    close();
    onPick(o);
  };

  input.addEventListener('input', openList);
  input.addEventListener('focus', () => {
    input.select();
    openList();
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      openList();
      e.preventDefault();
      return;
    }
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape') {
      // Close the list only; a second Esc closes the dialog.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (li) pick(shown[Number(li.dataset.i)]);
  });

  return { close, open: openList };
}
