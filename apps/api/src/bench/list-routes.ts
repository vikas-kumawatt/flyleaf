// Prints every route buildApp serves with its rate-limit groups (Audit 15).
import { buildApp } from '../app.js';
import type { Db } from '../platform/index.js';

const stub = {} as never;
const app = await buildApp({ db: {} as Db, identity: stub, catalog: stub, reading: stub, storage: stub, limiter: { allow: async () => true } });
const rows: string[] = [];
app.addHook('onRoute', () => {});
await app.ready();
for (const line of app.printRoutes({ commonPrefix: false, includeHooks: false, method: undefined as never }).split('\n')) rows.push(line);
console.log(rows.join('\n'));
await app.close();
