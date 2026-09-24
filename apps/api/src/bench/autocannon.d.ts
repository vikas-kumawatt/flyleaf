// autocannon 8 ships no type declarations. Only what run.ts uses.
declare module 'autocannon' {
  import type { EventEmitter } from 'node:events';

  interface Request {
    method?: string;
    setupRequest?: (req: Record<string, unknown>) => Record<string, unknown>;
  }
  interface Options {
    url: string;
    connections?: number;
    duration?: number;
    timeout?: number;
    amount?: number;
    requests?: Request[];
  }
  interface Result {
    duration: number;
    errors: number;
    timeouts: number;
    requests?: { sent?: number };
  }
  type Instance = EventEmitter & PromiseLike<Result>;

  function autocannon(opts: Options): Instance;
  export default autocannon;
}
