// Styled replacement for window.confirm()/prompt(). Resolves true only when the
// person confirms; Esc, Cancel or a backdrop click resolve false.
import { h } from '../dom';
import { button } from './button';
import { createDialog } from './modal';

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Require typing this exact text (case-insensitive) before confirming. */
  typeToConfirm?: string;
};

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let confirmed = false;
    const ok = button(opts.confirmLabel ?? 'Confirm', { variant: opts.danger ? 'danger' : 'primary', type: 'submit' });
    const cancel = button('Cancel', { type: 'button' });
    cancel.dataset.close = '';

    let typed: HTMLInputElement | null = null;
    if (opts.typeToConfirm) {
      typed = h('input', { autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${opts.typeToConfirm} to confirm` });
      ok.disabled = true;
      const expected = opts.typeToConfirm.toLowerCase();
      typed.addEventListener('input', () => (ok.disabled = typed!.value.trim().toLowerCase() !== expected));
    }

    const form = h('form', { class: 'form', method: 'dialog' },
      h('h2', null, opts.title),
      opts.message ? h('p', { class: 'muted' }, opts.message) : null,
      typed && h('label', { class: 'field' }, h('span', null, `Type ${opts.typeToConfirm} to confirm`), typed),
      h('div', { class: 'form-actions' }, cancel, ok),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      confirmed = true;
      dialog.close();
    });

    const dialog = createDialog('dialog-sm', form);
    dialog.setAttribute('role', 'alertdialog');
    dialog.addEventListener('close', () => resolve(confirmed));
    dialog.showModal();
    (typed ?? (opts.danger ? cancel : ok)).focus();
  });
}
