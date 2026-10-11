// Audit 15c (DECISIONS.md questions 6 and 7): migration 0042, the activity
// lookup a review save runs inside the read's lock (A-15-029) and the
// has_works repair's two arms (A-15-027, A-15-032); and the Postgres
// container's /dev/shm (A-15-028). Each test names its finding in
// docs/audit/findings/15-cross-cutting.md.
//
// PGlite is real Postgres, but planner claims are proven on a real server
// (perf/15c/). The plan test here is a regression guard: with the index gone
// the planner has nothing but a seq scan.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork } from './interaction-fixtures.js';

let db: Db;
const rows = async <T,>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];
const one = async <T,>(q: ReturnType<typeof sql>) => (await rows<T>(q))[0]!;

beforeAll(async () => {
  ({ db } = await freshDrizzle());
}, 60_000);

/** The plan's node types and index names, flattened. */
async function planOf(statement: string): Promise<string[]> {
  const [row] = await rows<{ 'QUERY PLAN': unknown }>(sql.raw(`EXPLAIN (FORMAT JSON) ${statement}`));
  const out: string[] = [];
  const walk = (node: Record<string, unknown>) => {
    out.push(String(node['Node Type']));
    if (node['Index Name']) out.push(String(node['Index Name']));
    for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  const plan = row!['QUERY PLAN'] as { Plan: Record<string, unknown> }[] | string;
  walk((typeof plan === 'string' ? JSON.parse(plan) : plan)[0]!.Plan);
  return out;
}

describe('A-15-029: a review save finds its activity row by index, not by scanning activity', () => {
  it('activity_object_idx exists on (object_type, object_id) and is valid', async () => {
    const idx = await rows<{ def: string; valid: boolean }>(sql`
      SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'activity_object_idx'`);
    expect(idx).toHaveLength(1);
    expect(idx[0]!.def).toMatch(/ON public\.activity USING btree \(object_type, object_id\)$/);
    expect(idx[0]!.valid).toBe(true);
  });

  it('syncReviewActivity\'s UPDATE and DELETE, and updateActivityVisibility\'s filter, plan as index scans', async () => {
    const actor = await makeUser(db, 'act15c');
    const work = await makeWork(db, 'Activity Plan');
    // Enough rows that a seq scan is never the cheap choice.
    await db.execute(sql`
      INSERT INTO activity (actor_id, verb, work_id, object_type, object_id, visibility)
      SELECT ${actor.id}::uuid, (ARRAY['reviewed','finished','started'])[1 + g % 3], ${work}::uuid,
             (ARRAY['review','read','read'])[1 + g % 3], gen_random_uuid(), 'public'
      FROM generate_series(1, 20000) g`);
    await db.execute(sql`ANALYZE activity`);
    const id = randomUUID();

    for (const statement of [
      `UPDATE activity SET visibility = 'public', metadata = '{}'::jsonb WHERE object_type = 'review' AND object_id = '${id}'::uuid RETURNING id`,
      `DELETE FROM activity WHERE object_type = 'review' AND object_id = '${id}'::uuid`,
      `UPDATE activity SET visibility = 'followers' WHERE object_type = 'read' AND object_id = '${id}'::uuid`,
    ]) {
      const plan = await planOf(statement);
      expect(plan, statement).toContain('activity_object_idx');
      expect(plan, statement).not.toContain('Seq Scan');
    }
  });
});

describe('A-15-027: the has_works repair, its set arm driven by the range\'s own credits', () => {
  // Fixed ids, so the test chooses which authors fall in which range.
  const A = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const LO = '20000000-0000-0000-0000-000000000000';
  const HI = '40000000-0000-0000-0000-000000000000';
  const flag = async (id: string) => (await one<{ h: boolean }>(sql`SELECT has_works AS h FROM authors WHERE id = ${id}::uuid`)).h;
  const repair = (lo: string, hi: string | null) =>
    one<{ r: { set: number; cleared: number } }>(sql`SELECT repair_author_has_works(${lo}::uuid, ${hi}::uuid) AS r`);

  it('sets and clears inside [lo, hi) only, for every kind of credit, and a second night finds nothing', async () => {
    const live = await makeWork(db, 'Live');
    const merged = await makeWork(db, 'Merged');
    await db.execute(sql`UPDATE works SET merged_into_id = ${live}::uuid WHERE id = ${merged}::uuid`);

    // [id, has_works now, credits as (work, role), expected after the repair]
    const cases: [string, boolean, [string, string][], boolean][] = [];
    for (const prefix of ['1', '2', '3', '5']) {
      cases.push(
        [A(prefix, 1), false, [[live, 'author']], true],                       // missed by an ingest: set
        [A(prefix, 2), false, [[live, 'co_author']], true],                    // any role counts: set
        [A(prefix, 3), true, [[merged, 'author']], false],                     // only a merged-away work: cleared
        [A(prefix, 4), true, [[merged, 'author'], [live, 'translator']], true], // one live credit is enough: kept
        [A(prefix, 5), false, [[merged, 'author']], false],                    // merged-away and unflagged: left
        [A(prefix, 6), false, [], false],                                      // uncredited: left
        [A(prefix, 7), true, [[live, 'author']], true],                        // already right: left
      );
    }
    for (const [id, h] of cases) {
      await db.execute(sql`INSERT INTO authors (id, name, has_works) VALUES (${id}::uuid, ${`Author ${id.slice(0, 1)}${id.slice(-1)}`}, ${h})`);
    }
    // As the ingest writes credits: the has_works trigger bypassed (0020).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('flyleaf.bulk_load', 'on', true)`);
      for (const [id, , credits] of cases) {
        for (const [work, role] of credits) {
          await tx.execute(sql`INSERT INTO work_authors (work_id, author_id, role) VALUES (${work}::uuid, ${id}::uuid, ${role})`);
        }
      }
    });
    const inRange = (id: string) => id >= LO && id < HI;

    // One range: only its own authors change.
    expect((await repair(LO, HI)).r).toEqual({ set: 4, cleared: 2 });
    for (const [id, before, , after] of cases) expect(await flag(id), id).toBe(inRange(id) ? after : before);

    // The open-ended last range and the first range finish the rest.
    expect((await repair(HI, null)).r).toEqual({ set: 2, cleared: 1 });
    expect((await repair('00000000-0000-0000-0000-000000000000', LO)).r).toEqual({ set: 2, cleared: 1 });
    for (const [id, , , after] of cases) expect(await flag(id), id).toBe(after);

    // More calls than PL/pgSQL's five custom plans before it weighs a generic one: nothing left.
    for (let i = 0; i < 8; i++) {
      for (const [lo, hi] of [['00000000-0000-0000-0000-000000000000', LO], [LO, HI], [HI, null]] as const) {
        expect((await repair(lo, hi)).r).toEqual({ set: 0, cleared: 0 });
      }
    }

    // And drift introduced after those calls is still found by the cached function.
    await db.execute(sql`UPDATE authors SET has_works = NOT has_works WHERE id IN (${A('3', 1)}::uuid, ${A('3', 3)}::uuid)`);
    expect((await repair(LO, HI)).r).toEqual({ set: 1, cleared: 1 });
    expect(await flag(A('3', 1))).toBe(true);
    expect(await flag(A('3', 3))).toBe(false);
  });

  it('the set arm has one plan shape: the range\'s live credits by index, then authors by primary key', async () => {
    const [fn] = await rows<{ src: string }>(sql`
      SELECT p.prosrc AS src FROM pg_proc p
      WHERE p.proname = 'repair_author_has_works' AND p.pronargs = 2`);
    const src = fn!.src.replace(/\s+/g, ' ');
    // Before 0042 only the authors scan was bounded, and work_authors and
    // works were joined to it, so a plan could hash all of both per range.
    const setArm = src.slice(src.indexOf('SET has_works = true'), src.indexOf('GET DIAGNOSTICS set_n'));
    expect(setArm).toContain('WHERE a.id = ANY (ARRAY( SELECT wa.author_id FROM work_authors wa WHERE wa.author_id >= lo AND (hi IS NULL OR wa.author_id < hi)');
    // works only as a per-credit scalar subquery, never as a join.
    expect(setArm).toContain('AND (SELECT w.merged_into_id IS NULL FROM works w WHERE w.id = wa.work_id)))');
    expect(setArm).not.toMatch(/JOIN works|EXISTS/);
  });

  it('the set arm\'s plan: an InitPlan over work_authors_author_idx, works_pkey per credit, authors_pkey by = ANY', async () => {
    // The function's statement, prepared as PL/pgSQL prepares it, so the
    // plan is the one the function runs. The shape cannot vary with the
    // range estimates: there is no join for the planner to choose.
    const fnSrc = (await one<{ src: string }>(sql`
      SELECT p.prosrc AS src FROM pg_proc p WHERE p.proname = 'repair_author_has_works' AND p.pronargs = 2`)).src;
    const stmt = fnSrc.slice(fnSrc.indexOf('UPDATE authors a SET has_works = true'), fnSrc.indexOf(';', fnSrc.indexOf('UPDATE authors a SET has_works = true')))
      .replace(/\blo\b/g, `'${LO}'::uuid`).replace(/\bhi\b/g, `'${HI}'::uuid`);
    const plan = await planOf(stmt);
    expect(plan).toEqual(expect.arrayContaining(['work_authors_author_idx', 'works_pkey', 'authors_pkey']));
    expect(plan).not.toContain('Seq Scan');
    expect(plan.filter((n) => /Join|Nested Loop/.test(n))).toEqual([]);
  });

  it('A-15-032: the clear arm filters `has_works IS TRUE`, which cannot pull in the partial GIN index on has_works', async () => {
    const [fn] = await rows<{ src: string }>(sql`
      SELECT p.prosrc AS src FROM pg_proc p
      WHERE p.proname = 'repair_author_has_works' AND p.pronargs = 2`);
    const src = fn!.src.replace(/\s+/g, ' ');
    const clearArm = src.slice(src.indexOf('SET has_works = false'), src.indexOf('GET DIAGNOSTICS cleared_n'));
    expect(clearArm).toContain('x.id >= lo AND (hi IS NULL OR x.id < hi) AND x.has_works IS TRUE AND NOT EXISTS');
    // The index whose predicate a bare `has_works` would satisfy.
    const [idx] = await rows<{ pred: string }>(sql`
      SELECT pg_get_expr(i.indpred, i.indrelid) AS pred FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'authors_credited_trgm_idx'`);
    expect(idx!.pred).toBe('has_works');
  });
});

describe('A-15-028: the Postgres container has room for parallel hash joins in /dev/shm', () => {
  it('docker-compose gives the postgres service shm_size 512m, inside its 3g limit', () => {
    const compose = fs.readFileSync(new URL('../../../../docker-compose.yml', import.meta.url), 'utf8');
    // The postgres service's block: from its key to the next top-level service.
    const block = compose.slice(compose.indexOf('\n  postgres:\n'), compose.indexOf('\n  minio:\n'));
    expect(block).toMatch(/\n {4}shm_size: 512m\n/);
    expect(block).toMatch(/\n {4}mem_limit: 3g\n/);
  });
});
