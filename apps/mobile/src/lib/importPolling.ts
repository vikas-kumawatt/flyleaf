// Polling for the import progress banner (IM-09, audit 12 A-12-022).
//
// Pure, so the rules are testable without rendering: one fetch now, then
// every `intervalMs` while the import is queued or processing; stop on
// completed or failed, calling onDone exactly once; stop when stopped.
// The banner used to restart this whenever its parent re-rendered (an inline
// onComplete in the effect's dependencies), and onComplete re-rendered the
// parent: a request loop for as long as the finished banner stayed up.

export type ImportPollState = { state: string };

export interface ImportPollDeps<T extends ImportPollState> {
  fetch: () => Promise<T>;
  onUpdate: (data: T) => void;
  onDone?: (data: T) => void;
  onError?: (err: unknown) => void;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function startImportPolling<T extends ImportPollState>(deps: ImportPollDeps<T>): () => void {
  const set = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let stopped = false;
  let finished = false;
  let handle: unknown = null;

  const stop = () => {
    stopped = true;
    if (handle !== null) clear(handle);
    handle = null;
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const data = await deps.fetch();
      if (stopped) return;
      deps.onUpdate(data);
      if ((data.state === 'completed' || data.state === 'failed') && !finished) {
        finished = true;
        stop();
        deps.onDone?.(data);
      }
    } catch (err) {
      if (!stopped) deps.onError?.(err);
    }
  };

  void tick();
  handle = set(() => void tick(), deps.intervalMs ?? 2000);
  if (stopped && handle !== null) {
    clear(handle);
    handle = null;
  }
  return stop;
}
