import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GuestManager, MAX_GUEST_WANT_TO_READ } from '../guest.js';

describe('Guest Mode Local Want-to-Read & Migration (SL-32, SL-33)', () => {
  test('max cap constant is 20 (PRD §4.2)', () => {
    assert.equal(MAX_GUEST_WANT_TO_READ, 20);
  });

  test('adds books to local shelf under cap', async () => {
    const manager = new GuestManager();
    const res1 = await manager.addBook({
      id: 'work-1',
      title: 'Piranesi',
      author_name: 'Susanna Clarke',
      cover_id: 8231856,
    });
    assert.equal(res1.success, true);
    assert.equal(manager.getCount(), 1);
    assert.equal(manager.isSaved('work-1'), true);
    assert.equal(manager.isSaved('work-2'), false);

    const res2 = await manager.addBook({
      id: 'work-2',
      title: 'Klara and the Sun',
      author_name: 'Kazuo Ishiguro',
      cover_id: 10521270,
    });
    assert.equal(res2.success, true);
    assert.equal(manager.getCount(), 2);
  });

  test('handles duplicate book additions idempotently', async () => {
    const manager = new GuestManager();
    await manager.addBook({
      id: 'work-dup',
      title: 'The Left Hand of Darkness',
      author_name: 'Ursula K. Le Guin',
    });
    const dupRes = await manager.addBook({
      id: 'work-dup',
      title: 'The Left Hand of Darkness',
      author_name: 'Ursula K. Le Guin',
    });
    assert.equal(dupRes.success, true);
    assert.equal(dupRes.reason, 'already_added');
    assert.equal(manager.getCount(), 1);
  });

  test('enforces strict 20-book capacity cap (SL-32, PRD §4.2)', async () => {
    const manager = new GuestManager();

    // Fill to 20 books
    for (let i = 1; i <= 20; i++) {
      const res = await manager.addBook({
        id: `work-${i}`,
        title: `Book Title ${i}`,
        author_name: `Author ${i}`,
      });
      assert.equal(res.success, true, `Expected book ${i} to add successfully`);
    }

    assert.equal(manager.getCount(), 20);

    // Attempt to add 21st book
    const overflowRes = await manager.addBook({
      id: 'work-21',
      title: 'Book Title 21',
      author_name: 'Author 21',
    });

    assert.equal(overflowRes.success, false);
    assert.equal(overflowRes.reason, 'cap_reached');
    assert.equal(manager.getCount(), 20);
    assert.equal(manager.isSaved('work-21'), false);
  });

  test('removes book from local shelf and frees a slot', async () => {
    const manager = new GuestManager();
    for (let i = 1; i <= 20; i++) {
      await manager.addBook({ id: `w-${i}`, title: `Book ${i}`, author_name: `Author ${i}` });
    }
    assert.equal(manager.getCount(), 20);

    const removed = await manager.removeBook('w-5');
    assert.equal(removed, true);
    assert.equal(manager.getCount(), 19);
    assert.equal(manager.isSaved('w-5'), false);

    // Now slot 20 is available again
    const addBack = await manager.addBook({ id: 'w-21', title: 'Book 21', author_name: 'Author 21' });
    assert.equal(addBack.success, true);
    assert.equal(manager.getCount(), 20);
  });

  test('migrates local books to server on signup with exact PRD confirmation copy (SL-33)', async () => {
    const manager = new GuestManager();
    const calls: { workId: string; status: string }[] = [];
    const mockApi = {
      setStatus: async (workId: string, status: string) => {
        calls.push({ workId, status });
        return { success: true };
      },
    };

    // Add 4 books (matching PRD §4.2 example: "We've kept the 4 books you saved.")
    await manager.addBook({ id: 'w-1', title: 'Piranesi', author_name: 'Susanna Clarke' });
    await manager.addBook({ id: 'w-2', title: 'Klara and the Sun', author_name: 'Kazuo Ishiguro' });
    await manager.addBook({ id: 'w-3', title: 'The Left Hand of Darkness', author_name: 'Ursula K. Le Guin' });
    await manager.addBook({ id: 'w-4', title: 'Invisible Cities', author_name: 'Italo Calvino' });

    assert.equal(manager.getCount(), 4);

    const result = await manager.migrateToServer(mockApi);

    assert.equal(result.count, 4);
    assert.equal(result.message, "We've kept the 4 books you saved.");
    assert.equal(manager.getMigrationMessage(), "We've kept the 4 books you saved.");

    // Local shelf is cleared after migration
    assert.equal(manager.getCount(), 0);
    assert.equal(calls.length, 4);
    assert.deepEqual(
      calls.map((c) => c.status),
      ['want', 'want', 'want', 'want']
    );

    // Dismiss message
    manager.dismissMigrationMessage();
    assert.equal(manager.getMigrationMessage(), null);
  });

  test('formats singular confirmation copy for 1 saved book', async () => {
    const manager = new GuestManager();
    const calls: any[] = [];
    const mockApi = {
      setStatus: async (workId: string, status: string) => {
        calls.push({ workId, status });
      },
    };

    await manager.addBook({ id: 'single-1', title: 'Dune', author_name: 'Frank Herbert' });
    const result = await manager.migrateToServer(mockApi);
    assert.equal(result.count, 1);
    assert.equal(result.message, "We've kept the 1 book you saved.");
  });
});
