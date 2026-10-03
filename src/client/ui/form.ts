// One validation pattern for every form: native constraints plus the server's
// "field: message" errors, shown inline under the field; focus moves to the first error.
import { ApiError } from '../api';
import { errorMessage, formValues } from '../dom';
import { parseMoney } from '../format';
import { toast } from './toast';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function controls(form: HTMLFormElement): Control[] {
  return [...form.elements].filter((el): el is Control => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement);
}

function errorSlot(el: Control): HTMLElement | null {
  return el.closest('.field')?.querySelector<HTMLElement>('.field-error') ?? null;
}

export function setFieldError(el: Control, message: string) {
  el.setAttribute('aria-invalid', message ? 'true' : 'false');
  const slot = errorSlot(el);
  if (slot) {
    slot.textContent = message;
    if (!slot.id) slot.id = `err-${Math.random().toString(36).slice(2, 9)}`;
    if (message) el.setAttribute('aria-describedby', slot.id);
    else el.removeAttribute('aria-describedby');
  }
}

export function clearErrors(form: HTMLFormElement) {
  for (const el of controls(form)) setFieldError(el, '');
}

function validate(form: HTMLFormElement): Control | null {
  let first: Control | null = null;
  for (const el of controls(form)) {
    if (el instanceof HTMLInputElement && el.dataset.money !== undefined && el.value.trim()) {
      el.setCustomValidity(Number.isNaN(parseMoney(el.value)) ? 'Enter an amount like 1,234.50' : '');
    }
    if (!el.checkValidity()) {
      setFieldError(el, el.validationMessage);
      first ??= el;
    } else {
      setFieldError(el, '');
    }
  }
  return first;
}

/** Shows an API error inline when it names a field of this form; returns false otherwise. */
export function showServerError(form: HTMLFormElement, err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const m = err.message.match(/^([a-z_]+): (.+)$/);
  if (!m) return false;
  const el = form.elements.namedItem(m[1]!);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return false;
  setFieldError(el, m[2]!);
  el.focus();
  return true;
}

/**
 * Wires a form: validates on submit, disables the submit button while saving,
 * and shows server errors inline (or as a toast when they name no field).
 */
export function bindForm(form: HTMLFormElement, onSubmit: (values: Record<string, string>) => Promise<void>) {
  form.noValidate = true;
  form.addEventListener('input', (e) => {
    const el = e.target as Control;
    if (el.getAttribute('aria-invalid') === 'true') {
      if (el instanceof HTMLInputElement) el.setCustomValidity('');
      setFieldError(el, '');
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const invalid = validate(form);
    if (invalid) {
      invalid.focus();
      return;
    }
    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]');
    if (submit) submit.disabled = true;
    try {
      await onSubmit(formValues(form));
    } catch (err) {
      if (!showServerError(form, err)) toast(errorMessage(err), 'error');
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

export function setValues(form: HTMLFormElement, values: Record<string, string | number | null | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) el.value = value == null ? '' : String(value);
  }
}
