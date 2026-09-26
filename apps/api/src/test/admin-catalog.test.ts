// Admin catalog and ingestion status tests (FN-92, PRD §7.8, §7.9, §27.5).

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import {
  listCatalogWorks,
  getCatalogWorkDetail,
  overrideWorkMaturity,
  getIngestDashboardStatus,
} from '../admin/catalog.js';
import { createAdminUser, loginAdmin, getAdminAuditLog } from '../admin/auth.js';
import { generateTotp } from '../admin/totp.js';
import { IdentityService } from '../identity/index.js';
import { CatalogService } from '../catalog/index.js';
import { ReadingService } from '../reading/index.js';
import { MemoryCache, PgRateLimiter } from '../platform/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';

describe('Admin Catalog Maturity & Ingestion Telemetry (FN-92)', () => {
  async function setupHarness() {
    const { db } = await freshDrizzle();
    const emailSender = new MemoryEmailSender();
    const identity = new IdentityService(db, new PgRateLimiter(db), emailSender);
    const catalog = new CatalogService(db, new MemoryCache());
    const reading = new ReadingService(db);

    const app = await buildApp({ db, identity, catalog, reading });

    // Seed test works and authors
    const [author] = await db.execute<{ id: string }>(sql`
      INSERT INTO authors (name, ol_author_key)
      VALUES ('Test Author', '/authors/OL999A')
      RETURNING id
    `);

    const [workGeneral] = await db.execute<{ id: string }>(sql`
      INSERT INTO works (title, maturity, log_count, ol_work_key)
      VALUES ('Normal Book', 'general', 100, '/works/OL101W')
      RETURNING id
    `);

    const [workUnclassified] = await db.execute<{ id: string }>(sql`
      INSERT INTO works (title, maturity, log_count, ol_work_key)
      VALUES ('Unclassified Book', 'unclassified', 50, '/works/OL102W')
      RETURNING id
    `);

    const [workExplicit] = await db.execute<{ id: string }>(sql`
      INSERT INTO works (title, maturity, log_count, ol_work_key)
      VALUES ('Adult Erotica Title', 'explicit', 200, '/works/OL103W')
      RETURNING id
    `);

    await db.execute(sql`
      INSERT INTO work_authors (work_id, author_id, role, position)
      VALUES (${workGeneral!.id}, ${author!.id}, 'author', 1),
             (${workUnclassified!.id}, ${author!.id}, 'author', 1),
             (${workExplicit!.id}, ${author!.id}, 'author', 1)
    `);

    // Seed test ingest runs
    await db.execute(sql`
      INSERT INTO ingest_runs (dump_type, source_file, lines_read, rows_written, rows_skipped, status, started_at, finished_at)
      VALUES ('works', 'data/ol_dump_works.txt.gz', 100000, 85000, 15000, 'done', now() - interval '2 hours', now() - interval '1 hour'),
             ('editions', 'data/ol_dump_editions.txt.gz', 50000, 45000, 5000, 'running', now() - interval '10 minutes', null)
    `);

    // Create admin user
    const adminUser = await createAdminUser(db, {
      email: 'catalog_admin@flyleaf.app',
      password: 'AdminPassword123',
      role: 'admin',
    });
    const adminLogin = await loginAdmin(db, {
      email: 'catalog_admin@flyleaf.app',
      password: 'AdminPassword123',
      totpCode: generateTotp(adminUser.secret),
    });

    // Create moderator user
    const modUser = await createAdminUser(db, {
      email: 'catalog_mod@flyleaf.app',
      password: 'ModPassword123',
      role: 'moderator',
    });
    const modLogin = await loginAdmin(db, {
      email: 'catalog_mod@flyleaf.app',
      password: 'ModPassword123',
      totpCode: generateTotp(modUser.secret),
    });

    // Create regular user
    const regular = await identity.register(
      'app_user@example.com',
      'appuser',
      'UserPassword123',
      '1995-01-01',
    );

    return {
      db,
      app,
      admin: adminUser.user,
      adminToken: adminLogin.token,
      mod: modUser.user,
      modToken: modLogin.token,
      userToken: regular.accessToken,
      workGeneralId: workGeneral!.id,
      workUnclassifiedId: workUnclassified!.id,
      workExplicitId: workExplicit!.id,
    };
  }

  it('lists catalog works with maturity filtering and search', async () => {
    const { db } = await setupHarness();

    const allWorks = await listCatalogWorks(db);
    expect(allWorks.works.length).toBeGreaterThanOrEqual(3);

    const unclassified = await listCatalogWorks(db, { maturity: 'unclassified' });
    expect(unclassified.works.every((w) => w.maturity === 'unclassified')).toBe(true);
    expect(unclassified.works.some((w) => w.title === 'Unclassified Book')).toBe(true);

    const explicitOnly = await listCatalogWorks(db, { maturity: 'explicit' });
    expect(explicitOnly.works.every((w) => w.maturity === 'explicit')).toBe(true);

    const searched = await listCatalogWorks(db, { q: 'Normal' });
    expect(searched.works.some((w) => w.title === 'Normal Book')).toBe(true);
    expect(searched.works.some((w) => w.title === 'Adult Erotica Title')).toBe(false);
  });

  it('retrieves detailed work information for maturity review', async () => {
    const { db, workGeneralId } = await setupHarness();

    const detail = await getCatalogWorkDetail(db, workGeneralId);
    expect(detail.id).toBe(workGeneralId);
    expect(detail.title).toBe('Normal Book');
    expect(detail.maturity).toBe('general');
    expect(detail.authors.length).toBeGreaterThanOrEqual(1);
    expect(detail.is_locked).toBe(false);
  });

  it('overrides maturity, locks field_provenance, and writes to admin_audit_log', async () => {
    const { db, admin, workUnclassifiedId } = await setupHarness();

    const result = await overrideWorkMaturity(db, {
      workId: workUnclassifiedId,
      maturity: 'mature',
      reason: 'Contains literary violence and adult psychological themes',
      actor: admin,
    });

    expect(result.success).toBe(true);
    expect(result.previous_maturity).toBe('unclassified');
    expect(result.new_maturity).toBe('mature');
    expect(result.is_locked).toBe(true);

    // Assert work record in db was updated
    const [updatedWork] = await db.execute<{ maturity: string }>(sql`
      SELECT maturity FROM works WHERE id = ${workUnclassifiedId}
    `);
    expect(updatedWork!.maturity).toBe('mature');

    // Assert field_provenance was locked to prevent re-ingest overwrites (PRD §7.9)
    const [prov] = await db.execute<{ is_locked: boolean; provider: string }>(sql`
      SELECT is_locked, provider FROM field_provenance
      WHERE entity_type = 'work' AND entity_id = ${workUnclassifiedId} AND field_name = 'maturity'
    `);
    expect(prov!.is_locked).toBe(true);
    expect(prov!.provider).toBe('user');

    // Assert non-negotiable audit log entry was created (FN-93)
    const auditLogs = await getAdminAuditLog(db, { action: 'catalog.maturity_override' });
    expect(auditLogs.length).toBeGreaterThanOrEqual(1);
    const entry = auditLogs.find((l) => l.subject_id === workUnclassifiedId);
    expect(entry).toBeDefined();
    expect(entry?.actor_id).toBe(admin.id);
    expect(entry?.reason).toBe('Contains literary violence and adult psychological themes');
    expect(entry?.payload).toMatchObject({
      previous_maturity: 'unclassified',
      new_maturity: 'mature',
    });
  });

  it('rejects invalid maturity ratings and empty reasons', async () => {
    const { db, admin, workUnclassifiedId } = await setupHarness();

    await expect(
      overrideWorkMaturity(db, {
        workId: workUnclassifiedId,
        maturity: 'spicy' as any,
        reason: 'Valid reason here',
        actor: admin,
      }),
    ).rejects.toThrow();

    await expect(
      overrideWorkMaturity(db, {
        workId: workUnclassifiedId,
        maturity: 'general',
        reason: '  ',
        actor: admin,
      }),
    ).rejects.toThrow();
  });

  it('aggregates ingestion status, catalog totals, and circuit breaker telemetry', async () => {
    const { db } = await setupHarness();

    const status = await getIngestDashboardStatus(db);

    expect(status.runs_summary.total_runs).toBe(2);
    expect(status.runs_summary.completed).toBe(1);
    expect(status.runs_summary.running).toBe(1);

    expect(status.catalog.works_count).toBeGreaterThanOrEqual(3);
    expect(status.maturity_breakdown.general).toBeGreaterThanOrEqual(1);
    expect(status.maturity_breakdown.unclassified).toBeGreaterThanOrEqual(1);
    expect(status.maturity_breakdown.explicit).toBeGreaterThanOrEqual(1);

    expect(status.telemetry.circuit_breaker.state).toBe('closed');
    expect(status.telemetry.outbound_limiter.rate_per_second).toBe(3);
    expect(status.telemetry.outbound_limiter.burst).toBe(5);
  });

  it('enforces stolen token isolation and role permissions over HTTP', async () => {
    const { app, adminToken, modToken, userToken, workUnclassifiedId } = await setupHarness();

    // 1. Regular mobile user token rejected on admin catalog routes (stolen token isolation)
    const stolenWorksRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/works',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(stolenWorksRes.statusCode).toBe(401);
    expect(stolenWorksRes.json().error.code).toBe('admin_auth_required');

    const stolenIngestRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/ingest/status',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(stolenIngestRes.statusCode).toBe(401);
    expect(stolenIngestRes.json().error.code).toBe('admin_auth_required');

    // 2. Moderator CAN inspect works and ingest status
    const modWorksRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/works?maturity=unclassified',
      headers: { Authorization: `Bearer ${modToken}` },
    });
    expect(modWorksRes.statusCode).toBe(200);
    expect(modWorksRes.json()).toHaveProperty('works');

    const modIngestRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/ingest/status',
      headers: { Authorization: `Bearer ${modToken}` },
    });
    expect(modIngestRes.statusCode).toBe(200);
    expect(modIngestRes.json()).toHaveProperty('telemetry');

    // 3. Moderator is FORBIDDEN from modifying work maturity (read-only per PRD §27.5)
    const modOverrideRes = await app.inject({
      method: 'POST',
      url: `/v1/admin/catalog/works/${workUnclassifiedId}/maturity`,
      headers: { Authorization: `Bearer ${modToken}` },
      payload: {
        maturity: 'general',
        reason: 'Moderator attempting catalog edit',
      },
    });
    expect(modOverrideRes.statusCode).toBe(403);
    expect(modOverrideRes.json().error.code).toBe('insufficient_role');

    // 4. Admin CAN modify work maturity
    const adminOverrideRes = await app.inject({
      method: 'POST',
      url: `/v1/admin/catalog/works/${workUnclassifiedId}/maturity`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        maturity: 'explicit',
        reason: 'Classified as explicit per content policy',
      },
    });
    expect(adminOverrideRes.statusCode).toBe(200);
    expect(adminOverrideRes.json().success).toBe(true);
    expect(adminOverrideRes.json().new_maturity).toBe('explicit');
  });

  it('renders server-side HTML console views with session cookies', async () => {
    const { app, adminToken } = await setupHarness();

    // 1. Unauthenticated visitors are redirected to /admin/login
    const anonMaturity = await app.inject({
      method: 'GET',
      url: '/admin/catalog/maturity',
    });
    expect(anonMaturity.statusCode).toBe(302);
    expect(anonMaturity.headers.location).toBe('/admin/login');

    const anonIngest = await app.inject({
      method: 'GET',
      url: '/admin/ingest',
    });
    expect(anonIngest.statusCode).toBe(302);
    expect(anonIngest.headers.location).toBe('/admin/login');

    // 2. Authenticated admin with session cookie can access both pages
    const authMaturity = await app.inject({
      method: 'GET',
      url: '/admin/catalog/maturity',
      headers: {
        cookie: `flyleaf_admin_session=${encodeURIComponent(adminToken)}`,
      },
    });
    expect(authMaturity.statusCode).toBe(200);
    expect(authMaturity.headers['content-type']).toContain('text/html');
    expect(authMaturity.body).toContain('Catalog Maturity Review');
    expect(authMaturity.body).toContain('Override');

    const authIngest = await app.inject({
      method: 'GET',
      url: '/admin/ingest',
      headers: {
        cookie: `flyleaf_admin_session=${encodeURIComponent(adminToken)}`,
      },
    });
    expect(authIngest.statusCode).toBe(200);
    expect(authIngest.headers['content-type']).toContain('text/html');
    expect(authIngest.body).toContain('Ingestion Status');
    expect(authIngest.body).toContain('Circuit Breaker');
  });
});
