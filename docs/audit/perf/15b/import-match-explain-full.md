# Import matcher on the full catalog: EXPLAIN (ANALYZE, BUFFERS) of its real statements

Database: `flyleaf` (3.2M works), container under the 3 GiB limit, 2026-10-11. Replaces the full-catalog import-cost runs, which the laptop could not finish (killed by the 300 MB memory guard at 261 MB available). Statements were captured through postgres.js's `debug` hook from `matchImportRow` / `lookupIsbns` themselves (title + author rows with no ISBN, so the title stages run; one ISBN batch), then explained with their parameters. Script (run from `apps/api`, not kept in the repo):

```ts
// 15b item 2 (Part 12's question): EXPLAIN (ANALYZE, BUFFERS) of the import
// matcher's real statements on the full catalog, without an import process.
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './src/db/schema.js';
import { config } from './src/platform/index.js';
import { matchImportRow, lookupIsbns } from './src/imports/matcher.js';
import type { NormalizedImportRow } from './src/imports/types.js';

let recording = false;
const seen: { query: string; params: unknown[] }[] = [];
const client = postgres(config.databaseUrl, {
  max: 1, onnotice: () => {},
  connection: { 'pg_trgm.similarity_threshold': '0.45' },
  debug: (_c, query, params) => { if (recording) seen.push({ query, params: params as unknown[] }); },
});
const db = drizzle(client, { schema }) as never;
const row = (title: string, author: string): NormalizedImportRow =>
  ({ rowNo: 1, raw: {}, title, author, additionalAuthors: [], isbn: null, isbn10: null, isbn13: null, sourceId: null } as unknown as NormalizedImportRow);

const cases: [string, () => Promise<unknown>][] = [
  ['ISBN batch (Dune 9780441013593, Emma 9780141439587, Piranesi 9781635575637)', () => lookupIsbns(db, ['9780441013593', '9780141439587', '9781635575637'])],
  ['title: Dune / Frank Herbert', () => matchImportRow(db, row('Dune', 'Frank Herbert'), new Map())],
  ['title: It / Stephen King', () => matchImportRow(db, row('It', 'Stephen King'), new Map())],
  ['title: Emma / Jane Austen', () => matchImportRow(db, row('Emma', 'Jane Austen'), new Map())],
  ['title: The Remains of the Day / Kazuo Ishiguro', () => matchImportRow(db, row('The Remains of the Day', 'Kazuo Ishiguro'), new Map())],
  ['title: Piranesi / Susanna Clarke', () => matchImportRow(db, row('Piranesi', 'Susanna Clarke'), new Map())],
];
await client`select 1`; // type metadata, kept out
for (const [label, run] of cases) {
  seen.length = 0; recording = true;
  const t0 = performance.now(); const result = await run(); const ms = performance.now() - t0;
  recording = false;
  const stmts = [...seen];
  const r = result instanceof Map ? `${result.size} ISBN keys` : JSON.stringify({ state: (result as any).state, strategy: (result as any).strategy, confidence: (result as any).confidence });
  console.log(`\n## ${label}\n\n${stmts.length} statements, ${ms.toFixed(0)} ms (first run, before EXPLAIN re-runs), result ${r}\n`);
  for (const [i, s] of stmts.entries()) {
    if (!/^\s*(select|with)\b/i.test(s.query)) { console.log(`### Statement ${i + 1} (not a read, not explained)\n`); continue; }
    const plan = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${s.query}`, s.params as never[]);
    console.log(`### Statement ${i + 1}\n\n\`\`\`sql\n${s.query.trim()}\n\`\`\`\nparams: ${JSON.stringify(s.params)}\n\n\`\`\`\n${plan.map((p: any) => p['QUERY PLAN']).join('\n')}\n\`\`\`\n`);
  }
}
await client.end();
```

Outcomes (same rows through matchImportRow): Dune, Emma, The Remains of the Day, Piranesi → unmatched / ambiguous_match (2–5 candidates at 0.92: unmerged duplicate works); It / Stephen King → matched, exact_title_author 0.92.

## ISBN batch (Dune 9780441013593, Emma 9780141439587, Piranesi 9781635575637)

1 statements, 41 ms (first run, before EXPLAIN re-runs), result 3 ISBN keys

### Statement 1

```sql
SELECT e.id AS edition_id, e.work_id, w.title AS work_title, e.isbn_13, e.isbn_10
    FROM editions e
    JOIN works w ON w.id = e.work_id
    WHERE (e.isbn_13 IN ($1, $2, $3) OR e.isbn_10 IN ($4, $5, $6))
      AND w.merged_into_id IS NULL
      AND w.is_provisional = false
    ORDER BY w.log_count DESC, e.publish_year DESC NULLS LAST, e.id
