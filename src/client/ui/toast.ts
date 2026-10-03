// Toast stack. Successes leave quickly, errors stay longer, toasts with an action
// (Undo) stay for the full undo window. Hovering or focusing a toast pauses it.
import { h } from '../dom';

export type ToastKind = 'ok' | 'error';
export type ToastAction = { label: string; run: () => void | Promise<void> };
type Options = { kind?: ToastKind; action?: ToastAction; duration?: number };

export const UNDO_MS = 10_000;
const DURATION: Record<ToastKind, number> = { ok: 4000, error: 8000 };
const MAX_VISIBLE = 3;

function stack(): HTMLElement {
  let el = document.getElementById('toasts');
  if (!el) {
    el = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  return el;
}

function dismiss(el: HTMLElement) {
  if (el.classList.contains('is-leaving')) return;
  el.classList.add('is-leaving');
  window.setTimeout(() => el.remove(), 200);
}

export function toast(message: string, kindOrOpts: ToastKind | Options = 'ok') {
  const opts: Options = typeof kindOrOpts === 'string' ? { kind: kindOrOpts } : kindOrOpts;
  const kind = opts.kind ?? 'ok';
  const duration = opts.duration ?? (opts.action ? UNDO_MS : DURATION[kind]);
  const el = h('div', { class: 'toast', 'data-kind': kind, role: kind === 'error' ? 'alert' : null }, h('span', null, message));

  if (opts.action) {
    const { label, run } = opts.action;
    const btn = h('button', { type: 'button' }, label);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      dismiss(el);
      try {
        await run();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Something went wrong', 'error');
      }
    });
    el.append(btn);
  }

  let remaining = duration;
  let started = Date.now();
  let timer = window.setTimeout(() => dismiss(el), remaining);
  const pause = () => {
    window.clearTimeout(timer);
    remaining -= Date.now() - started;
  };
  const resume = () => {
    started = Date.now();
    timer = window.setTimeout(() => dismiss(el), Math.max(remaining, 1500));
  };
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', resume);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', resume);

  const list = stack();
  list.append(el);
  const live = [...list.children].filter((c) => !c.classList.contains('is-leaving')) as HTMLElement[];
  live.slice(0, Math.max(0, live.length - MAX_VISIBLE)).forEach(dismiss);
  return () => dismiss(el);
}

/** A success toast with an Undo button that stays for the undo window. */
export function undoToast(message: string, undo: () => void | Promise<void>) {
  return toast(message, { action: { label: 'Undo', run: undo } });
}
