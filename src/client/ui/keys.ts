// One shortcut manager for the whole app. Shortcuts never fire while focus is in a
// text field, select or contenteditable, or while a dialog is open (dialogs handle
// their own keys; Esc closes them natively).

export type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };
export type TargetLike = { tagName?: string; isContentEditable?: boolean; type?: string } | null;

export type Binding = {
  /** "mod+k", "g d" (a sequence), "?", "/", "j", "arrowdown"… */
  keys: string;
  description: string;
  group: string;
  run: () => void;
  /** Only active while this returns true (e.g. on one page). */
  when?: () => boolean;
  /** Listed in the help overlay under another binding's line (e.g. arrows as an alias of j). */
  hidden?: boolean;
};

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/** True when keys typed now belong to a form control, not to shortcuts. */
export function isTypingTarget(el: TargetLike): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return !NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase());
  return false;
}

/** "mod+k", "?", "j", "arrowdown". Shift is folded into printable keys ("?" not "shift+/"). */
export function normalizeKey(e: KeyLike): string {
  const key = e.key.toLowerCase();
  const mods = [(e.ctrlKey || e.metaKey) && 'mod', e.altKey && 'alt', e.shiftKey && e.key.length > 1 && 'shift'].filter(Boolean);
  return [...mods, key].join('+');
}

const SEQUENCE_MS = 1000;

/** DOM-free core, so the rules above are unit-testable. */
export function createKeymap() {
  const bindings: Binding[] = [];
  let pending: { first: string; at: number } | null = null;

  function handle(e: KeyLike, ctx: { typing: boolean; modalOpen: boolean; now?: number }): Binding | null {
    if (ctx.typing || ctx.modalOpen) {
      pending = null;
      return null;
    }
    const key = normalizeKey(e);
    if (['control', 'meta', 'alt', 'shift'].includes(e.key.toLowerCase())) return null;
    const now = ctx.now ?? Date.now();
    const active = bindings.filter((b) => !b.when || b.when());

    if (pending && now - pending.at <= SEQUENCE_MS) {
      const seq = `${pending.first} ${key}`;
      pending = null;
      const hit = active.find((b) => b.keys === seq);
      if (hit) return hit;
    }
    pending = null;

    const hit = active.find((b) => b.keys === key);
    if (hit) return hit;
    if (active.some((b) => b.keys.startsWith(`${key} `))) pending = { first: key, at: now };
    return null;
  }

  return {
    add(...b: Binding[]) {
      bindings.push(...b);
    },
    // Every binding registered on this page, whether or not it applies right now.
    list: () => bindings.filter((b) => !b.hidden),
    handle,
  };
}

export const keymap = createKeymap();

/** Starts listening on the document (call once, from the shell). */
export function listen() {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const hit = keymap.handle(e, {
      typing: isTypingTarget(e.target as HTMLElement | null),
      modalOpen: Boolean(document.querySelector('dialog[open]')),
    });
    if (hit) {
      e.preventDefault();
      hit.run();
    }
  });
}

/** How a binding is written in the help overlay. */
export function keyLabel(keys: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return keys
    .split(' ')
    .map((k) =>
      k
        .replace('mod', mac ? '⌘' : 'Ctrl')
        .replace('arrowdown', '↓')
        .replace('arrowup', '↑')
        .replace('enter', 'Enter')
        .replace(/\+/g, ' + ')
        .replace(/(^| )([a-z])$/, (_, sp: string, c: string) => sp + c.toUpperCase()),
    )
    .join(' then ');
}
