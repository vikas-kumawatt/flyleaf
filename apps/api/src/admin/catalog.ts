// Admin catalog service (FN-92, PRD §7.8, §7.9, §27.5).
//
// Handles:
// 1. Searching/listing catalog works for maturity review (especially unclassified/borderline).
// 2. Overriding work maturity ratings with mandatory audit logging and field provenance locking.
// 3. Ingestion dashboard telemetry: ingest runs, catalog totals, maturity breakdown, and circuit breaker status.

import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { outboundBreaker } from '../platform/outbound.js';
import { logAdminAction, type AuditContext } from './auth.js';
import { ApiError } from '../http.js';

export type MaturityRating = 'general' | 'mature' | 'explicit' | 'unclassified';

export const VALID_MATURITIES: readonly MaturityRating[] = [
  'general',
  'mature',
  'explicit',
  'unclassified',
] as const;

export interface ListCatalogWorksOptions {
  maturity?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface CatalogWorkSummary {
  id: string;
  title: string;
  subtitle: string | null;
  author_name: string;
  first_publish_year: number | null;
  ol_cover_id: number | null;
  maturity: MaturityRating;
  log_count: number;
  is_locked: boolean;
  updated_at: string;
}

export interface ListCatalogWorksResult {
  works: CatalogWorkSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CatalogWorkDetail {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  alternate_titles: string[];
  first_publish_year: number | null;
  ol_cover_id: number | null;
  maturity: MaturityRating;
  log_count: number;
  is_locked: boolean;
  ol_work_key: string | null;
  authors: Array<{ id: string; name: string; role: string }>;
  subjects: string[];
  editions_count: number;
  provenance: Array<{
    field_name: string;
    provider: string;
    is_locked: boolean;
    fetched_at: string;
  }>;
  audit_history: Array<{
    id: string;
    action: string;
    actor_email: string;
    reason: string | null;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
}

export interface OverrideMaturityOptions {
  workId: string;
  maturity: MaturityRating;
  reason: string;
  actor: {
    id: string;
    email: string;
    role: string;
  };
  /** Where the request came from, for the audit entry. */
  context?: AuditContext;
}

export interface OverrideMaturityResult {
  success: boolean;
  work_id: string;
  previous_maturity: MaturityRating;
  new_maturity: MaturityRating;
  is_locked: boolean;
}

export interface IngestDashboardStatus {
  /**
   * True when the catalog totals and maturity breakdown are planner
   * statistics (pg_class.reltuples, pg_stats), not counts: exact counts over
   * the full catalog took 150 s+ per request (Audit 06, A-06-013).
   */
  counts_are_estimates: boolean;
  last_run: {
    id: string;
    dump_type: string;
    status: string;
    lines_read: number;
    rows_written: number;
    rows_skipped: number;
    error: string | null;
    started_at: string;
    finished_at: string | null;
    duration_seconds: number | null;
  } | null;
  recent_runs: Array<{
    id: string;
    dump_type: string;
    status: string;
    lines_read: number;
    rows_written: number;
    rows_skipped: number;
    error: string | null;
    started_at: string;
    finished_at: string | null;
    duration_seconds: number | null;
  }>;
  runs_summary: {
    total_runs: number;
    completed: number;
    failed: number;
    interrupted: number;
    running: number;
  };
  catalog: {
    works_count: number;
    editions_count: number;
    authors_count: number;
    authorship_links_count: number;
    works_with_cover_count: number;
    raw_payloads_count: number;
  };
  maturity_breakdown: {
    general: number;
    mature: number;
    explicit: number;
    unclassified: number;
    overridden_locked: number;
  };
  telemetry: {
    circuit_breaker: {
      state: 'closed' | 'open' | 'half-open';
      threshold: number;
      cooldown_seconds: number;
    };
    outbound_limiter: {
      rate_per_second: number;
      burst: number;
    };
    pending_work_authors_count: number;
    dedupe_queue_pending_count: number;
  };
}

/**
 * Lists catalog works with optional maturity filter and search query.
 */
export async function listCatalogWorks(
  db: Db,
  opts: ListCatalogWorksOptions = {},
): Promise<ListCatalogWorksResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions = [sql`w.merged_into_id IS NULL`];

  if (opts.maturity && VALID_MATURITIES.includes(opts.maturity as MaturityRating)) {
    conditions.push(sql`w.maturity = ${opts.maturity}`);
  }

  if (opts.q && opts.q.trim().length > 0) {
    const term = `%${opts.q.trim()}%`;
    conditions.push(sql`(
      w.title ILIKE ${term} OR
      COALESCE(w.subtitle, '') ILIKE ${term} OR
      EXISTS (
        SELECT 1 FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id AND a.name ILIKE ${term}
      )
    )`);
  }

  const whereClause = sql.join(conditions, sql` AND `);

  const [countRow] = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM works w
    WHERE ${whereClause}
  `);
  const total = Number(countRow?.count ?? 0);

  const rows = await db.execute<{
    id: string;
    title: string;
    subtitle: string | null;
    author_name: string | null;
    first_publish_year: number | null;
    ol_cover_id: number | null;
    maturity: string;
    log_count: number;
    is_locked: boolean | null;
    updated_at: Date | string;
  }>(sql`
    SELECT
      w.id,
      w.title,
      w.subtitle,
      COALESCE((
        SELECT a.name
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
        ORDER BY wa.position ASC
        LIMIT 1
      ), 'Unknown Author') AS author_name,
      w.first_publish_year,
      w.ol_cover_id,
      w.maturity,
      w.log_count,
      COALESCE(fp.is_locked, false) AS is_locked,
      w.updated_at
    FROM works w
    LEFT JOIN field_provenance fp
      ON fp.entity_type = 'work'
     AND fp.entity_id = w.id
     AND fp.field_name = 'maturity'
    WHERE ${whereClause}
    ORDER BY w.log_count DESC, w.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const works: CatalogWorkSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    author_name: r.author_name ?? 'Unknown Author',
    first_publish_year: r.first_publish_year,
    ol_cover_id: r.ol_cover_id,
    maturity: r.maturity as MaturityRating,
    log_count: Number(r.log_count ?? 0),
    is_locked: Boolean(r.is_locked),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }));

  return { works, total, limit, offset };
}

