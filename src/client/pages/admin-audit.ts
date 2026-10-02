import { get } from '../api';
import { ACTION_GROUPS, auditHead, auditRow } from '../audit';
import { $, emptyState, errorMessage, formValues, h, replace, run, toast } from '../dom';
import { qs } from '../format';
import { me } from '../shell';
import type { AdminUser, AuditPage } from '../types';

const form = $<HTMLFormElement>('#audit-filters');
const rows = $('#audit-rows');
const more = $<HTMLButtonElement>('#more');
let cursor: number | null = null;

/** Local date (YYYY-MM-DD) → unix seconds at local start/end of that day. */
const toUnix = (d: string | undefined, endOfDay = false) =>
  d ? Math.floor(new Date(`${d}T${endOfDay ? '23:59:59' : '00:00:00'}`).getTime() / 1000) : undefined;

function filters() {
  const v = formValues(form);
  return { user_id: v.user_id, action: v.action, outcome: v.outcome, from: toUnix(v.from), to: toUnix(v.to, true) };
}

async function load(append = false) {
  const page = await get<AuditPage>(`/admin/audit${qs({ ...filters(), before: append ? cursor : undefined, limit: 100 })}`);
  const items = page.items.map((e) => auditRow(e, true));
  if (append) rows.append(...items);
  else replace(rows, ...(items.length ? items : [h('tr', null, h('td', { colspan: 5 }, emptyState('No matching activity.')))]));
  cursor = page.next_before;
  more.hidden = cursor === null;
}

function reload() {
  const f = formValues(form);
  history.replaceState(null, '', `${location.pathname}${qs(f)}`);
  load().catch((err) => toast(errorMessage(err), 'error'));
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  reload();
});
form.addEventListener('reset', () => setTimeout(reload));
more.addEventListener('click', () => run(more, () => load(true)));

me.then(async (u) => {
  if (u.role !== 'owner') {
    $('#not-owner').hidden = false;
    form.hidden = true;
    return;
  }
  replace($('#audit-head'), auditHead(true));
  $('#audit-action').append(...ACTION_GROUPS.map((g) => h('option', { value: `${g}.` }, g[0]!.toUpperCase() + g.slice(1))));
  try {
    const users = await get<AdminUser[]>('/admin/users');
    $('#audit-user').append(...users.filter((x) => x.user_id).map((x) => h('option', { value: x.user_id! }, x.email)));
    const params = new URLSearchParams(location.search);
    for (const name of ['user_id', 'action', 'outcome', 'from', 'to']) {
      const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      const value = params.get(name);
      if (field && value) field.value = value;
    }
    await load();
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}).catch(() => {});
