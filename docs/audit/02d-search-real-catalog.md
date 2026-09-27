# Audit Part 02d — Search on the real catalog

**Read `docs/audit/00-method.md`, `02-search.md`, `findings/02-search.md` and `findings/08-catalog-reading.md` (A-08-025) first.** Run against the **full** `flyleaf` database. Part 02 validated search only on the PGlite test corpus; Part 08 then measured the real catalogs:

- **Quality:** the same 217-query panel scores 216/217 on the corpus, but **209/217 on flyleaf_dev and 198/217 on flyleaf** (`src/bench/relevance-panel.ts`). The misses are mostly author-surname queries.
- **Latency:** `pir` takes **11.0–16.5 s** on flyleaf. The `title ILIKE '%pir%'` arm's row estimate swings between 317 and 96,718 across consecutive `ANALYZE works` runs (the true figure is 23,152). Above a few thousand rows, the planner walks the popularity index with a filter.

## Goals

1. **Stable, fast plans for short queries.** Measure p50/p95 on flyleaf for a fixed set of 1–4 character prefixes and common words (include `pir`, `the`, `har`, `a`, `king`, `lo`). Make the plan independent of ANALYZE's random sample: a higher statistics target on `works.title` and on the normalised title column, extended statistics, a query shape that doesn't invite the popularity-index walk (Part 08's `log_count + 0` option), or a bounded candidate set per arm. Run `ANALYZE` at least 3 times and show the plan and timing each time. Target: p95 under 300 ms for every query in the set on this machine, or explain with EXPLAIN (ANALYZE, BUFFERS) why not and what production hardware changes.
2. **Real-catalog relevance at or above 0.98**, or a justified floor per catalog. Fix the author-surname misses (the typo and author arms from A-02-011/012, now that `authors.has_works` and `authors_name_trgm_idx` exist). Every change must keep the corpus panel at 216/217 or better. Run the real-catalog panel in CI only if it can run cheaply; otherwise it's a documented manual step (`npm run bench:relevance`) with the last result recorded in the findings file.
3. **No regression elsewhere:** ISBN lookup, the maturity filter, and search-as-you-type on flyleaf_dev.

## Rules

Migrations go to both databases, and indexes on `works` are built concurrently. This machine has 8 GB RAM: tests run in the foreground, a few files at a time, at --maxWorkers=1. I run CI. Record findings in `findings/02d-search-real-catalog.md`, update the FN-40…43 audit lines, and remove the 02d row from `PENDING.md`.
