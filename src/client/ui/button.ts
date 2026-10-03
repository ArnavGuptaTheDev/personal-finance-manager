import { h } from '../dom';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'ghost-danger';
type ButtonOptions = {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  type?: 'button' | 'submit';
  /** Icon-only buttons need an accessible name. */
  ariaLabel?: string;
  icon?: boolean;
  onClick?: (e: MouseEvent) => void;
};

const VARIANT: Record<ButtonVariant, string> = {
  default: '',
  primary: 'btn-primary',
  danger: 'btn-danger',
  ghost: 'btn-ghost',
  'ghost-danger': 'btn-ghost btn-danger',
};

export function buttonClass(variant: ButtonVariant = 'default', size: 'md' | 'sm' = 'md', icon = false): string {
  return ['btn', VARIANT[variant], size === 'sm' && 'btn-sm', icon && 'btn-icon'].filter(Boolean).join(' ');
}

export function button(label: string, opts: ButtonOptions = {}): HTMLButtonElement {
  const el = h('button', {
    class: buttonClass(opts.variant, opts.size, opts.icon),
    type: opts.type ?? 'button',
    'aria-label': opts.ariaLabel,
    title: opts.icon ? opts.ariaLabel : undefined,
  }, label);
  if (opts.onClick) el.addEventListener('click', opts.onClick);
  return el;
}

export function linkButton(label: string, href: string, opts: Pick<ButtonOptions, 'variant' | 'size'> = {}): HTMLAnchorElement {
  return h('a', { class: buttonClass(opts.variant, opts.size), href }, label);
}
