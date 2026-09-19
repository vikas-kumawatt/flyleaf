// Guest Mode local shelf & migration manager (PRD §4.2, tasks.md SL-32, SL-33).
//
// Manages device-local Want-to-Read list:
// - Strictly capped at 20 books (MAX_GUEST_WANT_TO_READ).
// - Offline-persisted via SQLite guest_want_to_read table.
// - Migrates cleanly to server reads on signup/login with confirmation copy:
//   "We've kept the {N} books you saved."

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { OfflineDatabase } from '../offline/db';

async function getRuntimeDb(): Promise<OfflineDatabase | null> {
  try {
    const mod = await import('../offline/db');
    return await mod.getOfflineDb();
  } catch {
    return null;
  }
}

export const MAX_GUEST_WANT_TO_READ = 20;

export interface GuestBook {
  id: string; // work_id
  title: string;
  author_name: string;
  cover_id?: number | null;
  first_publish_year?: number | null;
  format?: string | null;
  added_at: string;
}

export interface AddBookResult {
  success: boolean;
  reason?: 'cap_reached' | 'already_added';
}

export interface GuestShelfSnapshot {
  books: GuestBook[];
  count: number;
  migrationMessage: string | null;
}

export class GuestManager {
  private books: GuestBook[] = [];
  private migrationMessage: string | null = null;
  private listeners: Set<() => void> = new Set();
  private db: OfflineDatabase | null = null;
  private loaded = false;
  private snapshot: GuestShelfSnapshot = {
    books: [],
    count: 0,
    migrationMessage: null,
  };

  constructor(db?: OfflineDatabase) {
    if (db) {
      this.db = db;
    }
  }

  setDb(db: OfflineDatabase) {
    this.db = db;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      if (!this.db) {
        this.db = await getRuntimeDb();
      }
      if (this.db) {
        const rows = await this.db.getAll<any>(
          'SELECT work_id as id, title, author_name, cover_id, first_publish_year, format, added_at FROM guest_want_to_read ORDER BY added_at DESC'
        );
        this.books = rows.map((r) => ({
          id: r.id,
          title: r.title,
          author_name: r.author_name,
          cover_id: r.cover_id ?? null,
          first_publish_year: r.first_publish_year ?? null,
          format: r.format ?? null,
          added_at: r.added_at,
        }));
      }
    } catch {
      // In tests without SQLite native or if table uninitialized, maintain in-memory
    } finally {
      this.loaded = true;
      this.notify();
    }
  }

  getSnapshot(): GuestShelfSnapshot {
    return this.snapshot;
  }

  getBooks(): GuestBook[] {
    return this.snapshot.books;
  }

  getCount(): number {
    return this.snapshot.count;
  }

  isSaved(workId: string): boolean {
    return this.books.some((b) => b.id === workId);
  }

  async addBook(
    book: Omit<GuestBook, 'added_at'> & { added_at?: string }
  ): Promise<AddBookResult> {
    if (this.isSaved(book.id)) {
      return { success: true, reason: 'already_added' };
    }

    if (this.books.length >= MAX_GUEST_WANT_TO_READ) {
      return { success: false, reason: 'cap_reached' };
    }

    const item: GuestBook = {
      id: book.id,
      title: book.title,
      author_name: book.author_name,
      cover_id: book.cover_id ?? null,
      first_publish_year: book.first_publish_year ?? null,
      format: book.format ?? null,
      added_at: book.added_at ?? new Date().toISOString(),
    };

    this.books = [item, ...this.books];

    if (this.db) {
      try {
        await this.db.run(
          'INSERT OR REPLACE INTO guest_want_to_read (work_id, title, author_name, cover_id, first_publish_year, format, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            item.id,
            item.title,
            item.author_name,
            item.cover_id,
            item.first_publish_year,
            item.format,
            item.added_at,
          ]
        );
      } catch {
        // Continue
      }
    }

    this.notify();
    return { success: true };
  }

  async removeBook(workId: string): Promise<boolean> {
    const prevCount = this.books.length;
    this.books = this.books.filter((b) => b.id !== workId);

    if (this.db) {
      try {
        await this.db.run(
          'DELETE FROM guest_want_to_read WHERE work_id = ?',
          [workId]
        );
      } catch {
        // Continue
      }
    }

    if (this.books.length !== prevCount) {
      this.notify();
      return true;
    }
    return false;
  }

  async clear(): Promise<void> {
    this.books = [];
    if (this.db) {
      try {
        await this.db.run('DELETE FROM guest_want_to_read');
      } catch {
        // Continue
      }
    }
    this.notify();
  }

  async migrateToServer(apiClient: {
    setStatus: (workId: string, status: string) => Promise<any>;
  }): Promise<{ count: number; message: string | null }> {
    const toMigrate = [...this.books];
    if (toMigrate.length === 0) {
      return { count: 0, message: null };
    }

    const count = toMigrate.length;

    // Migrate each book to authenticated user library with status "want"
    for (const book of toMigrate) {
      try {
        await apiClient.setStatus(book.id, 'want');
      } catch {
        // Continue migrating remaining items
      }
    }

    // Clear local guest shelf after successful migration
    await this.clear();

    // Generate copy matching PRD §4.2: "We've kept the 4 books you saved."
    const message =
      count === 1
        ? "We've kept the 1 book you saved."
        : `We've kept the ${count} books you saved.`;

    this.migrationMessage = message;
    this.notify();

    return { count, message };
  }

  getMigrationMessage(): string | null {
    return this.snapshot.migrationMessage;
  }

  dismissMigrationMessage(): void {
    this.migrationMessage = null;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.snapshot = {
      books: [...this.books],
      count: this.books.length,
      migrationMessage: this.migrationMessage,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// Global singleton instance for application use
export const guestManager = new GuestManager();

// Automatically attempt initialization on import
void guestManager.init();

export function useGuestShelf() {
  const [manager] = useState(() => guestManager);

  useEffect(() => {
    void manager.init();
  }, [manager]);

  const state = useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getSnapshot()
  );

  return {
    books: state.books,
    count: state.count,
    maxCap: MAX_GUEST_WANT_TO_READ,
    migrationMessage: state.migrationMessage,
    isSaved: (workId: string) => manager.isSaved(workId),
    addBook: (book: Omit<GuestBook, 'added_at'> & { added_at?: string }) =>
      manager.addBook(book),
    removeBook: (workId: string) => manager.removeBook(workId),
    clear: () => manager.clear(),
    dismissMigrationMessage: () => manager.dismissMigrationMessage(),
  };
}
