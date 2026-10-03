// Rule health on the Categories page: per-rule match counts, conflicts (one transaction
// matched by rules for different categories), rules that never match, and a live
// "test this rule" preview. Everything runs in the browser, so regexes never reach the server.
import { get } from '../api';
import { compileRule, prepare, type Prepared } from '../categorize';
import { $, errorMessage, h, replace } from '../dom';
import type { Category } from '../types';
import { emptyState, errorState, renderTable, td } from '../ui/table';

type Text = { id: number; description: string; category_id: number | null; prepared: Prepared };
type RuleRow = { label: string; category: Category; own: boolean; count: number };

let texts: Text[] | null = null;

const ruleLabel = (k: Category['keywords'][number]) => k.keyword ?? `/${k.regex}/`;

export async function showRuleHealth(categories: Category[]) {
  try {
    texts ??= (await get<{ id: number; description: string; category_id: number | null }[]>('/transactions/texts')).map((t) => ({ ...t, prepared: prepare(t.description) }));
  } catch (err) {
    replace($('#rules-summary'), errorState(errorMessage(err), () => void showRuleHealth(categories)));
    return;
  }
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const rows: RuleRow[] = [];
  const matchedBy = new Map<number, Set<number>>();

  for (const cat of categories) {
    for (const k of cat.keywords) {
      const match = compileRule(k);
      let count = 0;
      if (match) {
        for (const t of texts) {
          if (!match(t.description, t.prepared)) continue;
          count++;
          const set = matchedBy.get(t.id) ?? new Set<number>();
          set.add(cat.id);
          matchedBy.set(t.id, set);
        }
      }
      rows.push({ label: ruleLabel(k), category: cat, own: !k.builtin, count });
    }
  }

  const conflicts = texts.filter((t) => (matchedBy.get(t.id)?.size ?? 0) > 1);
  const dead = rows.filter((r) => r.count === 0 && r.own);
  $('#rules-summary').textContent =
    `${rows.length} rules checked against your ${texts.length.toLocaleString('en-IN')} transactions: ` +
    `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}, ${dead.length} of your rules never match.`;

  replace(
    $('#rules-conflicts'),
    conflicts.length
      ? h('details', { class: 'collapse' },
          h('summary', null, h('h3', null, `Conflicts (${conflicts.length})`)),
          h('p', { class: 'muted small' }, 'Each of these matches rules for more than one category; the first rule to match wins (your own rules, then longer keywords).'),
          h('ul', { class: 'plain-list small' },
            ...conflicts.slice(0, 30).map((t) =>
              h('li', null, t.description, h('span', { class: 'cell-sub' }, [...matchedBy.get(t.id)!].map((id) => names.get(id)).join(' · '))),
            ),
          ),
        )
      : '',
  );
  replace(
    $('#rules-dead'),
    dead.length
      ? h('details', { class: 'collapse' },
          h('summary', null, h('h3', null, `Never matched (${dead.length})`)),
          h('ul', { class: 'plain-list small' }, ...dead.map((r) => h('li', null, r.label, h('span', { class: 'cell-sub' }, r.category.name)))),
        )
      : '',
  );

  rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  renderTable($('#rules-rows'), rows, (r) =>
    h('tr', null,
      td({ role: 'primary' }, r.label, r.own ? null : h('span', { class: 'cell-sub' }, 'Built-in')),
      td({ label: 'Category' }, r.category.name),
      td({ role: 'amount', class: 'right num' }, r.count.toLocaleString('en-IN')),
    ), { colspan: 3, empty: 'No rules yet.' });
}

function testRule(raw: string) {
  const input = $<HTMLInputElement>('#rule-test');
  const value = raw.trim();
  $('#rule-test-error').textContent = '';
  input.removeAttribute('aria-invalid');
  if (!value || !texts) {
    $('#rule-test-result').textContent = texts ? '' : 'Loading your transactions…';
    replace($('#rule-test-samples'));
    return;
  }
  const isRegex = value.length > 2 && value.startsWith('/') && value.endsWith('/');
  const match = compileRule(isRegex ? { keyword: null, regex: value.slice(1, -1) } : { keyword: value, regex: null });
  if (!match) {
    $('#rule-test-error').textContent = isRegex ? 'Not a valid regular expression' : 'Type at least one letter';
    input.setAttribute('aria-invalid', 'true');
    return;
  }
  const hits = texts.filter((t) => match(t.description, t.prepared));
  $('#rule-test-result').textContent = `Matches ${hits.length.toLocaleString('en-IN')} of your transactions${hits.length > 10 ? ' (first 10 shown)' : ''}.`;
  replace($('#rule-test-samples'), ...(hits.length ? hits.slice(0, 10).map((t) => h('li', null, t.description)) : [emptyState('No matches.')]));
}

let debounce: number | undefined;
$<HTMLInputElement>('#rule-test').addEventListener('input', (e) => {
  window.clearTimeout(debounce);
  const value = (e.target as HTMLInputElement).value;
  debounce = window.setTimeout(() => testRule(value), 150);
});
