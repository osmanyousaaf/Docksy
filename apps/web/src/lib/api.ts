import { QueryClient, useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

/** Error thrown for non-2xx responses; mirrors ApiError JSON from the server. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** fetch wrapper for /api/v1. Sends cookies; JSON in/out. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
    signal: init.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'http_error', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

/** GET with react-query. key defaults to the path. */
export function useApi<T>(path: string | null, opts: Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'> & { key?: unknown[] } = {}) {
  const { key, ...rest } = opts;
  return useQuery<T, ApiError>({
    queryKey: key ?? [path],
    queryFn: ({ signal }) => api<T>(path!, { signal }),
    enabled: path !== null && (rest.enabled ?? true),
    ...rest,
  });
}

/** Mutation helper; invalidates the given query keys (path prefixes) on success. */
export function useApiMutation<TBody, TRes>(method: string, path: string | ((b: TBody) => string), invalidate: string[] = []) {
  const qc = useQueryClient();
  return useMutation<TRes, ApiError, TBody>({
    mutationFn: (b) => api<TRes>(typeof path === 'function' ? path(b) : path, { method, body: method === 'DELETE' && b === undefined ? undefined : b }),
    onSuccess: () => {
      for (const p of invalidate) qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith(p) });
    },
  });
}

/**
 * Subscribe to a Server-Sent Events endpoint under /api/v1.
 * onEvent(eventName, parsedJson). Auto-reconnects (EventSource default). Returns connection state.
 */
export function useSSE(path: string | null, onEvent: (event: string, data: any) => void, events: string[] = ['message']) {
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!path) return;
    const es = new EventSource(`/api/v1${path}`, { withCredentials: true });
    setState('connecting');
    es.onopen = () => setState('open');
    es.onerror = () => setState(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
    const handlers = events.map((name) => {
      const h = (e: MessageEvent) => {
        try { cb.current(name, JSON.parse(e.data)); } catch { cb.current(name, e.data); }
      };
      es.addEventListener(name, h as EventListener);
      return [name, h] as const;
    });
    return () => {
      handlers.forEach(([n, h]) => es.removeEventListener(n, h as EventListener));
      es.close();
      setState('closed');
    };
  }, [path, events.join(',')]);
  return state;
}
