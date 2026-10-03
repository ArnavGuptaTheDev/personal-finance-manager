export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Same-origin JSON fetch. The session cookie is httpOnly, so JS never sees it. */
export async function api<T = unknown>(path: string, method: Method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    try {
      sessionStorage.removeItem('pfm.me');
    } catch {
      /* storage disabled */
    }
    const reason = (await res.clone().json().catch(() => null)) as { error?: string } | null;
    if (reason?.error?.includes('revoked')) {
      location.href = '/login/?error=not_allowed';
      throw new ApiError('Access revoked', 401);
    }
    location.href = `/login/?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError('Not signed in', 401);
  }
  if (res.status === 204) return undefined as T;

  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown) => api<T>(path, 'POST', body);
export const put = <T>(path: string, body: unknown) => api<T>(path, 'PUT', body);
export const patch = <T>(path: string, body: unknown) => api<T>(path, 'PATCH', body);
export const del = (path: string) => api<void>(path, 'DELETE');
