// SH-01: Shelves, Shelf Items, Shelf Saves, Constraints, Triggers & Reconciliation Tests
// PRD §15.2-15.6, Architecture §3.5, §3.9

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rejected } from './pg.js';

let db: PGlite;

const USER_1 = '11111111-1111-1111-1111-111111111111';
const USER_2 = '22222222-2222-2222-2222-222222222222';
const WORK_1 = '33333333-3333-3333-3333-333333333333';
const WORK_2 = '44444444-4444-4444-4444-444444444444';
const WORK_3 = '55555555-5555-5555-5555-555555555555';
const WORK_4 = '66666666-6666-6666-6666-666666666666';
const WORK_5 = '77777777-7777-7777-7777-777777777777';

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO users (id, email, password_hash, date_of_birth) VALUES
      ('${USER_1}', 'u1@flyleaf.test', 'hash1', '2000-01-01'),
      ('${USER_2}', 'u2@flyleaf.test', 'hash2', '2000-01-01');

    INSERT INTO works (id, title) VALUES
      ('${WORK_1}', 'Piranesi'),
      ('${WORK_2}', 'The Left Hand of Darkness'),
      ('${WORK_3}', 'A Wizard of Earthsea'),
      ('${WORK_4}', 'The Dispossessed'),
      ('${WORK_5}', 'Jonathan Strange & Mr Norrell');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('SH-01: Schema Constraints', () => {
  it('creates a shelf with default values', async () => {
    const { rows } = await db.query<{ id: string; name: string; slug: string; is_ranked: boolean; privacy: string; item_count: number; save_count: number }>(`
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', 'My Favorites', 'my-favorites')
      RETURNING id, name, slug, is_ranked, privacy, item_count, save_count;
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('My Favorites');
    expect(rows[0]?.slug).toBe('my-favorites');
    expect(rows[0]?.is_ranked).toBe(false);
    expect(rows[0]?.privacy).toBe('public');
    expect(rows[0]?.item_count).toBe(0);
    expect(rows[0]?.save_count).toBe(0);
  });

  it('rejects shelf names longer than 60 characters (PRD §15.6)', async () => {
    const longName = 'A'.repeat(61);
    const fail = await rejected(db, `
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', '${longName}', 'too-long')
    `);
    expect(fail).toBe(true);
  });

  it('accepts shelf names up to 60 characters', async () => {
    const maxName = 'B'.repeat(60);
    const { rows } = await db.query<{ name: string }>(`
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', '${maxName}', 'max-len-shelf')
      RETURNING name;
    `);
    expect(rows[0]?.name).toBe(maxName);
  });

  it('enforces slug uniqueness per user (PRD §15.2)', async () => {
    // Attempting duplicate slug for USER_1 should fail
    const fail = await rejected(db, `
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', 'Duplicate Slug', 'my-favorites')
    `);
    expect(fail).toBe(true);

    // But USER_2 can use the same slug
    const { rows } = await db.query<{ slug: string }>(`
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_2}', 'Their Favorites', 'my-favorites')
      RETURNING slug;
    `);
    expect(rows[0]?.slug).toBe('my-favorites');
  });

  it('accepts valid privacy values and rejects invalid ones', async () => {
    // Valid values: public, followers, private
    for (const p of ['followers', 'private']) {
      const { rows } = await db.query<{ privacy: string }>(`
        INSERT INTO shelves (user_id, name, slug, privacy)
        VALUES ('${USER_1}', 'Shelf ${p}', 'shelf-${p}', '${p}')
        RETURNING privacy;
      `);
      expect(rows[0]?.privacy).toBe(p);
    }

    // Invalid privacy
    const fail = await rejected(db, `
      INSERT INTO shelves (user_id, name, slug, privacy)
      VALUES ('${USER_1}', 'Invalid Privacy', 'shelf-invalid', 'secret')
    `);
    expect(fail).toBe(true);
  });

  it('rejects per-entry notes longer than 280 characters (PRD §15.6)', async () => {
    const { rows: shelfRows } = await db.query<{ id: string }>(`
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', 'Note Test Shelf', 'note-test-shelf')
      RETURNING id;
    `);
    const shelfId = shelfRows[0]!.id;

    const longNote = 'N'.repeat(281);
    const fail = await rejected(db, `
      INSERT INTO shelf_items (shelf_id, work_id, note)
      VALUES ('${shelfId}', '${WORK_1}', '${longNote}')
    `);
    expect(fail).toBe(true);
  });

  it('prevents duplicate works on the same shelf (PRD §15.6)', async () => {
    const { rows: shelfRows } = await db.query<{ id: string }>(`
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', 'No Dups Shelf', 'no-dups-shelf')
      RETURNING id;
    `);
    const shelfId = shelfRows[0]!.id;

    await db.query(`
      INSERT INTO shelf_items (shelf_id, work_id, position)
      VALUES ('${shelfId}', '${WORK_1}', 1);
    `);

    // Duplicate work on same shelf should fail
    const fail = await rejected(db, `
      INSERT INTO shelf_items (shelf_id, work_id, position)
      VALUES ('${shelfId}', '${WORK_1}', 2);
    `);
    expect(fail).toBe(true);
  });

  it('cascades deletion of shelf to shelf_items and shelf_saves', async () => {
    const { rows: shelfRows } = await db.query<{ id: string }>(`
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', 'Cascade Test Shelf', 'cascade-test-shelf')
      RETURNING id;
    `);
    const shelfId = shelfRows[0]!.id;

    await db.exec(`
      INSERT INTO shelf_items (shelf_id, work_id) VALUES ('${shelfId}', '${WORK_1}');
      INSERT INTO shelf_saves (shelf_id, user_id) VALUES ('${shelfId}', '${USER_2}');
    `);

    // Delete shelf
    await db.query(`DELETE FROM shelves WHERE id = '${shelfId}';`);

    const { rows: items } = await db.query(`SELECT * FROM shelf_items WHERE shelf_id = '${shelfId}';`);
    const { rows: saves } = await db.query(`SELECT * FROM shelf_saves WHERE shelf_id = '${shelfId}';`);
    expect(items).toHaveLength(0);
    expect(saves).toHaveLength(0);
  });
});

describe('SH-01: Triggers & Denormalized Counters', () => {
  it('increments item_count and maintains cover_work_ids on item insertions', async () => {
    const { rows: shelfRows } = await db.query<{ id: string }>(`
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', 'Trigger Test Shelf', 'trigger-test-shelf')
      RETURNING id;
    `);
    const shelfId = shelfRows[0]!.id;

    // Add item 1
    await db.query(`
      INSERT INTO shelf_items (shelf_id, work_id, position)
      VALUES ('${shelfId}', '${WORK_1}', 1);
    `);

    let { rows: check1 } = await db.query<{ item_count: number; cover_work_ids: string[] }>(`
      SELECT item_count, cover_work_ids FROM shelves WHERE id = '${shelfId}';
    `);
    expect(check1[0]?.item_count).toBe(1);
    expect(check1[0]?.cover_work_ids).toEqual([WORK_1]);

    // Add item 2 and item 3
    await db.query(`
      INSERT INTO shelf_items (shelf_id, work_id, position)
      VALUES
        ('${shelfId}', '${WORK_2}', 2),
        ('${shelfId}', '${WORK_3}', 3);
    `);

    let { rows: check2 } = await db.query<{ item_count: number; cover_work_ids: string[] }>(`
      SELECT item_count, cover_work_ids FROM shelves WHERE id = '${shelfId}';
    `);
    expect(check2[0]?.item_count).toBe(3);
    expect(check2[0]?.cover_work_ids).toEqual([WORK_1, WORK_2, WORK_3]);

    // Add item 4 and item 5: cover_work_ids should be capped at 4 covers
    await db.query(`
      INSERT INTO shelf_items (shelf_id, work_id, position)
      VALUES
        ('${shelfId}', '${WORK_4}', 4),
        ('${shelfId}', '${WORK_5}', 5);
    `);

    let { rows: check3 } = await db.query<{ item_count: number; cover_work_ids: string[] }>(`
      SELECT item_count, cover_work_ids FROM shelves WHERE id = '${shelfId}';
    `);
    expect(check3[0]?.item_count).toBe(5);
    expect(check3[0]?.cover_work_ids).toHaveLength(4);
    expect(check3[0]?.cover_work_ids).toEqual([WORK_1, WORK_2, WORK_3, WORK_4]);

    // Delete item 1: item_count decrements to 4, cover_work_ids updates to include WORK_5
    await db.query(`
      DELETE FROM shelf_items WHERE shelf_id = '${shelfId}' AND work_id = '${WORK_1}';
    `);

    let { rows: check4 } = await db.query<{ item_count: number; cover_work_ids: string[] }>(`
      SELECT item_count, cover_work_ids FROM shelves WHERE id = '${shelfId}';
    `);
    expect(check4[0]?.item_count).toBe(4);
    expect(check4[0]?.cover_work_ids).toEqual([WORK_2, WORK_3, WORK_4, WORK_5]);
  });

  it('updates save_count on shelf_saves insert and delete', async () => {
    const { rows: shelfRows } = await db.query<{ id: string }>(`
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', 'Save Count Shelf', 'save-count-shelf')
      RETURNING id;
    `);
    const shelfId = shelfRows[0]!.id;

    // Initially save_count is 0
    let { rows: init } = await db.query<{ save_count: number }>(`
      SELECT save_count FROM shelves WHERE id = '${shelfId}';
    `);
    expect(init[0]?.save_count).toBe(0);

    // USER_2 saves the shelf
    await db.query(`
      INSERT INTO shelf_saves (shelf_id, user_id)
      VALUES ('${shelfId}', '${USER_2}');
    `);

    let { rows: afterSave } = await db.query<{ save_count: number }>(`
      SELECT save_count FROM shelves WHERE id = '${shelfId}';
    `);
    expect(afterSave[0]?.save_count).toBe(1);

    // USER_2 unsaves the shelf
    await db.query(`
      DELETE FROM shelf_saves
      WHERE shelf_id = '${shelfId}' AND user_id = '${USER_2}';
    `);

    let { rows: afterUnsave } = await db.query<{ save_count: number }>(`
      SELECT save_count FROM shelves WHERE id = '${shelfId}';
    `);
    expect(afterUnsave[0]?.save_count).toBe(0);
  });

  it('reconcile_shelf_counters restores corrupted counters to exact state', async () => {
    const { rows: shelfRows } = await db.query<{ id: string }>(`
      INSERT INTO shelves (user_id, name, slug)
      VALUES ('${USER_1}', 'Reconcile Test Shelf', 'reconcile-test-shelf')
      RETURNING id;
    `);
    const shelfId = shelfRows[0]!.id;

    // Add 2 items and 1 save
    await db.exec(`
      INSERT INTO shelf_items (shelf_id, work_id, position) VALUES
        ('${shelfId}', '${WORK_1}', 1),
        ('${shelfId}', '${WORK_2}', 2);
      INSERT INTO shelf_saves (shelf_id, user_id) VALUES
        ('${shelfId}', '${USER_2}');
    `);

    // Simulate artificial counter drift (e.g. out-of-band updates or corrupted triggers)
    await db.query(`
      UPDATE shelves
      SET item_count = 999, save_count = 888, cover_work_ids = '{}'::uuid[]
      WHERE id = '${shelfId}';
    `);

    let { rows: corrupted } = await db.query<{ item_count: number; save_count: number; cover_work_ids: string[] }>(`
      SELECT item_count, save_count, cover_work_ids FROM shelves WHERE id = '${shelfId}';
    `);
    expect(corrupted[0]?.item_count).toBe(999);
    expect(corrupted[0]?.save_count).toBe(888);
    expect(corrupted[0]?.cover_work_ids).toEqual([]);

    // Run reconciliation procedure
    await db.query(`SELECT reconcile_shelf_counters();`);

    let { rows: healed } = await db.query<{ item_count: number; save_count: number; cover_work_ids: string[] }>(`
      SELECT item_count, save_count, cover_work_ids FROM shelves WHERE id = '${shelfId}';
    `);
    expect(healed[0]?.item_count).toBe(2);
    expect(healed[0]?.save_count).toBe(1);
    expect(healed[0]?.cover_work_ids).toEqual([WORK_1, WORK_2]);
  });
});
