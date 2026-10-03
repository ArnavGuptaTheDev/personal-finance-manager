// Runs on every /app/ page: shows the signed-in user (redirects to /login on 401),
// wires sign-out and the phone "More" sheet. Data protection itself happens on the
// server; these pages are static shells that render nothing private until the API answers.
//
// The user (name, email, picture, role; no financial data) is cached in sessionStorage
// so the shell renders instantly on every navigation. It is revalidated in the
// background when older than REVALIDATE_MS; any API call still 401s if access is gone.
import { api, get } from './api';
import { run } from './dom';
import { openDialog } from './ui/modal';
import type { Category, User } from './types';

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
