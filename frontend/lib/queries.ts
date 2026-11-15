'use client';

/**
 * Thin wrapper over useQuery that wires the typed apiFetch client (envelope
 * unwrapping, ApiError typing, cancellation, offline detection) with sane
 * defaults for the whole app.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Paged } from '@medidata/shared';
import type { ZodType } from 'zod';
import { ApiError, apiFetch } from '@/lib/api';

export const DEFAULT_STALE_TIME = 30_000;

/** Page size used by list screens: one page is enough for the demo dataset. */
export const DEFAULT_PAGE_SIZE = 500;

type UseApiQueryOptions<T> = {
  enabled?: boolean;
  staleTime?: number;
  /** Optional zod schema to validate/parse the unwrapped payload. */
  schema?: ZodType<T>;
};

type UseApiListOptions<T> = {
  enabled?: boolean;
  staleTime?: number;
  /** Server page size (defaults to DEFAULT_PAGE_SIZE). */
  pageSize?: number;
  /** Optional zod schema to validate/parse each item. */
  schema?: ZodType<T>;
};

/** Append `pageSize` to a path that may already carry a query string. */
export function withPageSize(path: string, pageSize = DEFAULT_PAGE_SIZE): string {
  if (/[?&]pageSize=/.test(path)) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}pageSize=${pageSize}`;
}

export function useApiQuery<T>(
  queryKey: readonly unknown[],
  path: string,
  options: UseApiQueryOptions<T> = {},
): UseQueryResult<T, ApiError> {
  return useQuery<T, ApiError>({
    queryKey,
    queryFn: async ({ signal }) => {
      const data = await apiFetch<T>(path, { signal });
      return options.schema ? options.schema.parse(data) : data;
    },
    enabled: options.enabled ?? true,
    staleTime: options.staleTime ?? DEFAULT_STALE_TIME,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 401) return false;
      return failureCount < 1;
    },
  });
}

/**
 * List variant of `useApiQuery` for the paginated endpoints.
 *
 * Every list route returns `Paged<T>` (`{ items, page, pageSize, total,
 * totalPages }`), while list screens render a plain array. This hook requests
 * a large page and unwraps `.items`, so pages never have to know about the
 * pagination envelope. It also tolerates endpoints that still return a bare
 * array, which keeps the hook safe for mixed/legacy routes.
 */
export function useApiList<T>(
  queryKey: readonly unknown[],
  path: string,
  options: UseApiListOptions<T> = {},
): UseQueryResult<T[], ApiError> {
  return useQuery<T[], ApiError>({
    queryKey,
    queryFn: async ({ signal }) => {
      const data = await apiFetch<Paged<T> | T[]>(withPageSize(path, options.pageSize), { signal });
      const items = Array.isArray(data) ? data : (data.items ?? []);
      return options.schema ? items.map((item) => options.schema!.parse(item)) : items;
    },
    enabled: options.enabled ?? true,
    staleTime: options.staleTime ?? DEFAULT_STALE_TIME,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 401) return false;
      return failureCount < 1;
    },
  });
}