/**
 * Returns full work detail for maturity review including subjects and audit history.
 */
export async function getCatalogWorkDetail(db: Db, workId: string): Promise<CatalogWorkDetail> {
  const [workRow] = await db.execute<{
    id: string;
    title: string;
    subtitle: string | null;
    description: string | null;
    alternate_titles: string[] | null;
    first_publish_year: number | null;
    ol_cover_id: number | null;
    maturity: string;
    log_count: number;
    ol_work_key: string | null;
    is_locked: boolean | null;
  }>(sql`
    SELECT
      w.id,
      w.title,
      w.subtitle,
      w.description,
      w.alternate_titles,
      w.first_publish_year,
      w.ol_cover_id,
      w.maturity,
      w.log_count,
      w.ol_work_key,
      COALESCE(fp.is_locked, false) AS is_locked
    FROM works w
    LEFT JOIN field_provenance fp
      ON fp.entity_type = 'work'
     AND fp.entity_id = w.id
     AND fp.field_name = 'maturity'
    WHERE w.id = ${workId}
  `);

  if (!workRow) {
    throw ApiError.notFound(`Work ${workId} not found`);
  }

  const authors = await db.execute<{ id: string; name: string; role: string }>(sql`
    SELECT a.id, a.name, wa.role
    FROM work_authors wa
    JOIN authors a ON a.id = wa.author_id
    WHERE wa.work_id = ${workId}
    ORDER BY wa.position ASC
  `);

  const subjects = await db.execute<{ name: string }>(sql`
    SELECT s.name
    FROM work_subjects ws
    JOIN subjects s ON s.id = ws.subject_id
    WHERE ws.work_id = ${workId}
    ORDER BY s.name ASC
  `);

  const [editionsCountRow] = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM editions WHERE work_id = ${workId}
  `);

  const provenanceRows = await db.execute<{
    field_name: string;
    provider: string;
    is_locked: boolean;
    fetched_at: Date | string;
  }>(sql`
    SELECT field_name, provider, is_locked, fetched_at
    FROM field_provenance
    WHERE entity_type = 'work' AND entity_id = ${workId}
    ORDER BY field_name ASC
  `);

  const auditRows = await db.execute<{
    id: string;
    action: string;
    actor_email: string | null;
    reason: string | null;
    payload: Record<string, unknown> | null;
    created_at: Date | string;
  }>(sql`
    SELECT
      l.id,
      l.action,
      u.email AS actor_email,
      l.reason,
      l.payload,
      l.created_at
    FROM admin_audit_log l
    LEFT JOIN users u ON u.id = l.actor_id
    WHERE l.subject_type = 'work' AND l.subject_id = ${workId}
    ORDER BY l.created_at DESC
    LIMIT 20
  `);

  return {
    id: workRow.id,
    title: workRow.title,
    subtitle: workRow.subtitle,
    description: workRow.description,
    alternate_titles: workRow.alternate_titles ?? [],
    first_publish_year: workRow.first_publish_year,
    ol_cover_id: workRow.ol_cover_id,
    maturity: workRow.maturity as MaturityRating,
    log_count: Number(workRow.log_count ?? 0),
    is_locked: Boolean(workRow.is_locked),
    ol_work_key: workRow.ol_work_key,
    authors: authors.map((a) => ({ id: a.id, name: a.name, role: a.role })),
    subjects: subjects.map((s) => s.name),
    editions_count: Number(editionsCountRow?.count ?? 0),
    provenance: provenanceRows.map((p) => ({
      field_name: p.field_name,
      provider: p.provider,
      is_locked: Boolean(p.is_locked),
      fetched_at: p.fetched_at instanceof Date ? p.fetched_at.toISOString() : String(p.fetched_at),
    })),
    audit_history: auditRows.map((l) => ({
      id: l.id,
      action: l.action,
      actor_email: l.actor_email ?? 'system',
      reason: l.reason,
      payload: (l.payload as Record<string, unknown>) ?? {},
      created_at: l.created_at instanceof Date ? l.created_at.toISOString() : String(l.created_at),
    })),
  };
}

/**
 * Overrides work maturity rating with mandatory audit logging and field provenance lock.
 */
export async function overrideWorkMaturity(
  db: Db,
  opts: OverrideMaturityOptions,
): Promise<OverrideMaturityResult> {
  if (!VALID_MATURITIES.includes(opts.maturity)) {
    throw ApiError.badRequest('invalid_field', `Maturity must be one of: ${VALID_MATURITIES.join(', ')}`, 'maturity');
  }

  const reason = opts.reason?.trim();
  if (!reason || reason.length < 3) {
    throw ApiError.badRequest('invalid_field', 'A meaningful reason (at least 3 characters) is required for audit logging', 'reason');
  }

  const [existing] = await db.execute<{ id: string; maturity: string }>(sql`
    SELECT id, maturity FROM works WHERE id = ${opts.workId}
  `);

  if (!existing) {
    throw ApiError.notFound(`Work ${opts.workId} not found`);
  }

  const previousMaturity = existing.maturity as MaturityRating;

  await db.transaction(async (tx) => {
    // 1. Update works table
    await tx.execute(sql`
      UPDATE works
      SET maturity = ${opts.maturity}, updated_at = now()
      WHERE id = ${opts.workId}
    `);

    // 2. Upsert field_provenance with is_locked = true to protect human override from dump ingest
    await tx.execute(sql`
      INSERT INTO field_provenance (
        entity_type, entity_id, field_name, provider, confidence, is_locked, fetched_at
      ) VALUES (
        'work', ${opts.workId}, 'maturity', 'user', 100, true, now()
      )
      ON CONFLICT (entity_type, entity_id, field_name)
      DO UPDATE SET
        provider = 'user',
        confidence = 100,
        is_locked = true,
        fetched_at = now()
    `);

    // 3. Non-negotiable audit logging (FN-93, PRD §27.5)
    await logAdminAction(tx, {
      actorId: opts.actor.id,
      action: 'catalog.maturity_override',
      subjectType: 'work',
      subjectId: opts.workId,
      reason,
      payload: {
        previous_maturity: previousMaturity,
        new_maturity: opts.maturity,
      },
      ...opts.context,
    });
  });

  return {
    success: true,
    work_id: opts.workId,
    previous_maturity: previousMaturity,
    new_maturity: opts.maturity,
    is_locked: true,
  };
}

/**
 * Returns overall ingestion runs and telemetry dashboard status (PRD §27.5).
 */
export async function getIngestDashboardStatus(db: Db): Promise<IngestDashboardStatus> {
  const recentRunsRaw = await db.execute<{
    id: string;
    dump_type: string;
    status: string;
    lines_read: number;
    rows_written: number;
    rows_skipped: number;
    error: string | null;
    started_at: Date | string;
    finished_at: Date | string | null;
    duration_seconds: number | null;
  }>(sql`
    SELECT
      id,
      dump_type,
      status,
      lines_read,
      rows_written,
      rows_skipped,
      error,
      started_at,
      finished_at,
      ROUND(EXTRACT(EPOCH FROM (COALESCE(finished_at, updated_at) - started_at)))::int AS duration_seconds
    FROM ingest_runs
    ORDER BY started_at DESC
    LIMIT 15
  `);

  const recent_runs = recentRunsRaw.map((r) => ({
    id: r.id,
    dump_type: r.dump_type,
    status: r.status,
    lines_read: Number(r.lines_read ?? 0),
    rows_written: Number(r.rows_written ?? 0),
    rows_skipped: Number(r.rows_skipped ?? 0),
    error: r.error,
    started_at: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    finished_at: r.finished_at ? (r.finished_at instanceof Date ? r.finished_at.toISOString() : String(r.finished_at)) : null,
    duration_seconds: r.duration_seconds !== null ? Number(r.duration_seconds) : null,
  }));

  const last_run = recent_runs[0] ?? null;

  const [runsSummaryRow] = await db.execute<{
    total: number;
    completed: number;
    failed: number;
    interrupted: number;
    running: number;
  }>(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'done')::int AS completed,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status = 'interrupted')::int AS interrupted,
      count(*) FILTER (WHERE status = 'running')::int AS running
    FROM ingest_runs
  `);

  const { catalogTotals, maturityCounts, estimated } = await catalogFigures(db);

  const [pendingAuthorsRow] = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM pending_work_authors
  `);

  const [dedupePendingRow] = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM dedupe_queue WHERE status = 'pending'
  `);

  return {
    counts_are_estimates: estimated,
    last_run,
    recent_runs,
    runs_summary: {
      total_runs: Number(runsSummaryRow?.total ?? 0),
      completed: Number(runsSummaryRow?.completed ?? 0),
      failed: Number(runsSummaryRow?.failed ?? 0),
      interrupted: Number(runsSummaryRow?.interrupted ?? 0),
      running: Number(runsSummaryRow?.running ?? 0),
    },
    catalog: {
      works_count: catalogTotals.works,
      editions_count: catalogTotals.editions,
      authors_count: catalogTotals.authors,
      authorship_links_count: catalogTotals.links,
      works_with_cover_count: catalogTotals.covered,
      raw_payloads_count: catalogTotals.raw,
    },
    maturity_breakdown: {
      general: maturityCounts.general,
      mature: maturityCounts.mature,
      explicit: maturityCounts.explicit,
      unclassified: maturityCounts.unclassified,
      overridden_locked: maturityCounts.locked,
    },
    telemetry: {
      circuit_breaker: {
        state: outboundBreaker.state,
        threshold: 5,
        cooldown_seconds: 60,
      },
      outbound_limiter: {
        rate_per_second: 3,
        burst: 5,
      },
      pending_work_authors_count: Number(pendingAuthorsRow?.count ?? 0),
      dedupe_queue_pending_count: Number(dedupePendingRow?.count ?? 0),
    },
  };
}

