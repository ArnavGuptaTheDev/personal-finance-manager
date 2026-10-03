import { del, get } from '../api';
import { auditHead, auditRow } from '../audit';
import { $, errorMessage, replace } from '../dom';
import { qs } from '../format';
import { me, ME_CACHE_KEY } from '../shell';
import type { AuditPage } from '../types';
import { confirmDialog } from '../ui/confirm';
import { renderTable, skeletonRows, tableError } from '../ui/table';
import { toast } from '../ui/toast';

me.then((u) => ($('#settings-role').textContent = u.role === 'owner' ? 'Owner' : 'Member')).catch(() => {});

const rows = $('#activity-rows');
const more = $<HTMLButtonElement>('#activity-more');
let cursor: number | null = null;

async function loadActivity(append = false) {
  try {
    const page = await get<AuditPage>(`/me/activity${qs({ limit: 50, before: append ? cursor : undefined })}`);
    if (append) rows.append(...page.items.map((e) => auditRow(e, false)));
    else renderTable(rows, page.items, (e) => auditRow(e, false), { colspan: 4, empty: 'No activity yet.' });
    cursor = page.next_before;
    more.hidden = cursor === null;
  } catch (err) {
    if (!append) tableError(rows, 4, errorMessage(err), () => void loadActivity());
    else toast(errorMessage(err), 'error');
  }
}

// Loaded only when opened: the list is long and most visits don't need it.
const activity = $<HTMLDetailsElement>('#activity');
activity.addEventListener('toggle', () => {
  if (!activity.open || rows.dataset.loaded) return;
  rows.dataset.loaded = 'true';
  replace($('#activity-head'), auditHead(false));
  skeletonRows(rows, 4, 5);
  void loadActivity();
});
more.addEventListener('click', async () => {
  more.disabled = true;
  await loadActivity(true);
  more.disabled = false;
});

$('#delete-account').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Delete your account?',
    message: 'This permanently deletes your account and every transaction, budget, loan and EMI, straight away. It cannot be undone.',
    confirmLabel: 'Delete everything',
    danger: true,
    typeToConfirm: 'DELETE',
  });
  if (!ok) return;
  try {
    await del('/me');
    sessionStorage.removeItem(ME_CACHE_KEY);
    location.href = '/';
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
});
