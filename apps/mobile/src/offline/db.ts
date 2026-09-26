import React, { useState, useEffect } from 'react';
import * as SQLite from 'expo-sqlite';
import { migrateOfflineDb } from './migrations';

export interface OfflineDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: any[]): Promise<{ rowsAffected: number; lastInsertRowId?: number }>;
  getAll<T = any>(sql: string, params?: any[]): Promise<T[]>;
  getFirst<T = any>(sql: string, params?: any[]): Promise<T | null>;
  transaction<T>(action: (tx: OfflineDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class ExpoSqliteDriver implements OfflineDatabase {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async exec(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async run(sql: string, params: any[] = []): Promise<{ rowsAffected: number; lastInsertRowId?: number }> {
    const result = await this.db.runAsync(sql, ...params);
    return {
      rowsAffected: result.changes,
      lastInsertRowId: result.lastInsertRowId,
    };
  }

  async getAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, ...params);
  }

  async getFirst<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    return this.db.getFirstAsync<T>(sql, ...params);
  }

  async transaction<T>(action: (tx: OfflineDatabase) => Promise<T>): Promise<T> {
    let result: T;
    await this.db.withTransactionAsync(async () => {
      result = await action(this);
    });
    return result!;
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }
}

let dbInstance: OfflineDatabase | null = null;
let initPromise: Promise<OfflineDatabase> | null = null;

export async function getOfflineDb(name = 'flyleaf.db'): Promise<OfflineDatabase> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const rawDb = await SQLite.openDatabaseAsync(name);
    const driver = new ExpoSqliteDriver(rawDb);
    // Before anything reads it (PRD §34.5)
    await migrateOfflineDb(driver);
    dbInstance = driver;
    return driver;
  })();

  return initPromise;
}

// For testing / simulated process death: reset singleton instance
export function resetDbInstance() {
  dbInstance = null;
  initPromise = null;
}

/** React hook resolving the local OfflineDatabase instance */
export function useDatabase(): OfflineDatabase | null {
  const [db, setDb] = React.useState<OfflineDatabase | null>(dbInstance);

  React.useEffect(() => {
    if (!db) {
      void getOfflineDb().then((instance) => {
        setDb(instance);
      });
    }
  }, [db]);

  return db;
}