```
params: ["9780441013593","9780141439587","9781635575637","9780441013593","9780141439587","9781635575637"]

```
Sort  (cost=126.33..126.35 rows=8 width=94) (actual time=0.220..0.222 rows=7.00 loops=1)
  Sort Key: ((w.ol_log_count + w.reader_count)) DESC, e.publish_year DESC NULLS LAST, e.id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=51
  ->  Nested Loop  (cost=27.07..126.21 rows=8 width=94) (actual time=0.137..0.191 rows=7.00 loops=1)
        Buffers: shared hit=51
        ->  Bitmap Heap Scan on editions e  (cost=26.64..58.61 rows=8 width=61) (actual time=0.102..0.111 rows=7.00 loops=1)
              Recheck Cond: ((isbn_13 = ANY ('{9780441013593,9780141439587,9781635575637}'::text[])) OR (isbn_10 = ANY ('{9780441013593,9780141439587,9781635575637}'::text[])))
              Heap Blocks: exact=5
              Buffers: shared hit=23
              ->  BitmapOr  (cost=26.64..26.64 rows=8 width=0) (actual time=0.073..0.074 rows=0.00 loops=1)
                    Buffers: shared hit=18
                    ->  Bitmap Index Scan on editions_isbn13_idx  (cost=0.00..13.32 rows=3 width=0) (actual time=0.055..0.055 rows=7.00 loops=1)
                          Index Cond: (isbn_13 = ANY ('{9780441013593,9780141439587,9781635575637}'::text[]))
                          Index Searches: 3
                          Buffers: shared hit=9
                    ->  Bitmap Index Scan on editions_isbn10_idx  (cost=0.00..13.32 rows=4 width=0) (actual time=0.017..0.017 rows=0.00 loops=1)
                          Index Cond: (isbn_10 = ANY ('{9780441013593,9780141439587,9781635575637}'::text[]))
                          Index Searches: 3
                          Buffers: shared hit=9
        ->  Index Scan using works_pkey on works w  (cost=0.43..8.45 rows=1 width=53) (actual time=0.010..0.010 rows=1.00 loops=7)
              Index Cond: (id = e.work_id)
              Filter: ((merged_into_id IS NULL) AND (NOT is_provisional))
              Index Searches: 7
              Buffers: shared hit=28
Planning:
  Buffers: shared hit=17
