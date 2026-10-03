import { get } from '../api';
import { ACTION_GROUPS, auditHead, auditRow } from '../audit';
import { $, errorMessage, formValues, h, replace } from '../dom';
import { qs } from '../format';
import { me } from '../shell';
import type { AdminUser, AuditPage } from '../types';
import { setValues } from '../ui/form';
import { renderTable, tableError } from '../ui/table';
import { toast } from '../ui/toast';

const COLS = 5;
const form = $<HTMLFormElement>('#audit-filters');
const rows = $('#audit-rows');
const more = $<HTMLButtonElement>('#more');
let cursor: number | null = null;
const FILTERS = ['user_id', 'action', 'outcome', 'from', 'to'];

/** Local date (YYYY-MM-DD) → unix seconds at local start/end of that day. */
const toUnix = (d: string | undefined, endOfDay = false) =>
  d ? Math.floor(new Date(`${d}T${endOfDay ? '23:59:59' : '00:00:00'}`).getTime() / 1000) : undefined;

function query(v: Record<string, string | undefined>) {
  return { user_id: v.user_id, action: v.action, outcome: v.outcome, from: toUnix(v.from), to: toUnix(v.to, true) };
}

let seq = 0;
async function load(v: Record<string, string | undefined> = formValues(form), append = false) {
  const mine = ++seq;
  try {
    const page = await get<AuditPage>(`/admin/audit${qs({ ...query(v), before: append ? cursor : undefined, limit: 100 })}`);
    if (mine !== seq) return;
    if (append) rows.append(...page.items.map((e) => auditRow(e, true)));
    else renderTable(rows, page.items, (e) => auditRow(e, true), { colspan: COLS, empty: 'No matching activity.' });
    cursor = page.next_before;
    more.hidden = cursor === null;
  } catch (err) {
    if (append) toast(errorMessage(err), 'error');
    else tableError(rows, COLS, errorMessage(err), () => void load());
  }
}

function reload() {
  const v = formValues(form);
  history.replaceState(null, '', `${location.pathname}${qs(v)}`);
  void load(v);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  reload();
});
form.addEventListener('change', reload);
form.addEventListener('reset', () => setTimeout(reload));
more.addEventListener('click', async () => {
  more.disabled = true;
  await load(formValues(form), true);
  more.disabled = false;
});
$('#filters-toggle').addEventListener('click', (e) => {
  const open = form.classList.toggle('is-open');
  (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(open));
});

me.then((u) => {
  if (u.role !== 'owner') {
    $('#not-owner').hidden = false;
    form.hidden = true;
    replace(rows);
    return;
  }
  replace($('#audit-head'), auditHead(true));
  $('#audit-action').append(...ACTION_GROUPS.map((g) => h('option', { value: `${g}.` }, g[0]!.toUpperCase() + g.slice(1))));
  const params = new URLSearchParams(location.search);
  const initial = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? '']));
  setValues(form, initial);
  if (Object.values(initial).some(Boolean)) form.classList.add('is-open');

  // The user list (for the filter) and the first page load in parallel.
  void load(initial);
  get<AdminUser[]>('/admin/users')
    .then((users) => {
      $('#audit-user').append(...users.filter((x) => x.user_id).map((x) => h('option', { value: x.user_id! }, x.email)));
      setValues(form, { user_id: initial.user_id });
    })
    .catch((err) => toast(errorMessage(err), 'error'));
}).catch(() => {});