const COUNTED_TABLES = ['works', 'editions', 'authors', 'work_authors', 'raw_payloads'] as const;

/**
 * Catalog totals and the maturity breakdown for the ingestion dashboard.
 *
 * On the full catalog, COUNT(*) over works, editions, authors, work_authors
 * and raw_payloads read ~1.7M buffers and took 152 s, and the maturity
 * GROUP BY 2-41 s, per request (flyleaf, Audit 06). These figures are
 * orientation, not accounting, so they come from the planner's statistics,
 * which ANALYZE (run by autovacuum and at the end of every ingest) keeps
 * current: O(1) whatever the catalog size.
 *
 * A table that has never been analysed (reltuples = -1, a fresh or tiny
 * database) is counted exactly instead. A maturity value missing from the
 * most-common-values list gets an equal share of the unlisted remainder.
 */
async function catalogFigures(db: Db) {
  const rel = await db.execute<{ relname: string; reltuples: number }>(sql`
    SELECT relname, reltuples::float8 AS reltuples FROM pg_class
    WHERE oid IN (${sql.join(COUNTED_TABLES.map((t) => sql`to_regclass(${t})`), sql`, `)})
  `);
  const estimateOf = new Map(rel.map((r) => [r.relname, Number(r.reltuples)]));
  let estimated = false;

  const total = async (table: (typeof COUNTED_TABLES)[number]): Promise<number> => {
    const est = estimateOf.get(table) ?? -1;
    if (est >= 0) {
      estimated = true;
      return Math.round(est);
    }
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::float8 AS n FROM ${sql.identifier(table)}`);
    return Number(row?.n ?? 0);
  };

  const [works, editions, authors, links, raw] = await Promise.all([
    total('works'), total('editions'), total('authors'), total('work_authors'), total('raw_payloads'),
  ]);

  const stats = await db.execute<{ attname: string; null_frac: number; vals: string[] | null; freqs: number[] | null }>(sql`
    SELECT attname, null_frac::float8 AS null_frac,
           most_common_vals::text::text[] AS vals, most_common_freqs::float8[] AS freqs
    FROM pg_stats
    WHERE schemaname = current_schema() AND tablename = 'works' AND attname IN ('maturity', 'ol_cover_id')
  `);
  const worksEstimate = estimateOf.get('works') ?? -1;
  const maturityStats = stats.find((r) => r.attname === 'maturity');
  const coverStats = stats.find((r) => r.attname === 'ol_cover_id');

  let covered: number;
  if (worksEstimate >= 0 && coverStats) {
    covered = Math.round(worksEstimate * (1 - Number(coverStats.null_frac)));
  } else {
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::float8 AS n FROM works WHERE ol_cover_id IS NOT NULL`);
    covered = Number(row?.n ?? 0);
  }

  const byMaturity: Record<MaturityRating, number> = { general: 0, mature: 0, explicit: 0, unclassified: 0 };
  if (worksEstimate >= 0 && maturityStats?.vals && maturityStats.freqs) {
    const listed = new Map(maturityStats.vals.map((v, i) => [v, Number(maturityStats.freqs![i] ?? 0)]));
    const unlisted = VALID_MATURITIES.filter((m) => !listed.has(m));
    const listedSum = [...listed.values()].reduce((a, b) => a + b, 0);
    const remainder = Math.max(0, 1 - Number(maturityStats.null_frac) - listedSum);
    for (const m of VALID_MATURITIES) {
      const freq = listed.get(m) ?? (unlisted.length ? remainder / unlisted.length : 0);
      byMaturity[m] = Math.round(worksEstimate * freq);
    }
  } else {
    const [row] = await db.execute<Record<MaturityRating, number>>(sql`
      SELECT
        count(*) FILTER (WHERE maturity = 'general')::float8 AS general,
        count(*) FILTER (WHERE maturity = 'mature')::float8 AS mature,
        count(*) FILTER (WHERE maturity = 'explicit')::float8 AS explicit,
        count(*) FILTER (WHERE maturity = 'unclassified')::float8 AS unclassified
      FROM works
    `);
    for (const m of VALID_MATURITIES) byMaturity[m] = Number(row?.[m] ?? 0);
  }

  // Human overrides: a small table, counted exactly.
  const [lockedRow] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::float8 AS n FROM field_provenance
    WHERE entity_type = 'work' AND field_name = 'maturity' AND is_locked = true
  `);

  return {
    estimated,
    catalogTotals: { works, editions, authors, links, covered, raw },
    maturityCounts: { ...byMaturity, locked: Number(lockedRow?.n ?? 0) },
  };
}