Planning Time: 0.702 ms
Execution Time: 0.434 ms
```


## title: Dune / Frank Herbert

1 statements, 912 ms (first run, before EXPLAIN re-runs), result {"state":"unmatched","strategy":null,"confidence":0.5}

### Statement 1

```sql
SELECT
      w.id AS work_id,
      w.title AS work_title,
      COALESCE(
        w.default_edition_id,
        (SELECT e.id FROM editions e WHERE e.work_id = w.id ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)
      ) AS edition_id,
      (
        SELECT a.name
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
        ORDER BY wa.position, a.name
        LIMIT 1
      ) AS author_name
    FROM works w
    WHERE w.merged_into_id IS NULL
      AND w.is_provisional = false
      AND (w.title ILIKE $1 ESCAPE '\' OR w.title %> $2)
      AND (
        lower(w.title) = lower($3)
        OR btrim(regexp_replace(
             regexp_replace(
               regexp_replace(lower(split_part(w.title, ':', 1)), '^(the|a|an)\s+', ''),
               '[[:punct:]]', ' ', 'g'),
             '\s+', ' ', 'g')) = $4
      )
      AND EXISTS (
        SELECT 1
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
          AND (
            lower(a.name) = lower($5)
            OR lower(a.name) LIKE $6 ESCAPE '\'
            OR lower($7) LIKE ('%' || replace(replace(replace(lower(a.name), '\', '\\'), '%', '\%'), '_', '\_') || '%') ESCAPE '\'
          )
      )
    ORDER BY w.log_count DESC
    LIMIT 5
```
params: ["Dune","dune","Dune","dune","Frank Herbert","%frank herbert%","Frank Herbert"]

```
Limit  (cost=2747.44..2853.40 rows=1 width=97) (actual time=182.929..183.108 rows=5.00 loops=1)
  Buffers: shared hit=7474
  ->  Result  (cost=2747.44..2853.40 rows=1 width=97) (actual time=182.928..183.105 rows=5.00 loops=1)
        Buffers: shared hit=7474
        ->  Sort  (cost=2747.44..2747.44 rows=1 width=65) (actual time=182.592..182.595 rows=5.00 loops=1)
              Sort Key: ((w.ol_log_count + w.reader_count)) DESC
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=7172
              ->  Nested Loop Semi Join  (cost=209.57..2747.43 rows=1 width=65) (actual time=42.519..182.576 rows=6.00 loops=1)
                    Buffers: shared hit=7172
                    ->  Bitmap Heap Scan on works w  (cost=208.58..2686.25 rows=6 width=69) (actual time=42.387..181.530 rows=28.00 loops=1)
                          Recheck Cond: ((title ~~* 'Dune'::text) OR (title %> 'dune'::text))
                          Rows Removed by Index Recheck: 3459
                          Filter: ((merged_into_id IS NULL) AND (NOT is_provisional) AND ((lower(title) = 'dune'::text) OR (btrim(regexp_replace(regexp_replace(regexp_replace(lower(split_part(title, ':'::text, 1)), '^(the|a|an)\s+'::text, ''::text), '[[:punct:]]'::text, ' '::text, 'g'::text), '\s+'::text, ' '::text, 'g'::text)) = 'dune'::text)))
                          Rows Removed by Filter: 2371
                          Heap Blocks: exact=5728
                          Buffers: shared hit=6815
                          ->  BitmapOr  (cost=208.58..208.58 rows=640 width=0) (actual time=40.949..40.951 rows=0.00 loops=1)
                                Buffers: shared hit=1087
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..104.29 rows=320 width=0) (actual time=15.798..15.798 rows=168.00 loops=1)
                                      Index Cond: (title ~~* 'Dune'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=554
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..104.29 rows=320 width=0) (actual time=25.150..25.150 rows=5858.00 loops=1)
                                      Index Cond: (title %> 'dune'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=533
                    ->  Nested Loop  (cost=0.99..10.19 rows=1 width=16) (actual time=0.035..0.035 rows=0.21 loops=28)
                          Buffers: shared hit=357
                          ->  Index Only Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.43..5.11 rows=1 width=32) (actual time=0.011..0.012 rows=1.93 loops=28)
                                Index Cond: (work_id = w.id)
                                Heap Fetches: 0
                                Index Searches: 28
                                Buffers: shared hit=87
                          ->  Index Scan using authors_pkey on authors a  (cost=0.56..5.07 rows=1 width=16) (actual time=0.011..0.011 rows=0.11 loops=54)
                                Index Cond: (id = wa.author_id)
                                Filter: ((lower(name) = 'frank herbert'::text) OR (lower(name) ~~ '%frank herbert%'::text) OR ('frank herbert'::text ~~ like_escape((('%'::text || replace(replace(replace(lower(name), '\'::text, '\\'::text), '%'::text, '\%'::text), '_'::text, '\_'::text)) || '%'::text), '\'::text)))
                                Rows Removed by Filter: 1
                                Index Searches: 54
                                Buffers: shared hit=270
        SubPlan 1
          ->  Limit  (cost=88.90..88.91 rows=1 width=20) (actual time=0.058..0.058 rows=1.00 loops=5)
                Buffers: shared hit=172
                ->  Sort  (cost=88.90..88.96 rows=21 width=20) (actual time=0.058..0.058 rows=1.00 loops=5)
                      Sort Key: e.publish_year DESC NULLS LAST
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=172
                      ->  Index Scan using editions_work_idx on editions e  (cost=0.43..88.80 rows=21 width=20) (actual time=0.019..0.049 rows=31.40 loops=5)
                            Index Cond: (work_id = w.id)
                            Index Searches: 5
                            Buffers: shared hit=172
        SubPlan 2
          ->  Limit  (cost=17.04..17.04 rows=1 width=25) (actual time=0.040..0.040 rows=1.00 loops=5)
                Buffers: shared hit=130
                ->  Sort  (cost=17.04..17.04 rows=1 width=25) (actual time=0.039..0.039 rows=1.00 loops=5)
                      Sort Key: wa_1."position", a_1.name
                      Sort Method: top-N heapsort  Memory: 25kB
                      Buffers: shared hit=130
                      ->  Nested Loop  (cost=0.99..17.03 rows=1 width=25) (actual time=0.021..0.035 rows=4.40 loops=5)
                            Buffers: shared hit=130
                            ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa_1  (cost=0.43..8.45 rows=1 width=20) (actual time=0.012..0.013 rows=4.40 loops=5)
                                  Index Cond: (work_id = w.id)
                                  Index Searches: 5
                                  Buffers: shared hit=20
                            ->  Index Scan using authors_pkey on authors a_1  (cost=0.56..8.58 rows=1 width=37) (actual time=0.004..0.004 rows=1.00 loops=22)
                                  Index Cond: (id = wa_1.author_id)
                                  Index Searches: 22
                                  Buffers: shared hit=110
Planning:
  Buffers: shared hit=55
Planning Time: 3.321 ms
Execution Time: 183.823 ms
```


## title: It / Stephen King

1 statements, 3728 ms (first run, before EXPLAIN re-runs), result {"state":"matched","strategy":"exact_title_author","confidence":0.92}

### Statement 1

```sql
SELECT
      w.id AS work_id,
      w.title AS work_title,
      COALESCE(
        w.default_edition_id,
        (SELECT e.id FROM editions e WHERE e.work_id = w.id ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)
      ) AS edition_id,
      (
        SELECT a.name
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
        ORDER BY wa.position, a.name
        LIMIT 1
      ) AS author_name
    FROM works w
    WHERE w.merged_into_id IS NULL
      AND w.is_provisional = false
      AND (w.title ILIKE $1 ESCAPE '\' OR w.title %> $2)
      AND (
        lower(w.title) = lower($3)
        OR btrim(regexp_replace(
             regexp_replace(
               regexp_replace(lower(split_part(w.title, ':', 1)), '^(the|a|an)\s+', ''),
               '[[:punct:]]', ' ', 'g'),
             '\s+', ' ', 'g')) = $4
      )
      AND EXISTS (
        SELECT 1
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
          AND (
            lower(a.name) = lower($5)
            OR lower(a.name) LIKE $6 ESCAPE '\'
            OR lower($7) LIKE ('%' || replace(replace(replace(lower(a.name), '\', '\\'), '%', '\%'), '_', '\_') || '%') ESCAPE '\'
          )
      )
    ORDER BY w.log_count DESC
    LIMIT 5
```
params: ["It","it","It","it","Stephen King","%stephen king%","Stephen King"]

```
Limit  (cost=2687.34..2793.30 rows=1 width=97) (actual time=1170.884..1170.891 rows=1.00 loops=1)
  Buffers: shared hit=33114 read=152
  ->  Result  (cost=2687.34..2793.30 rows=1 width=97) (actual time=1170.883..1170.889 rows=1.00 loops=1)
        Buffers: shared hit=33114 read=152
        ->  Sort  (cost=2687.34..2687.34 rows=1 width=65) (actual time=1170.464..1170.467 rows=1.00 loops=1)
              Sort Key: ((w.ol_log_count + w.reader_count)) DESC
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=33014 read=152
              ->  Nested Loop Semi Join  (cost=149.47..2687.33 rows=1 width=65) (actual time=1095.500..1170.440 rows=1.00 loops=1)
                    Buffers: shared hit=33014 read=152
                    ->  Bitmap Heap Scan on works w  (cost=148.48..2626.15 rows=6 width=69) (actual time=160.807..1169.488 rows=15.00 loops=1)
                          Recheck Cond: ((title ~~* 'It'::text) OR (title %> 'it'::text))
                          Rows Removed by Index Recheck: 5273
                          Filter: ((merged_into_id IS NULL) AND (NOT is_provisional) AND ((lower(title) = 'it'::text) OR (btrim(regexp_replace(regexp_replace(regexp_replace(lower(split_part(title, ':'::text, 1)), '^(the|a|an)\s+'::text, ''::text), '[[:punct:]]'::text, ' '::text, 'g'::text), '\s+'::text, ' '::text, 'g'::text)) = 'it'::text)))
                          Rows Removed by Filter: 30799
                          Heap Blocks: exact=32172
                          Buffers: shared hit=32873 read=152
                          ->  BitmapOr  (cost=148.48..148.48 rows=640 width=0) (actual time=60.105..60.106 rows=0.00 loops=1)
                                Buffers: shared hit=853
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..74.24 rows=320 width=0) (actual time=32.326..32.327 rows=15183.00 loops=1)
                                      Index Cond: (title ~~* 'It'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=439
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..74.24 rows=320 width=0) (actual time=27.775..27.776 rows=36089.00 loops=1)
                                      Index Cond: (title %> 'it'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=414
                    ->  Nested Loop  (cost=0.99..10.19 rows=1 width=16) (actual time=0.058..0.058 rows=0.07 loops=15)
                          Buffers: shared hit=141
                          ->  Index Only Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.43..5.11 rows=1 width=32) (actual time=0.023..0.024 rows=1.27 loops=15)
                                Index Cond: (work_id = w.id)
                                Heap Fetches: 0
                                Index Searches: 15
                                Buffers: shared hit=46
                          ->  Index Scan using authors_pkey on authors a  (cost=0.56..5.07 rows=1 width=16) (actual time=0.022..0.022 rows=0.05 loops=19)
                                Index Cond: (id = wa.author_id)
                                Filter: ((lower(name) = 'stephen king'::text) OR (lower(name) ~~ '%stephen king%'::text) OR ('stephen king'::text ~~ like_escape((('%'::text || replace(replace(replace(lower(name), '\'::text, '\\'::text), '%'::text, '\%'::text), '_'::text, '\_'::text)) || '%'::text), '\'::text)))
                                Rows Removed by Filter: 1
                                Index Searches: 19
                                Buffers: shared hit=95
        SubPlan 1
          ->  Limit  (cost=88.90..88.91 rows=1 width=20) (actual time=0.243..0.243 rows=1.00 loops=1)
                Buffers: shared hit=91
                ->  Sort  (cost=88.90..88.96 rows=21 width=20) (actual time=0.241..0.242 rows=1.00 loops=1)
                      Sort Key: e.publish_year DESC NULLS LAST
                      Sort Method: top-N heapsort  Memory: 25kB
                      Buffers: shared hit=91
                      ->  Index Scan using editions_work_idx on editions e  (cost=0.43..88.80 rows=21 width=20) (actual time=0.092..0.214 rows=88.00 loops=1)
                            Index Cond: (work_id = w.id)
                            Index Searches: 1
                            Buffers: shared hit=91
        SubPlan 2
          ->  Limit  (cost=17.04..17.04 rows=1 width=25) (actual time=0.164..0.165 rows=1.00 loops=1)
                Buffers: shared hit=9
                ->  Sort  (cost=17.04..17.04 rows=1 width=25) (actual time=0.164..0.164 rows=1.00 loops=1)
                      Sort Key: wa_1."position", a_1.name
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=9
                      ->  Nested Loop  (cost=0.99..17.03 rows=1 width=25) (actual time=0.148..0.150 rows=1.00 loops=1)
                            Buffers: shared hit=9
                            ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa_1  (cost=0.43..8.45 rows=1 width=20) (actual time=0.027..0.028 rows=1.00 loops=1)
                                  Index Cond: (work_id = w.id)
                                  Index Searches: 1
                                  Buffers: shared hit=4
                            ->  Index Scan using authors_pkey on authors a_1  (cost=0.56..8.58 rows=1 width=37) (actual time=0.117..0.117 rows=1.00 loops=1)
                                  Index Cond: (id = wa_1.author_id)
                                  Index Searches: 1
                                  Buffers: shared hit=5
Planning:
  Buffers: shared hit=55
Planning Time: 3.393 ms
Execution Time: 1171.888 ms
```


## title: Emma / Jane Austen

1 statements, 1203 ms (first run, before EXPLAIN re-runs), result {"state":"unmatched","strategy":null,"confidence":0.5}

### Statement 1

```sql
SELECT
      w.id AS work_id,
      w.title AS work_title,
      COALESCE(
        w.default_edition_id,
        (SELECT e.id FROM editions e WHERE e.work_id = w.id ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)
      ) AS edition_id,
      (
        SELECT a.name
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
        ORDER BY wa.position, a.name
        LIMIT 1
      ) AS author_name
    FROM works w
    WHERE w.merged_into_id IS NULL
      AND w.is_provisional = false
      AND (w.title ILIKE $1 ESCAPE '\' OR w.title %> $2)
      AND (
        lower(w.title) = lower($3)
        OR btrim(regexp_replace(
             regexp_replace(
               regexp_replace(lower(split_part(w.title, ':', 1)), '^(the|a|an)\s+', ''),
               '[[:punct:]]', ' ', 'g'),
             '\s+', ' ', 'g')) = $4
      )
      AND EXISTS (
        SELECT 1
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
          AND (
            lower(a.name) = lower($5)
            OR lower(a.name) LIKE $6 ESCAPE '\'
            OR lower($7) LIKE ('%' || replace(replace(replace(lower(a.name), '\', '\\'), '%', '\%'), '_', '\_') || '%') ESCAPE '\'
          )
      )
    ORDER BY w.log_count DESC
    LIMIT 5
```
params: ["Emma","emma","Emma","emma","Jane Austen","%jane austen%","Jane Austen"]

```
Limit  (cost=2747.44..2853.40 rows=1 width=97) (actual time=72.739..72.860 rows=5.00 loops=1)
  Buffers: shared hit=4774
  ->  Result  (cost=2747.44..2853.40 rows=1 width=97) (actual time=72.737..72.857 rows=5.00 loops=1)
        Buffers: shared hit=4774
        ->  Sort  (cost=2747.44..2747.44 rows=1 width=65) (actual time=69.902..69.907 rows=5.00 loops=1)
              Sort Key: ((w.ol_log_count + w.reader_count)) DESC
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=2973
              ->  Nested Loop Semi Join  (cost=209.57..2747.43 rows=1 width=65) (actual time=31.432..69.890 rows=5.00 loops=1)
                    Buffers: shared hit=2973
                    ->  Bitmap Heap Scan on works w  (cost=208.58..2686.25 rows=6 width=69) (actual time=31.330..69.166 rows=25.00 loops=1)
                          Recheck Cond: ((title ~~* 'Emma'::text) OR (title %> 'emma'::text))
                          Rows Removed by Index Recheck: 531
                          Filter: ((merged_into_id IS NULL) AND (NOT is_provisional) AND ((lower(title) = 'emma'::text) OR (btrim(regexp_replace(regexp_replace(regexp_replace(lower(split_part(title, ':'::text, 1)), '^(the|a|an)\s+'::text, ''::text), '[[:punct:]]'::text, ' '::text, 'g'::text), '\s+'::text, ' '::text, 'g'::text)) = 'emma'::text)))
                          Rows Removed by Filter: 1380
                          Heap Blocks: exact=1920
                          Buffers: shared hit=2750
                          ->  BitmapOr  (cost=208.58..208.58 rows=640 width=0) (actual time=30.886..30.888 rows=0.00 loops=1)
                                Buffers: shared hit=830
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..104.29 rows=320 width=0) (actual time=11.254..11.255 rows=501.00 loops=1)
                                      Index Cond: (title ~~* 'Emma'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=428
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..104.29 rows=320 width=0) (actual time=19.630..19.630 rows=1936.00 loops=1)
                                      Index Cond: (title %> 'emma'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=402
                    ->  Nested Loop  (cost=0.99..10.19 rows=1 width=16) (actual time=0.027..0.027 rows=0.20 loops=25)
                          Buffers: shared hit=223
                          ->  Index Only Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.43..5.11 rows=1 width=32) (actual time=0.010..0.010 rows=1.16 loops=25)
                                Index Cond: (work_id = w.id)
                                Heap Fetches: 0
                                Index Searches: 25
                                Buffers: shared hit=78
                          ->  Index Scan using authors_pkey on authors a  (cost=0.56..5.07 rows=1 width=16) (actual time=0.014..0.014 rows=0.17 loops=29)
                                Index Cond: (id = wa.author_id)
                                Filter: ((lower(name) = 'jane austen'::text) OR (lower(name) ~~ '%jane austen%'::text) OR ('jane austen'::text ~~ like_escape((('%'::text || replace(replace(replace(lower(name), '\'::text, '\\'::text), '%'::text, '\%'::text), '_'::text, '\_'::text)) || '%'::text), '\'::text)))
                                Rows Removed by Filter: 1
                                Index Searches: 29
                                Buffers: shared hit=145
        SubPlan 1
          ->  Limit  (cost=88.90..88.91 rows=1 width=20) (actual time=0.696..0.697 rows=1.00 loops=4)
                Buffers: shared hit=1746
                ->  Sort  (cost=88.90..88.96 rows=21 width=20) (actual time=0.695..0.695 rows=1.00 loops=4)
                      Sort Key: e.publish_year DESC NULLS LAST
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=1746
                      ->  Index Scan using editions_work_idx on editions e  (cost=0.43..88.80 rows=21 width=20) (actual time=0.028..0.603 rows=540.00 loops=4)
                            Index Cond: (work_id = w.id)
                            Index Searches: 4
                            Buffers: shared hit=1746
        SubPlan 2
          ->  Limit  (cost=17.04..17.04 rows=1 width=25) (actual time=0.029..0.029 rows=1.00 loops=5)
                Buffers: shared hit=55
                ->  Sort  (cost=17.04..17.04 rows=1 width=25) (actual time=0.029..0.029 rows=1.00 loops=5)
                      Sort Key: wa_1."position", a_1.name
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=55
                      ->  Nested Loop  (cost=0.99..17.03 rows=1 width=25) (actual time=0.023..0.026 rows=1.40 loops=5)
                            Buffers: shared hit=55
                            ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa_1  (cost=0.43..8.45 rows=1 width=20) (actual time=0.010..0.011 rows=1.40 loops=5)
                                  Index Cond: (work_id = w.id)
                                  Index Searches: 5
                                  Buffers: shared hit=20
                            ->  Index Scan using authors_pkey on authors a_1  (cost=0.56..8.58 rows=1 width=37) (actual time=0.010..0.010 rows=1.00 loops=7)
                                  Index Cond: (id = wa_1.author_id)
                                  Index Searches: 7
                                  Buffers: shared hit=35
Planning:
  Buffers: shared hit=55
Planning Time: 3.163 ms
Execution Time: 73.434 ms
```


## title: The Remains of the Day / Kazuo Ishiguro

1 statements, 819 ms (first run, before EXPLAIN re-runs), result {"state":"unmatched","strategy":null,"confidence":0.5}

### Statement 1

```sql
SELECT
      w.id AS work_id,
      w.title AS work_title,
      COALESCE(
        w.default_edition_id,
        (SELECT e.id FROM editions e WHERE e.work_id = w.id ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)
      ) AS edition_id,
      (
        SELECT a.name
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
        ORDER BY wa.position, a.name
        LIMIT 1
      ) AS author_name
    FROM works w
    WHERE w.merged_into_id IS NULL
      AND w.is_provisional = false
      AND (w.title ILIKE $1 ESCAPE '\' OR w.title %> $2)
      AND (
        lower(w.title) = lower($3)
        OR btrim(regexp_replace(
             regexp_replace(
               regexp_replace(lower(split_part(w.title, ':', 1)), '^(the|a|an)\s+', ''),
               '[[:punct:]]', ' ', 'g'),
             '\s+', ' ', 'g')) = $4
      )
      AND EXISTS (
        SELECT 1
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
          AND (
            lower(a.name) = lower($5)
            OR lower(a.name) LIKE $6 ESCAPE '\'
            OR lower($7) LIKE ('%' || replace(replace(replace(lower(a.name), '\', '\\'), '%', '\%'), '_', '\_') || '%') ESCAPE '\'
          )
      )
    ORDER BY w.log_count DESC
    LIMIT 5
```
params: ["The Remains of the Day","remains of the day","The Remains of the Day","remains of the day","Kazuo Ishiguro","%kazuo ishiguro%","Kazuo Ishiguro"]

```
Limit  (cost=3176.39..3282.35 rows=1 width=97) (actual time=510.325..510.379 rows=3.00 loops=1)
  Buffers: shared hit=10654
  ->  Result  (cost=3176.39..3282.35 rows=1 width=97) (actual time=510.323..510.376 rows=3.00 loops=1)
        Buffers: shared hit=10654
        ->  Sort  (cost=3176.39..3176.39 rows=1 width=65) (actual time=509.992..509.996 rows=3.00 loops=1)
              Sort Key: ((w.ol_log_count + w.reader_count)) DESC
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=10532
              ->  Nested Loop Semi Join  (cost=638.52..3176.38 rows=1 width=65) (actual time=414.902..509.983 rows=3.00 loops=1)
                    Buffers: shared hit=10532
                    ->  Bitmap Heap Scan on works w  (cost=637.53..3115.20 rows=6 width=69) (actual time=414.745..509.715 rows=3.00 loops=1)
                          Recheck Cond: ((title ~~* 'The Remains of the Day'::text) OR (title %> 'remains of the day'::text))
                          Rows Removed by Index Recheck: 1549
                          Filter: ((merged_into_id IS NULL) AND (NOT is_provisional) AND ((lower(title) = 'the remains of the day'::text) OR (btrim(regexp_replace(regexp_replace(regexp_replace(lower(split_part(title, ':'::text, 1)), '^(the|a|an)\s+'::text, ''::text), '[[:punct:]]'::text, ' '::text, 'g'::text), '\s+'::text, ' '::text, 'g'::text)) = 'remains of the day'::text)))
                          Rows Removed by Filter: 91
                          Heap Blocks: exact=1627
                          Buffers: shared hit=10507
                          ->  BitmapOr  (cost=637.53..637.53 rows=640 width=0) (actual time=414.318..414.320 rows=0.00 loops=1)
                                Buffers: shared hit=8880
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..318.76 rows=320 width=0) (actual time=120.559..120.559 rows=6.00 loops=1)
                                      Index Cond: (title ~~* 'The Remains of the Day'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=4589
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..318.76 rows=320 width=0) (actual time=293.756..293.757 rows=1643.00 loops=1)
                                      Index Cond: (title %> 'remains of the day'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=4291
                    ->  Nested Loop  (cost=0.99..10.19 rows=1 width=16) (actual time=0.068..0.068 rows=1.00 loops=3)
                          Buffers: shared hit=25
                          ->  Index Only Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.43..5.11 rows=1 width=32) (actual time=0.029..0.029 rows=1.00 loops=3)
                                Index Cond: (work_id = w.id)
                                Heap Fetches: 0
                                Index Searches: 3
                                Buffers: shared hit=10
                          ->  Index Scan using authors_pkey on authors a  (cost=0.56..5.07 rows=1 width=16) (actual time=0.034..0.034 rows=1.00 loops=3)
                                Index Cond: (id = wa.author_id)
                                Filter: ((lower(name) = 'kazuo ishiguro'::text) OR (lower(name) ~~ '%kazuo ishiguro%'::text) OR ('kazuo ishiguro'::text ~~ like_escape((('%'::text || replace(replace(replace(lower(name), '\'::text, '\\'::text), '%'::text, '\%'::text), '_'::text, '\_'::text)) || '%'::text), '\'::text)))
                                Index Searches: 3
                                Buffers: shared hit=15
        SubPlan 1
          ->  Limit  (cost=88.90..88.91 rows=1 width=20) (actual time=0.118..0.119 rows=1.00 loops=2)
                Buffers: shared hit=95
                ->  Sort  (cost=88.90..88.96 rows=21 width=20) (actual time=0.117..0.117 rows=1.00 loops=2)
                      Sort Key: e.publish_year DESC NULLS LAST
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=95
                      ->  Index Scan using editions_work_idx on editions e  (cost=0.43..88.80 rows=21 width=20) (actual time=0.037..0.092 rows=42.00 loops=2)
                            Index Cond: (work_id = w.id)
                            Index Searches: 2
                            Buffers: shared hit=95
        SubPlan 2
          ->  Limit  (cost=17.04..17.04 rows=1 width=25) (actual time=0.041..0.042 rows=1.00 loops=3)
                Buffers: shared hit=27
                ->  Sort  (cost=17.04..17.04 rows=1 width=25) (actual time=0.041..0.041 rows=1.00 loops=3)
                      Sort Key: wa_1."position", a_1.name
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=27
                      ->  Nested Loop  (cost=0.99..17.03 rows=1 width=25) (actual time=0.033..0.034 rows=1.00 loops=3)
                            Buffers: shared hit=27
                            ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa_1  (cost=0.43..8.45 rows=1 width=20) (actual time=0.019..0.020 rows=1.00 loops=3)
                                  Index Cond: (work_id = w.id)
                                  Index Searches: 3
                                  Buffers: shared hit=12
                            ->  Index Scan using authors_pkey on authors a_1  (cost=0.56..8.58 rows=1 width=37) (actual time=0.012..0.012 rows=1.00 loops=3)
                                  Index Cond: (id = wa_1.author_id)
                                  Index Searches: 3
                                  Buffers: shared hit=15
Planning:
  Buffers: shared hit=55
Planning Time: 3.461 ms
Execution Time: 511.264 ms
```


## title: Piranesi / Susanna Clarke

1 statements, 176 ms (first run, before EXPLAIN re-runs), result {"state":"unmatched","strategy":null,"confidence":0.5}

### Statement 1

```sql
SELECT
      w.id AS work_id,
      w.title AS work_title,
      COALESCE(
        w.default_edition_id,
        (SELECT e.id FROM editions e WHERE e.work_id = w.id ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)
      ) AS edition_id,
      (
        SELECT a.name
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
        ORDER BY wa.position, a.name
        LIMIT 1
      ) AS author_name
    FROM works w
    WHERE w.merged_into_id IS NULL
      AND w.is_provisional = false
      AND (w.title ILIKE $1 ESCAPE '\' OR w.title %> $2)
      AND (
        lower(w.title) = lower($3)
        OR btrim(regexp_replace(
             regexp_replace(
               regexp_replace(lower(split_part(w.title, ':', 1)), '^(the|a|an)\s+', ''),
               '[[:punct:]]', ' ', 'g'),
             '\s+', ' ', 'g')) = $4
      )
      AND EXISTS (
        SELECT 1
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
          AND (
            lower(a.name) = lower($5)
            OR lower(a.name) LIKE $6 ESCAPE '\'
            OR lower($7) LIKE ('%' || replace(replace(replace(lower(a.name), '\', '\\'), '%', '\%'), '_', '\_') || '%') ESCAPE '\'
          )
      )
    ORDER BY w.log_count DESC
    LIMIT 5
```
params: ["Piranesi","piranesi","Piranesi","piranesi","Susanna Clarke","%susanna clarke%","Susanna Clarke"]

```
Limit  (cost=2867.64..2973.60 rows=1 width=97) (actual time=68.732..68.759 rows=2.00 loops=1)
  Buffers: shared hit=1593
  ->  Result  (cost=2867.64..2973.60 rows=1 width=97) (actual time=68.731..68.758 rows=2.00 loops=1)
        Buffers: shared hit=1593
        ->  Sort  (cost=2867.64..2867.64 rows=1 width=65) (actual time=68.513..68.517 rows=2.00 loops=1)
              Sort Key: ((w.ol_log_count + w.reader_count)) DESC
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=1549
              ->  Nested Loop Semi Join  (cost=329.77..2867.63 rows=1 width=65) (actual time=65.983..68.496 rows=2.00 loops=1)
                    Buffers: shared hit=1549
                    ->  Bitmap Heap Scan on works w  (cost=328.78..2806.45 rows=6 width=69) (actual time=65.880..68.285 rows=5.00 loops=1)
                          Recheck Cond: ((title ~~* 'Piranesi'::text) OR (title %> 'piranesi'::text))
                          Rows Removed by Index Recheck: 39
                          Filter: ((merged_into_id IS NULL) AND (NOT is_provisional) AND ((lower(title) = 'piranesi'::text) OR (btrim(regexp_replace(regexp_replace(regexp_replace(lower(split_part(title, ':'::text, 1)), '^(the|a|an)\s+'::text, ''::text), '[[:punct:]]'::text, ' '::text, 'g'::text), '\s+'::text, ' '::text, 'g'::text)) = 'piranesi'::text)))
                          Rows Removed by Filter: 17
                          Heap Blocks: exact=61
                          Buffers: shared hit=1508
                          ->  BitmapOr  (cost=328.78..328.78 rows=640 width=0) (actual time=65.834..65.836 rows=0.00 loops=1)
                                Buffers: shared hit=1447
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..164.39 rows=320 width=0) (actual time=24.814..24.814 rows=21.00 loops=1)
                                      Index Cond: (title ~~* 'Piranesi'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=740
                                ->  Bitmap Index Scan on works_title_trgm_idx  (cost=0.00..164.39 rows=320 width=0) (actual time=41.018..41.019 rows=61.00 loops=1)
                                      Index Cond: (title %> 'piranesi'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=707
                    ->  Nested Loop  (cost=0.99..10.19 rows=1 width=16) (actual time=0.038..0.038 rows=0.40 loops=5)
                          Buffers: shared hit=41
                          ->  Index Only Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.43..5.11 rows=1 width=32) (actual time=0.018..0.018 rows=1.00 loops=5)
                                Index Cond: (work_id = w.id)
                                Heap Fetches: 0
                                Index Searches: 5
                                Buffers: shared hit=16
                          ->  Index Scan using authors_pkey on authors a  (cost=0.56..5.07 rows=1 width=16) (actual time=0.018..0.018 rows=0.40 loops=5)
                                Index Cond: (id = wa.author_id)
                                Filter: ((lower(name) = 'susanna clarke'::text) OR (lower(name) ~~ '%susanna clarke%'::text) OR ('susanna clarke'::text ~~ like_escape((('%'::text || replace(replace(replace(lower(name), '\'::text, '\\'::text), '%'::text, '\%'::text), '_'::text, '\_'::text)) || '%'::text), '\'::text)))
                                Rows Removed by Filter: 1
                                Index Searches: 5
                                Buffers: shared hit=25
        SubPlan 1
          ->  Limit  (cost=88.90..88.91 rows=1 width=20) (actual time=0.125..0.126 rows=1.00 loops=1)
                Buffers: shared hit=26
                ->  Sort  (cost=88.90..88.96 rows=21 width=20) (actual time=0.124..0.125 rows=1.00 loops=1)
                      Sort Key: e.publish_year DESC NULLS LAST
                      Sort Method: top-N heapsort  Memory: 25kB
                      Buffers: shared hit=26
                      ->  Index Scan using editions_work_idx on editions e  (cost=0.43..88.80 rows=21 width=20) (actual time=0.035..0.078 rows=23.00 loops=1)
                            Index Cond: (work_id = w.id)
                            Index Searches: 1
                            Buffers: shared hit=26
        SubPlan 2
          ->  Limit  (cost=17.04..17.04 rows=1 width=25) (actual time=0.050..0.050 rows=1.00 loops=2)
                Buffers: shared hit=18
                ->  Sort  (cost=17.04..17.04 rows=1 width=25) (actual time=0.049..0.049 rows=1.00 loops=2)
                      Sort Key: wa_1."position", a_1.name
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=18
                      ->  Nested Loop  (cost=0.99..17.03 rows=1 width=25) (actual time=0.039..0.040 rows=1.00 loops=2)
                            Buffers: shared hit=18
                            ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa_1  (cost=0.43..8.45 rows=1 width=20) (actual time=0.016..0.016 rows=1.00 loops=2)
                                  Index Cond: (work_id = w.id)
                                  Index Searches: 2
                                  Buffers: shared hit=8
                            ->  Index Scan using authors_pkey on authors a_1  (cost=0.56..8.58 rows=1 width=37) (actual time=0.020..0.020 rows=1.00 loops=2)
                                  Index Cond: (id = wa_1.author_id)
                                  Index Searches: 2
                                  Buffers: shared hit=10
Planning:
  Buffers: shared hit=55
Planning Time: 3.266 ms
Execution Time: 69.548 ms
```

