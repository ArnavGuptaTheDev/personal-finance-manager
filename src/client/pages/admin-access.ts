import { del, get, post } from '../api';
import { fmtTime } from '../audit';
import { $, emptyState, errorMessage, formValues, h, replace, run, toast } from '../dom';
import { qs } from '../format';
import { me } from '../shell';
import type { AdminUser } from '../types';

const form = $<HTMLFormElement>('#grant-form');

async function load() {
  const users = await get<AdminUser[]>('/admin/users');
  replace($('#user-rows'), ...(users.length ? users.map(row) : [h('tr', null, h('td', { colspan: 6 }, emptyState('Nobody yet.')))]));
}

function row(u: AdminUser): HTMLTableRowElement {
  const actions = h('div', { class: 'row' });

  if (u.user_id) {
    actions.append(h('a', { class: 'btn btn-ghost btn-sm', href: `/app/admin/audit/${qs({ user_id: u.user_id })}` }, 'Activity'));
  }
  if (u.role === 'member') {
    const revoke = h('button', { class: 'btn btn-ghost btn-sm btn-danger', type: 'button' }, 'Revoke');
    revoke.addEventListener('click', () =>
      run(revoke, async () => {
        if (!confirm(`Revoke access for ${u.email}? They are signed out immediately. Their data is kept.`)) return;
        await del(`/admin/access/${encodeURIComponent(u.email)}`);
        toast('Access revoked');
        await load();
      }),
    );
    actions.append(revoke);
  }
  if (u.role === null) {
    const restore = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Restore access');
    restore.addEventListener('click', () =>
      run(restore, async () => {
        await post('/admin/access', { email: u.email });
        toast('Access restored');
        await load();
      }),
    );
    actions.append(restore);
  }
  if (u.user_id && u.role !== 'owner') {
    const remove = h('button', { class: 'btn btn-ghost btn-sm btn-danger', type: 'button' }, 'Delete account');
    remove.addEventListener('click', () =>
      run(remove, async () => {
        const typed = prompt(`This permanently deletes ${u.email}'s account and ALL their data.\nType the email to confirm.`);
        if (typed?.trim().toLowerCase() !== u.email) return toast('Not deleted');
        await del(`/admin/users/${u.user_id}`);
        toast('Account deleted');
        await load();
      }),
    );
    actions.append(remove);
  }

  const status = { active: 'Active', invited: 'Invited · not signed in yet', revoked: 'No access' }[u.status];
  return h('tr', { 'data-muted': u.status === 'revoked' },
    h('td', null, u.name ?? u.email, u.name && h('div', { class: 'muted small' }, u.email), u.note && h('div', { class: 'muted small' }, u.note)),
    h('td', null, h('span', { class: 'badge' }, u.role === 'owner' ? 'Owner' : u.role === 'member' ? 'Member' : '—')),
    h('td', { class: 'small' }, status, u.active_sessions ? h('div', { class: 'muted' }, `${u.active_sessions} active session(s)`) : null),
    h('td', { class: 'small num' }, u.last_login_at ? fmtTime(u.last_login_at) : '—'),
    h('td', { class: 'small' }, u.granted_by ?? '—', u.granted_at ? h('div', { class: 'muted' }, fmtTime(u.granted_at)) : null),
    h('td', { class: 'right' }, actions),
  );
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = formValues(form);
  run($<HTMLButtonElement>('#grant-btn'), async () => {
    await post('/admin/access', { email: v.email, note: v.note || null });
    toast(`${v.email} can now sign in`);
    form.reset();
    await load();
  });
});

me.then((u) => {
  if (u.role !== 'owner') {
    $('#not-owner').hidden = false;
    form.hidden = true;
    return;
  }
  load().catch((err) => toast(errorMessage(err), 'error'));
}).catch(() => {});
