// Runs on every /app/ page: loads the signed-in user (redirects to /login on 401)
// and wires the sign-out button. Data protection itself happens on the server —
// these pages are static shells that render nothing private until the API answers.
import { api, get } from './api';
import { $, run } from './dom';
import type { Category, User } from './types';

export const me: Promise<User> = get<User>('/me');

let categoriesPromise: Promise<Category[]> | null = null;
export function loadCategories(fresh = false): Promise<Category[]> {
  if (!categoriesPromise || fresh) categoriesPromise = get<Category[]>('/categories');
  return categoriesPromise;
}

me.then((user) => {
  $('#user-name').textContent = user.name ?? user.email;
  $('#user-email').textContent = user.email;
  // Cosmetic only: the server rejects non-owners on every /api/admin request.
  if (user.role === 'owner') {
    document.querySelectorAll<HTMLElement>('[data-owner-only]').forEach((el) => (el.hidden = false));
  }
  if (user.picture?.startsWith('https://')) {
    const img = $<HTMLImageElement>('#user-avatar');
    img.src = user.picture;
    img.hidden = false;
  }
}).catch(() => {
  /* api() already redirected to /login */
});

const logout = $<HTMLButtonElement>('#logout');
logout.addEventListener('click', () =>
  run(logout, async () => {
    await api('/auth/logout', 'POST');
    location.href = '/';
  }),
);
