// Tiny DOM helpers. Text is always inserted as text nodes (never innerHTML), so
// bank descriptions or names containing markup can't inject scripts.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(value);
    } else if (key === 'checked' || key === 'selected' || key === 'disabled') {
      (el as unknown as Record<string, boolean>)[key] = Boolean(value);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function replace(parent: Element, ...children: Child[]) {
  parent.replaceChildren();
  append(parent, ...children);
}

export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

/** Read a form into a plain object of trimmed strings. */
export function formValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(form).forEach((v, k) => {
    if (typeof v === 'string') out[k] = v.trim();
  });
  return out;
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.dataset.kind = kind;
  el.dataset.show = 'true';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el && (el.dataset.show = 'false'), 3500);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Wrap an async UI action: disables the button while running and toasts errors. */
export async function run(button: HTMLButtonElement | null, fn: () => Promise<void>) {
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

export function emptyState(text: string) {
  return h('p', { class: 'empty' }, text);
}

export function categoryOptions(
  categories: { id: number; name: string }[],
  selected: number | null,
  noneLabel = 'Uncategorized',
): HTMLOptionElement[] {
  return [
    h('option', { value: '', selected: selected == null }, noneLabel),
    ...categories.map((c) => h('option', { value: c.id, selected: c.id === selected }, c.name)),
  ];
}
