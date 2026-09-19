// File storage abstraction for imports and exports (Architecture §3.7, PRD §6.8).
//
// Separating storage from HTTP routing allows swapping between local filesystem
// storage in dev/single-instance, in-memory storage in unit tests, and object
// storage (S3/GCS) when multiple instances require a shared bucket.

import fs from 'node:fs/promises';
import path from 'node:path';

export interface FileStorage {
  put(key: string, data: Buffer | Uint8Array, mimeType?: string): Promise<string>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

/**
 * Local filesystem storage. Writes files to a base directory (e.g. .uploads).
 */
export class DiskFileStorage implements FileStorage {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), '.uploads');
  }

  private resolvePath(key: string): string {
    // Prevent directory traversal
    const safeKey = key.replace(/^[/\\]+/, '').replace(/\.\.[/\\]/g, '');
    return path.join(this.baseDir, safeKey);
  }

  async put(key: string, data: Buffer | Uint8Array, _mimeType?: string): Promise<string> {
    const filePath = this.resolvePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    return key;
  }

  async get(key: string): Promise<Buffer | null> {
    const filePath = this.resolvePath(key);
    try {
      return await fs.readFile(filePath);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  async has(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * In-memory storage for isolated and fast unit tests.
 */
export class MemoryFileStorage implements FileStorage {
  private files = new Map<string, Buffer>();

  async put(key: string, data: Buffer | Uint8Array, _mimeType?: string): Promise<string> {
    this.files.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data));
    return key;
  }

  async get(key: string): Promise<Buffer | null> {
    return this.files.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  clear(): void {
    this.files.clear();
  }
}
