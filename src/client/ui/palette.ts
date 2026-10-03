// Command palette (Ctrl/Cmd+K) and the shortcut help overlay (?). Both dialogs are
// built once on first use; categories come from the cached /categories request.
import { h, replace } from '../dom';
import type { Category } from '../types';
import { recentCategoryIds, rememberCategory } from './category-picker';
import { keyLabel, keymap } from './keys';
import { bindDialog, createDialog } from './modal';

export type Command = { label: string; group: string; hint?: string; run: () => void };

const commands: Command[] = [];
const sources: (() => Command[])[] = [];
let categorySource: (() => Promise<Category[]>) | null = null;

export function addCommands(...c: Command[]) {
  commands.push(...c);
}
/** Commands worked out when the palette opens (e.g. pages the user can see). */
export function addCommandSource(source: () => Command[]) {
  sources.push(source);
}
export function setCategorySource(load: () => Promise<Category[]>) {
  categorySource = load;
}

/** Subsequence match: "nwtrn" finds "New transaction". Lower score = better. */
export function fuzzyScore(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const at = l.indexOf(q);
  if (at >= 0) return at === 0 ? 0 : 1 + at / 100;
  let i = 0;
  let gaps = 0;
  for (const ch of q) {
    const next = l.indexOf(ch, i);
    if (next < 0) return null;
    gaps += next - i;
    i = next + 1;
  }
  return 10 + gaps;
}

function categoryCommands(cats: Category[]): Command[] {
  const recent = recentCategoryIds();
  return cats.map((c) => ({
    label: `${c.name}`,
    group: recent.includes(c.id) ? 'Recent categories' : 'Categories',
    hint: 'Show transactions',
    run: () => {
      rememberCategory(c.id);
      location.href = `/app/transactions/?category=${c.id}`;
    },
  }));
}

let palette: { dialog: HTMLDialogElement; input: HTMLInputElement; list: HTMLElement } | null = null;
let categoryList: Command[] = [];

export function openPalette() {
  if (!palette) {
    const input = h('input', { type: 'text', class: 'palette-input', placeholder: 'Go to a page, run an action, find a category…', 'aria-label': 'Command', role: 'combobox', 'aria-controls': 'palette-list', 'aria-expanded': 'true', autocomplete: 'off' });
    const list = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
    // Kept in the page after closing, so re-opening is instant.
    const dialog = bindDialog(h('dialog', { class: 'palette', 'aria-label': 'Command palette' }, input, list));
    document.body.append(dialog);
    palette = { dialog, input, list };
    wire(palette);
  }
  palette.input.value = '';
  render(palette, '');
  palette.dialog.showModal();
  palette.input.focus();
  if (categorySource && !categoryList.length) {
    void categorySource().then((cats) => {
      categoryList = categoryCommands(cats);
      if (palette?.dialog.open) render(palette, palette.input.value);
    }, () => undefined);
  }
}

let shown: Command[] = [];
let active = 0;

function render(p: NonNullable<typeof palette>, query: string) {
  const pool = [...sources.flatMap((s) => s()), ...commands, ...categoryList];
  const scored = pool
    .map((c) => ({ c, s: fuzzyScore(c.label, query) }))
    .filter((x): x is { c: Command; s: number } => x.s !== null);
  // With no query: actions and pages, then recent categories. With a query: best match first.
  shown = (query ? scored.sort((a, b) => a.s - b.s) : scored.filter((x) => x.c.group !== 'Categories')).map((x) => x.c).slice(0, 12);
  active = 0;
  paint(p);
}

function paint(p: NonNullable<typeof palette>) {
  let lastGroup = '';
  const items: HTMLElement[] = [];
  shown.forEach((c, i) => {
    if (c.group !== lastGroup) {
      items.push(h('li', { class: 'palette-group', role: 'presentation' }, c.group));
      lastGroup = c.group;
    }
    items.push(h('li', { role: 'option', id: `palette-${i}`, 'data-i': i, 'aria-selected': i === active ? 'true' : 'false' }, c.label, c.hint ? h('span', { class: 'cell-sub' }, c.hint) : null));
  });
  if (!items.length) items.push(h('li', { class: 'palette-group', role: 'presentation' }, 'No matches'));
  replace(p.list, ...items);
  p.input.setAttribute('aria-activedescendant', `palette-${active}`);
  p.list.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
}

function wire(p: NonNullable<typeof palette>) {
  p.input.addEventListener('input', () => render(p, p.input.value));
  p.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      paint(p);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = shown[active];
      if (c) {
        p.dialog.close();
        c.run();
      }
    }
  });
  p.list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    const c = li && shown[Number(li.dataset.i)];
    if (c) {
      p.dialog.close();
      c.run();
    }
  });
}

/** Keys that work inside dialogs and forms; listed in the help overlay too. */
const DIALOG_KEYS: [string, string][] = [
  ['Enter', 'Save the open form'],
  ['Ctrl + Enter', 'Save and add another (new transaction)'],
  ['Esc', 'Close the dialog or list without saving'],
  ['↑ ↓ then Enter', 'Pick from a category list or the palette'],
];

export function openHelp() {
  const groups = new Map<string, HTMLElement[]>();
  for (const b of keymap.list()) {
    const rows = groups.get(b.group) ?? [];
    rows.push(h('tr', null, h('td', null, h('kbd', null, keyLabel(b.keys))), h('td', null, b.description)));
    groups.set(b.group, rows);
  }
  groups.set('In dialogs', DIALOG_KEYS.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d))));

  const close = h('button', { class: 'btn', type: 'button', 'data-close': '' }, 'Close');
  const dialog = createDialog('help',
    h('h2', null, 'Keyboard shortcuts'),
    h('p', { class: 'muted small' }, 'Shortcuts are off while you type in a field or while a dialog is open.'),
    ...[...groups].map(([group, rows]) => h('section', { class: 'help-group' }, h('h3', null, group), h('table', null, h('tbody', null, ...rows)))),
    h('div', { class: 'form-actions' }, close),
  );
  dialog.showModal();
  close.focus();
}
