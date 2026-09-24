# Audit Part 02 — Search (FN-40, FN-41, FN-42, FN-43)

**Read `docs/audit/00-method.md` first.** Use the Part 01 bench data and `docs/audit/perf/baseline.md` as your "before".

Spec: PRD §14 (all of it, especially §14.2–14.7 and **[LOCKED]** §14.6), §7.8 maturity (**[LOCKED]**), §4.2 guest mode, §34.1 catalog edge cases, §43 performance, and AC-n on search in §49. Architecture §3.8 (search index) and §5.4 (search ranking). Read the long FN-4x notes in `tasks.md`: they record real incidents (40 s → 47 ms, the dead search-as-you-type regression, the unordered `LIMIT`). Your job is to check that those lessons still hold in the code **today**.

Code: `apps/api/src/catalog/index.ts` (`SEARCH_SQL`, `CatalogService.search`), `catalog/isbn.ts`, `catalog/gapfill.ts`, `platform/outbound.ts`, `migrate.ts` (the similarity threshold), and `src/test/{search,relevance,isbn,outbound}.test.ts`. Mobile: `apps/mobile/app/(tabs)/discover.tsx`.

## FN-40 — search query

Verify, and add tests for each:
- **Sanitisation.** Queries made of or containing `: & | ! ( ) ' \ * < >`, a lone `-`, only punctuation, only whitespace, emoji, RTL text, combining accents, NUL bytes, 1,000+ characters. None may throw and none may produce a `to_tsquery` syntax error. Decide and test what the API returns for an empty-after-sanitising query: 200 with empty results, or 422.
- **LIKE escaping** of `%`, `_` and `\`. A search for `100%` must not match everything.
- **Every arm** (prefix tsvector, substring ILIKE, trigram, author) **orders before it limits**. The unordered-`LIMIT` bug has shipped once already.
- Merged works (`merged_into` or equivalent) and provisional works are excluded from every arm, not only from the final select.
- The author arm uses `alternate_names`, so `murakami` finds 村上春樹's works. Test against the real DB as well as the relevance corpus.
- **Maturity (PRD §7.8, [LOCKED]).** What does search do with `unclassified`/`mature`/`explicit` works for guests and for signed-in users? Is there a safe-surface filter anywhere? If the spec requires one and it's missing, that's P1.
- **Parameter bounds.** `limit`/`offset` (or cursor): negative values, 0, huge values, non-numeric. Is deep pagination bounded?
- **Gap-fill interaction (FN-32).** A search miss must use `tryAcquire()` and never block the request queue behind the outbound limiter. Measure a miss's latency when Open Library is slow or down: mock a timeout, and check the circuit breaker short-circuits.
- **Caching.** Is `MemoryCache` used for search? If so, what's the key, what's the TTL, and is it invalidated when gap-fill adds works? Could a guest and a signed-in user get each other's cached results?

## FN-41 — popularity and ranking

- The weights in code match the tasks.md claim and the PRD §14.3 intent. Look for dead terms: `alternate_titles` is always empty (see the FN-43 note), and any term that is structurally always 0 should be listed.
- **`works.log_count` maintenance.** It's set by the `--popularity` ingest pass and incremented in `ReadingService` (`UPDATE works SET log_count = log_count + 1`) on read insert. Check: is it decremented when a read is deleted? Incremented for imported reads (`imports/committer.ts`)? For re-reads (should a re-read count twice)? Adjusted on dedupe merges? Architecture §3.9 says "trigger on reads insert, reconciled nightly". Is there a trigger and a nightly reconcile? If not, record it. If you add a reconcile job, follow the `reads.reconcile` pattern from SO-20 and schedule it in `worker.ts`.
- The `king` miss is a documented product decision. Don't "fix" it.

## FN-42 — ISBN

- ISBN-10 with a trailing `X` and with lowercase `x`; hyphens and spaces; `978-` ↔ ISBN-10 conversion both ways; **`979-` has no ISBN-10 form** (must not convert or crash); invalid checksums fall back to text search rather than 404; 9- and 11-digit inputs; ISBN-like numbers inside a title query (`1984`).
- `GET /v1/editions/isbn/:isbn` works for guests, has a 404 body identical to other 404s, and resolves deterministically when two editions share an ISBN (pre-dedupe duplicates). **Merged works:** an edition whose work was merged must resolve to the survivor.
- The mobile scanner path (SL-44 is audited in Part 08). Just confirm the API contract it relies on.

## FN-43 — relevance panel

- The panel executes the exported `SEARCH_SQL`, not a copy. Check this by changing a weight temporarily and watching the panel move.
- It measures **position**: exact title #1, others in the top 5. The floor is 0.98.
- It runs in CI (`scripts/ci.mjs` → `api · tests`).
- The `1984` gap test is still there and still asserts the gap.
- Add hard cases to the corpus only if you find a real regression. Don't inflate the pass rate.

## Performance (required)

On the **real database**:
1. Run `EXPLAIN (ANALYZE, BUFFERS)` on the full search for at least these queries: `a`, `th`, `the`, `harry`, `murakami`, `村上`, `the hobit`, `pir`, `9780441478125`, and a 200-character nonsense string. Save the plans (trimmed to the relevant nodes) in the findings file.
2. For 1–2 character prefixes: how many candidates does each arm produce, and what does it cost? If short prefixes are slow, propose (and if cheap, implement) a minimum length per arm or a cheaper path. Don't change user-visible behaviour without recording it as a behaviour change.
3. Check `pg_trgm.similarity_threshold` is 0.45 **on a new connection** to the real DB (`SHOW pg_trgm.similarity_threshold`). It's set with `ALTER DATABASE` by `migrate.ts`, and a DB restored from backup or recreated would silently lose it. Is there a guard (a readiness check, or a startup warning)?
4. Run the bench `search` scenario: p95 must be < 300 ms with the realistic query mix, and not regressed from the documented 47–85 ms warm.
5. Measure a cold-cache query after `docker restart flyleaf-pg` and record it (it was documented as 430–815 ms).

## Deliverables

`docs/audit/findings/02-search.md`, the tests, fixes, audit lines in `tasks.md` under FN-40…FN-43, and a perf table with before and after.
