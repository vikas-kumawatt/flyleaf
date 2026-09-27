// Loading, not-found and error states for a screen that shows one server
// resource (audit 08). The book, author and series screens used to swallow
// every error and show "Loading…" for ever, including for a 404.

import { useCallback, useEffect, useState } from 'react';
import { FlyleafApiError } from '@flyleaf/api-client';

export type RemoteState<T> =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'error' }
  | { state: 'ready'; data: T };

/** A 404 means the thing does not exist (or is not visible): say so, and offer no retry. */
export function stateForError(err: unknown): 'missing' | 'error' {
  return err instanceof FlyleafApiError && err.status === 404 ? 'missing' : 'error';
}

export function useRemote<T>(load: (() => Promise<T>) | null, deps: unknown[]) {
  const [value, setValue] = useState<RemoteState<T>>({ state: 'loading' });

  const run = useCallback(async () => {
    if (!load) return;
    try {
      const data = await load();
      setValue({ state: 'ready', data });
    } catch (err) {
      setValue({ state: stateForError(err) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    setValue({ state: 'loading' });
    void run();
  }, [run]);

  return {
    ...value,
    /** Try again after an error, or refresh after a write. */
    reload: run,
    /** Replace the data locally (an optimistic update). */
    set: (data: T) => setValue({ state: 'ready', data }),
  };
}
