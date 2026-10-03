// Runs on every /app/ page: shows the signed-in user (redirects to /login on 401),
// wires sign-out and the phone "More" sheet. Data protection itself happens on the
// server; these pages are static shells that render nothing private until the API answers.
//
// The user (name, email, picture, role; no financial data) is cached in sessionStorage
// so the shell renders instantly on every navigation. It is revalidated in the
// background when older than REVALIDATE_MS; any API call still 401s if access is gone.
import { api, get } from './api';
import { run } from './dom';
import type { Category, User } from './types';
import { keymap, listen } from './ui/keys';
import { openDialog } from './ui/modal';
import { addCommands, addCommandSource, openHelp, openPalette, setCategorySource } from './ui/palette';

export const ME_CACHE_KEY = 'pfm.me';
const REVALIDATE_MS = 5 * 60 * 1000;

type Cached = { user: User; at: number };

function readCache(): Cached | null {
  try {
    const c = JSON.parse(sessionStorage.getItem(ME_CACHE_KEY) ?? 'null') as Cached | null;
    return c?.user?.email ? c : null;
  } catch {
    return null;
  }
}

function writeCache(user: User) {
  try {
    sessionStorage.setItem(ME_CACHE_KEY, JSON.stringify({ user, at: Date.now() }));
  } catch {
    /* storage disabled: the shell just fetches every time */
  }
}

function render(user: User) {
  const name = user.name ?? user.email;
  document.querySelectorAll('[data-user-name]').forEach((el) => (el.textContent = name));
  document.querySelectorAll('[data-user-email]').forEach((el) => (el.textContent = user.email));
  document.querySelectorAll<HTMLElement>('[data-avatar]').forEach((el) => {
    if (user.picture?.startsWith('https://')) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = user.picture;
      img.addEventListener('error', () => (el.textContent = name.slice(0, 1).toUpperCase()));
      el.replaceChildren(img);
    } else {
      el.textContent = name.slice(0, 1).toUpperCase();
    }
  });
  // Cosmetic only: the server rejects non-owners on every /api/admin request.
  document.querySelectorAll<HTMLElement>('[data-owner-only]').forEach((el) => (el.hidden = user.role !== 'owner'));
}

function fetchMe(): Promise<User> {
  return get<User>('/me').then((user) => {
    writeCache(user);
    render(user);
    return user;
  });
}

const cached = readCache();
if (cached) render(cached.user);
const revalidate = !cached || Date.now() - cached.at > REVALIDATE_MS ? fetchMe() : null;

export const me: Promise<User> = cached ? Promise.resolve(cached.user) : revalidate!;
revalidate?.catch(() => {
  /* api() already redirected to /login */
});

let categoriesPromise: Promise<Category[]> | null = null;
export function loadCategories(fresh = false): Promise<Category[]> {
  if (!categoriesPromise || fresh) categoriesPromise = get<Category[]>('/categories');
  return categoriesPromise;
}

document.querySelectorAll<HTMLButtonElement>('[data-logout]').forEach((btn) =>
  btn.addEventListener('click', () =>
    run(btn, async () => {
      await api('/auth/logout', 'POST');
      sessionStorage.removeItem(ME_CACHE_KEY);
      location.href = '/';
    }),
  ),
);

const moreSheet = document.getElementById('more-sheet') as HTMLDialogElement | null;
document.getElementById('more-btn')?.addEventListener('click', () => moreSheet && openDialog(moreSheet));

// ---- keyboard ----

/** Set by a page that can open its own new-transaction form (Transactions). */
export const pageHooks: { newTransaction?: () => void } = {};

const go = (path: string) => () => (location.href = path);
const newTransaction = () => (pageHooks.newTransaction ? pageHooks.newTransaction() : go('/app/transactions/?new=1')());
function focusSearch() {
  const el = document.querySelector<HTMLInputElement>('[data-search]');
  if (!el) return;
  el.closest('.filters')?.classList.add('is-open');
  el.focus();
  el.select();
}

listen();
keymap.add(
  { keys: 'mod+k', description: 'Open the command palette', group: 'Anywhere', run: openPalette },
  { keys: 'g d', description: 'Go to Dashboard', group: 'Anywhere', run: go('/app/') },
  { keys: 'g t', description: 'Go to Transactions', group: 'Anywhere', run: go('/app/transactions/') },
  { keys: 'g i', description: 'Go to Import', group: 'Anywhere', run: go('/app/import/') },
  { keys: 'g b', description: 'Go to Budgets', group: 'Anywhere', run: go('/app/budgets/') },
  { keys: 'n', description: 'New transaction', group: 'Anywhere', run: newTransaction },
  { keys: '/', description: 'Search this page', group: 'Anywhere', run: focusSearch, when: () => document.querySelector('[data-search]') !== null },
  { keys: '?', description: 'Show keyboard shortcuts', group: 'Anywhere', run: openHelp },
);

addCommandSource(() =>
  [...document.querySelectorAll<HTMLAnchorElement>('.nav a')]
    .filter((a) => !a.hidden)
    .map((a) => ({ label: a.textContent?.trim() ?? '', group: 'Pages', run: go(a.getAttribute('href') ?? '/app/') })),
);
addCommands(
  { label: 'New transaction', group: 'Actions', hint: 'N', run: newTransaction },
  { label: 'Import a statement', group: 'Actions', run: go('/app/import/') },
  { label: 'Keyboard shortcuts', group: 'Actions', hint: '?', run: openHelp },
  { label: 'Sign out', group: 'Actions', run: () => document.querySelector<HTMLButtonElement>('[data-logout]')?.click() },
);
setCategorySource(() => loadCategories());
