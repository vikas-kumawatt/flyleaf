// TanStack Query integration & error formatting (SL-03, design.md §8).
//
// Defaults tuned for mobile:
// - 5min stale time for catalog items
// - 24hr cache persistence
// - 1 retry for transient network drops; never retry 4xx errors
// - Warm, human error messages per Voice & Tone rules

import React from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { api, type ReadStatus, type Work, type Read } from './api';
import { FlyleafApiError } from '@flyleaf/api-client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
      retry: (failureCount, error) => {
        if (
          error instanceof FlyleafApiError &&
          error.status &&
          error.status >= 400 &&
          error.status < 500
        ) {
          return false;
        }
        return failureCount < 1;
      },
    },
  },
});

export function AppQueryProvider({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

// ---------------------------------------------------------------- Error Formatting
// Conforms to design.md §8 Voice & Tone: "Errors explain and offer a fix. Never a raw error."
export function formatApiErrorMessage(err: unknown): string {
  if (err instanceof FlyleafApiError) {
    switch (err.code) {
      case 'not_found':
        return "We couldn't find this item. Try searching again.";
      case 'unauthorized':
        return 'Please sign in to continue.';
      case 'forbidden':
        return "You don't have permission to perform this action.";
      case 'conflict':
        return err.message || 'This item already exists.';
      case 'rate_limited':
        return 'Too many requests. Please wait a moment and try again.';
      case 'validation_error':
        return err.message || 'Please check your inputs and try again.';
      default:
        return 'We ran into a problem. Please try again in a moment.';
    }
  }
  if (err instanceof Error) {
    if (err.message.includes('Network') || err.message.includes('Failed to fetch')) {
      return 'Check your internet connection and try again.';
    }
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------- Query Hooks
export function useSearchWorks(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['search', trimmed],
    queryFn: () => api.search(trimmed),
    enabled: trimmed.length >= 2,
    staleTime: 1000 * 60 * 2, // 2 min for search
  });
}

export function useWorkDetail(workId: string) {
  return useQuery({
    queryKey: ['work', workId],
    queryFn: () => api.work(workId),
    enabled: !!workId,
  });
}

export function useUserReads(status?: ReadStatus) {
  return useQuery({
    queryKey: ['reads', status ?? 'all'],
    queryFn: () => api.reads(status),
  });
}

// ---------------------------------------------------------------- Mutation Hooks
export function useAddProgressMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      readId,
      page,
      percent,
      minutes,
    }: {
      readId: string;
      page: number | null;
      percent: number | null;
      minutes?: number;
    }) => api.addProgress(readId, page, percent, minutes),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reads'] });
    },
  });
}

export function useSetReadStatusMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      workId,
      status,
      rating,
      hearted,
    }: {
      workId: string;
      status: string;
      rating?: number | null;
      hearted?: boolean;
    }) => api.setStatus(workId, status, rating, hearted),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reads'] });
      void qc.invalidateQueries({ queryKey: ['work'] });
    },
  });
}
