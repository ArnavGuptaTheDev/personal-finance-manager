// Human-readable rendering of audit log entries (shared by Settings and Admin).
import { h } from './dom';
import type { AuditEntry } from './types';
import { td } from './ui/table';

const LABELS: Record<string, string> = {
  'auth.login_start': 'Started sign-in',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.unauthenticated': 'Request without a valid session',
  'auth.access_revoked_session': 'Blocked: access had been revoked',
  'security.blocked': 'Blocked request',
  'request.not_found': 'Requested a missing page or record',

  'account.view': 'Opened the app',
  'account.export': 'Exported all their data',
  'account.activity_view': 'Viewed own activity',
  'account.delete': 'Deleted their account',

  'category.list': 'Viewed categories',
  'category.create': 'Created a category',
  'category.update': 'Edited a category',
  'category.delete': 'Deleted a category',
  'category.rule_create': 'Added a categorization rule',
  'category.rule_delete': 'Removed a categorization rule',
  'category.restore': 'Restored a deleted category',
  'category.rule_restore': 'Restored a categorization rule',

  'transaction.list': 'Viewed transactions',
  'transaction.create': 'Added a transaction',
  'transaction.import': 'Imported a statement',
  'transaction.recategorize': 'Bulk-changed categories',
  'transaction.reconcile': 'Checked a statement against existing transactions',
  'transaction.update': 'Edited a transaction',
  'transaction.delete': 'Deleted a transaction',
  'transaction.restore': 'Restored a deleted transaction',
  'transaction.bulk_delete': 'Deleted several transactions',
  'transaction.bulk_restore': 'Restored several transactions',

  'summary.view': 'Viewed the dashboard',
  'budget.list': 'Viewed budgets',
  'budget.set': 'Set a budget',
  'budget.delete': 'Removed a budget',
  'budget.restore': 'Restored a budget',

  'person.list': 'Viewed people',
  'person.create': 'Added a person',
  'person.update': 'Renamed a person',
  'person.delete': 'Deleted a person',
  'person.restore': 'Restored a person',
  'loan.list': 'Viewed loans',
  'loan.create': 'Added a loan',
  'loan.update': 'Edited a loan',
  'loan.delete': 'Deleted a loan',
  'loan.payment_create': 'Recorded a loan payment',
  'loan.payment_delete': 'Deleted a loan payment',
  'loan.restore': 'Restored a loan',
  'loan.payment_restore': 'Restored a loan payment',

  'emi.list': 'Viewed EMIs',
  'emi.create': 'Added an EMI',
  'emi.update': 'Edited an EMI',
  'emi.delete': 'Deleted an EMI',
  'emi.restore': 'Restored an EMI',

  'admin.users_view': 'Viewed users & access',
  'admin.access_grant': 'Granted access',
  'admin.access_revoke': 'Revoked access',
  'admin.user_delete': 'Deleted a user and their data',
  'admin.audit_view': 'Viewed the audit log',
};

export const actionLabel = (action: string) => LABELS[action] ?? action;
export const ACTION_GROUPS = ['auth', 'account', 'transaction', 'category', 'budget', 'summary', 'person', 'loan', 'emi', 'admin', 'security'];

const timeFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium' });
export const fmtTime = (unix: number) => timeFmt.format(new Date(unix * 1000));

function describe(e: AuditEntry): string {
  const bits: string[] = [];
  if (e.target_id) bits.push(e.target_id.includes('@') ? e.target_id : `#${e.target_id}`);
  for (const [k, v] of Object.entries(e.detail ?? {})) bits.push(`${k.replace(/_/g, ' ')}: ${v}`);
  return bits.join(' · ');
}

function browser(ua: string | null): string {
  if (!ua) return '';
  const b = ua.match(/(Edg|Firefox|Chrome|Safari)\/[\d]+/)?.[0]?.replace('Edg', 'Edge') ?? 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [b, os].filter(Boolean).join(' · ');
}

export function auditRow(e: AuditEntry, showUser: boolean): HTMLTableRowElement {
  const tone = { success: 'badge-positive', failure: 'badge-warning', denied: 'badge-negative' }[e.outcome];
  return h('tr', null,
    td({ role: 'meta', class: 'num' }, fmtTime(e.created_at)),
    showUser && td({ label: 'User', class: 'small' }, e.user_email ?? h('span', { class: 'muted' }, 'anonymous')),
    td({ role: 'primary' }, actionLabel(e.action), h('span', { class: 'cell-sub' }, describe(e))),
    td({ role: 'amount' }, h('span', { class: `badge ${tone}` }, e.outcome)),
    td({ role: 'meta', class: 'small muted' },
      [e.ip, e.country].filter(Boolean).join(' · '),
      h('div', null, browser(e.user_agent)),
    ),
  );
}

export function auditHead(showUser: boolean) {
  return h('tr', null,
    h('th', null, 'When'),
    showUser && h('th', null, 'User'),
    h('th', null, 'Activity'),
    h('th', null, 'Result'),
    h('th', null, 'From'),
  );
}
