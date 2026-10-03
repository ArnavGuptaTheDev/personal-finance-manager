import { del, get, post } from '../api';
import { fmtTime } from '../audit';
import { $, errorMessage, h } from '../dom';
import { qs } from '../format';
import { me } from '../shell';
import type { AdminUser } from '../types';
import { button, linkButton } from '../ui/button';
import { confirmDialog } from '../ui/confirm';
import { bindForm } from '../ui/form';
import { renderTable, tableError, td } from '../ui/table';
import { toast } from '../ui/toast';

const COLS = 6;
const form = $<HTMLFormElement>('#grant-form');

async function load() {
  try {
    renderTable($('#user-rows'), await get<AdminUser[]>('/admin/users'), row, { colspan: COLS, empty: 'Nobody yet.' });
  } catch (err) {
    tableError($('#user-rows'), COLS, errorMessage(err), () => void load());
  }
}

async function act(fn: () => Promise<unknown>, message: string) {
  try {
    await fn();
    toast(message);
    await load();
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

function row(u: AdminUser): HTMLTableRowElement {
  const actions = h('div', { class: 'row' });

  if (u.user_id) actions.append(linkButton('Activity', `/app/admin/audit/${qs({ user_id: u.user_id })}`, { variant: 'ghost', size: 'sm' }));
  if (u.role === 'member') {
    actions.append(
      button('Revoke', {
        variant: 'ghost-danger',
        size: 'sm',
        onClick: async () => {
          const ok = await confirmDialog({
            title: `Revoke access for ${u.email}?`,
            message: 'They are signed out immediately. Their data is kept, so you can restore access later.',
            confirmLabel: 'Revoke access',
            danger: true,
          });
          if (ok) await act(() => del(`/admin/access/${encodeURIComponent(u.email)}`), 'Access revoked');
        },
      }),
    );
  }
  if (u.role === null) {
    actions.append(button('Restore access', { variant: 'ghost', size: 'sm', onClick: () => void act(() => post('/admin/access', { email: u.email }), 'Access restored') }));
  }
  if (u.user_id && u.role !== 'owner') {
    actions.append(
      button('Delete account', {
        variant: 'ghost-danger',
        size: 'sm',
        onClick: async () => {
          const ok = await confirmDialog({
            title: `Delete ${u.email}'s account?`,
            message: 'This permanently deletes their account and ALL their data, straight away. It cannot be undone.',
            confirmLabel: 'Delete account',
            danger: true,
            typeToConfirm: u.email,
          });
          if (ok) await act(() => del(`/admin/users/${u.user_id}`), 'Account deleted');
        },
      }),
    );
  }

  const status = { active: 'Active', invited: 'Invited · not signed in yet', revoked: 'No access' }[u.status];
  return h('tr', { 'data-muted': u.status === 'revoked' },
    td({ role: 'primary' }, u.name ?? u.email, u.name && h('span', { class: 'cell-sub' }, u.email), u.note && h('span', { class: 'cell-sub' }, u.note)),
    td({ role: 'amount' }, h('span', { class: 'badge' }, u.role === 'owner' ? 'Owner' : u.role === 'member' ? 'Member' : '—')),
    td({ label: 'Status', class: 'small' }, status, u.active_sessions ? h('span', { class: 'cell-sub' }, `${u.active_sessions} active session(s)`) : null),
    td({ label: 'Last sign-in', class: 'small num' }, u.last_login_at ? fmtTime(u.last_login_at) : '—'),
    td({ label: 'Access from', class: 'small' }, u.granted_by ?? '—', u.granted_at ? h('span', { class: 'cell-sub' }, fmtTime(u.granted_at)) : null),
    td({ role: 'actions' }, actions),
  );
}

bindForm(form, async (v) => {
  await post('/admin/access', { email: v.email, note: v.note || null });
  toast(`${v.email} can now sign in`);
  form.reset();
  await load();
});

me.then((u) => {
  if (u.role !== 'owner') {
    $('#not-owner').hidden = false;
    form.hidden = true;
    return;
  }
  void load();
}).catch(() => {});
