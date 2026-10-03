// Native <dialog> helpers. Dialogs close on Esc (native), on [data-close]
// buttons and on a click on the backdrop.
import { h } from '../dom';

const bound = new WeakSet<HTMLDialogElement>();

export function bindDialog(dialog: HTMLDialogElement) {
  if (bound.has(dialog)) return dialog;
  bound.add(dialog);
  dialog.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === dialog || target.closest('[data-close]')) dialog.close();
  });
  return dialog;
}

export function openDialog(dialog: HTMLDialogElement) {
  bindDialog(dialog).showModal();
  const first = dialog.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]):not([disabled]), select, textarea');
  first?.focus();
}

/** A dialog built in script (for one-off dialogs such as confirmations). */
export function createDialog(className = 'dialog-sm', ...children: Node[]): HTMLDialogElement {
  const dialog = h('dialog', { class: className }, ...children);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  return bindDialog(dialog);
}
