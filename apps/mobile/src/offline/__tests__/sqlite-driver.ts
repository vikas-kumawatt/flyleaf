// Node.js SQLite Driver for Offline Repository & Queue Testing
// Implements OfflineDatabase interface backed by node:sqlite DatabaseSync with
// serialized transaction support to prevent concurrent 'cannot start a transaction within a transaction' errors.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { OfflineDatabase } from '../db';

export class NodeSqliteDriver implements OfflineDatabase {
  private txLock = Promise.resolve();
  private txStorage = new AsyncLocalStorage<{ depth: number }>();
  private isOpen = true;

  constructor(private db: DatabaseSync) {}

  async exec(sql: string): Promise<void> {
    if (!this.isOpen) return;
    this.db.exec(sql);
  }

  async run(sql: string, params: any[] = []): Promise<{ rowsAffected: number; lastInsertRowId?: number }> {
    if (!this.isOpen) return { rowsAffected: 0 };
    const stmt = this.db.prepare(sql);
    const res = stmt.run(...params);
    return {
      rowsAffected: Number(res.changes),
      lastInsertRowId: Number(res.lastInsertRowid),
    };
  }

  async getAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    if (!this.isOpen) return [];
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async getFirst<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    if (!this.isOpen) return null;
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params);
    return (row ?? null) as T | null;
  }

  async transaction<T>(action: (tx: OfflineDatabase) => Promise<T>): Promise<T> {
    if (!this.isOpen) {
      return action(this);
    }
    const store = this.txStorage.getStore();

    if (store) {
      // Re-entrant / nested transaction: use SQLite SAVEPOINT
      store.depth++;
      const savepoint = `sp_${store.depth}`;
      if (this.isOpen) this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const res = await action(this);
        if (this.isOpen) this.db.exec(`RELEASE ${savepoint}`);
        return res;
      } catch (err) {
        try {
          if (this.isOpen) this.db.exec(`ROLLBACK TO ${savepoint}`);
        } catch {}
        throw err;
      } finally {
        store.depth--;
      }
    }

    // Root transaction: serialize via txLock mutex
    const prevLock = this.txLock;
    let releaseLock: () => void;
    this.txLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await prevLock;

    return this.txStorage.run({ depth: 1 }, async () => {
      if (!this.isOpen) {
        releaseLock!();
        return action(this);
      }
      this.db.exec('BEGIN');
      try {
        const res = await action(this);
        if (this.isOpen) this.db.exec('COMMIT');
        return res;
      } catch (err) {
        try {
          if (this.isOpen) this.db.exec('ROLLBACK');
        } catch {}
        throw err;
      } finally {
        releaseLock!();
      }
    });
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.db.close();
  }
}
