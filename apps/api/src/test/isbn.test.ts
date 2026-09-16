// ISBN detection and exact edition resolution tests (FN-42, PRD §14.2, §14.4, §3374).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';

import {
  cleanIsbn,
  isValidIsbn10,
  isValidIsbn13,
  isbn10ToIsbn13,
  isbn13ToIsbn10,
  detectIsbn,
} from '../catalog/isbn.js';
import { CatalogService, catalogRoutes } from '../catalog/index.js';
import { MemoryCache, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { works, editions, authors, workAuthors } from '../db/schema.js';
import { ApiError } from '../http.js';
import { FlyleafClient } from '../../../../packages/api-client/dist/index.js';

describe('ISBN utilities (catalog/isbn.ts)', () => {
  it('cleanIsbn strips formatting and uppercases check digits', () => {
    expect(cleanIsbn('978-0-441-01359-3')).toBe('9780441013593');
    expect(cleanIsbn('0-8044-2957-x')).toBe('080442957X');
    expect(cleanIsbn('  0 441 01359 7  ')).toBe('0441013597');
  });

  it('isValidIsbn10 validates modulo-11 checksums including X', () => {
    expect(isValidIsbn10('0441013597')).toBe(true);
    expect(isValidIsbn10('080442957X')).toBe(true);
    expect(isValidIsbn10('0441013598')).toBe(false); // wrong check digit
    expect(isValidIsbn10('123456789')).toBe(false);  // 9 digits
    expect(isValidIsbn10('04410135970')).toBe(false); // 11 digits
  });

  it('isValidIsbn13 validates modulo-10 alternating checksums', () => {
    expect(isValidIsbn13('9780441013593')).toBe(true);
    expect(isValidIsbn13('9780140328721')).toBe(true);
    expect(isValidIsbn13('9780441013594')).toBe(false); // wrong check digit
    expect(isValidIsbn13('978044101359')).toBe(false);  // 12 digits
  });

  it('isbn10ToIsbn13 converts 10-digit ISBN to 978-prefixed 13-digit ISBN', () => {
    expect(isbn10ToIsbn13('0441013597')).toBe('9780441013593');
    expect(isbn10ToIsbn13('080442957X')).toBe('9780804429573');
    expect(isbn10ToIsbn13('0140328726')).toBe('9780140328721');
  });

  it('isbn13ToIsbn10 converts 978-prefixed 13-digit ISBN to 10-digit ISBN', () => {
    expect(isbn13ToIsbn10('9780441013593')).toBe('0441013597');
    expect(isbn13ToIsbn10('9780804429573')).toBe('080442957X');
    expect(isbn13ToIsbn10('9780140328721')).toBe('0140328726');
    // 979 prefix cannot be converted to ISBN-10
    expect(isbn13ToIsbn10('9791090636071')).toBeNull();
  });

  it('detectIsbn detects valid ISBN-10 and ISBN-13 with formatting', () => {
    const d10 = detectIsbn('0-441-01359-7');
    expect(d10).not.toBeNull();
    expect(d10?.isbn10).toBe('0441013597');
    expect(d10?.isbn13).toBe('9780441013593');

    const d13 = detectIsbn('978-0-14-032872-1');
    expect(d13).not.toBeNull();
    expect(d13?.isbn13).toBe('9780140328721');
    expect(d13?.isbn10).toBe('0140328726');
  });

  it('detectIsbn rejects non-ISBN text, invalid checksums, and random numbers', () => {
    expect(detectIsbn('Dune')).toBeNull();
    expect(detectIsbn('1984')).toBeNull();
    expect(detectIsbn('murakami')).toBeNull();
    expect(detectIsbn('1234567890')).toBeNull(); // invalid checksum
    expect(detectIsbn('9780000000000')).toBeNull(); // invalid checksum
  });
});

describe('CatalogService exact edition lookup & search (FN-42)', () => {
  let db: Db;
  let clientDb: PGlite;
  let service: CatalogService;
  let app: FastifyInstance;
  let client: FlyleafClient;

  const WORK_DUNE_ID = '11111111-1111-1111-1111-111111111111';
  const WORK_EARTHSEA_ID = '22222222-2222-2222-2222-222222222222';
  const EDITION_DUNE_ID = '33333333-3333-3333-3333-333333333333';
  const EDITION_EARTHSEA_ID = '44444444-4444-4444-4444-444444444444';

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    clientDb = fresh.client;

    const cache = new MemoryCache(100);
    service = new CatalogService(db, cache);

    // Seed authors
    const [frank] = await db.insert(authors).values({ name: 'Frank Herbert' }).returning();
    const [ursula] = await db.insert(authors).values({ name: 'Ursula K. Le Guin' }).returning();

    // Seed works
    await db.insert(works).values([
      { id: WORK_DUNE_ID, title: 'Dune', firstPublishYear: 1965, logCount: 44000 },
      { id: WORK_EARTHSEA_ID, title: 'A Wizard of Earthsea', firstPublishYear: 1968, logCount: 9000 },
    ]);

    // Seed work_authors
    await db.insert(workAuthors).values([
      { workId: WORK_DUNE_ID, authorId: frank!.id, position: 0 },
      { workId: WORK_EARTHSEA_ID, authorId: ursula!.id, position: 0 },
    ]);

    // Seed editions:
    // Dune has both isbn_13 ('9780441013593') and isbn_10 ('0441013597')
    await db.insert(editions).values({
      id: EDITION_DUNE_ID,
      workId: WORK_DUNE_ID,
      isbn13: '9780441013593',
      isbn10: '0441013597',
      title: 'Dune: 40th Anniversary Edition',
      publisher: 'Ace',
      publishYear: 2005,
      pageCount: 528,
      format: 'paperback',
      olCoverId: 101,
    });

    // Earthsea has only isbn_13 stored ('9780140328721')
    await db.insert(editions).values({
      id: EDITION_EARTHSEA_ID,
      workId: WORK_EARTHSEA_ID,
      isbn13: '9780140328721',
      title: 'A Wizard of Earthsea',
      publisher: 'Puffin',
      publishYear: 1971,
      pageCount: 208,
      format: 'paperback',
      olCoverId: 102,
    });

    app = Fastify();
    app.decorateRequest('viewer', null);
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ApiError) {
        return reply.status(err.status).send({
          error: { code: err.code, message: err.message, field: err.field },
        });
      }
      if ((err as any).validation) {
        const v = (err as any).validation[0];
        const field = v?.params?.missingProperty || v?.instancePath?.replace(/^\//, '') || undefined;
        return reply.status(422).send({
          error: {
            code: 'invalid_field',
            message: (err as Error).message,
            ...(field ? { field } : {}),
          },
        });
      }
      return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' } });
    });

    await app.register(catalogRoutes(service), { prefix: '/v1' });
    await app.ready();

    client = new FlyleafClient({
      baseUrl: 'http://localhost/v1',
      fetch: async (url, init) => {
        const u = new URL(url.toString());
        const res = await app.inject({
          method: (init?.method as any) ?? 'GET',
          url: `${u.pathname}${u.search}`,
          headers: init?.headers as any,
          payload: init?.body ? String(init.body) : undefined,
        });

        return {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => res.payload,
        } as unknown as Response;
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await clientDb?.close();
  });

  it('getEditionByIsbn resolves work and edition by ISBN-13', async () => {
    const result = await service.getEditionByIsbn(null, '9780441013593');
    expect(result).not.toBeNull();
    expect(result!.work.id).toBe(WORK_DUNE_ID);
    expect(result!.work.title).toBe('Dune');
    expect(result!.work.author_name).toBe('Frank Herbert');
    expect(result!.edition.id).toBe(EDITION_DUNE_ID);
    expect(result!.edition.isbn13).toBe('9780441013593');
    expect(result!.edition.page_count).toBe(528);
  });

  it('getEditionByIsbn resolves by hyphenated ISBN-10', async () => {
    const result = await service.getEditionByIsbn(null, '0-441-01359-7');
    expect(result).not.toBeNull();
    expect(result!.work.id).toBe(WORK_DUNE_ID);
    expect(result!.edition.id).toBe(EDITION_DUNE_ID);
  });

  it('getEditionByIsbn cross-converts: finds edition stored only as ISBN-13 using ISBN-10 query', async () => {
    // Earthsea only has isbn_13 in the db. Query with valid ISBN-10 '0140328726'.
    const result = await service.getEditionByIsbn(null, '0-14-032872-6');
    expect(result).not.toBeNull();
    expect(result!.work.id).toBe(WORK_EARTHSEA_ID);
    expect(result!.edition.id).toBe(EDITION_EARTHSEA_ID);
  });

  it('getEditionByIsbn throws 422 for invalid format or check digit', async () => {
    await expect(service.getEditionByIsbn(null, '1234567890')).rejects.toThrowError(
      expect.objectContaining({ status: 422, code: 'invalid_field' }),
    );
  });

  it('getEditionByIsbn returns null for valid but uncataloged ISBN', async () => {
    const result = await service.getEditionByIsbn(null, '9780000000026');
    expect(result).toBeNull();
  });

  it('search prioritizes exact ISBN match as result #1 (PRD §1013)', async () => {
    const results = await service.search('978-0-441-01359-3');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe(WORK_DUNE_ID);
    expect(results[0]!.title).toBe('Dune');
  });

  it('search with ISBN-10 query returns exact match first', async () => {
    const results = await service.search('0441013597');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe(WORK_DUNE_ID);
  });

  it('HTTP GET /v1/editions/isbn/:isbn returns 200 with { work, edition }', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/editions/isbn/978-0-441-01359-3',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.work.title).toBe('Dune');
    expect(body.edition.id).toBe(EDITION_DUNE_ID);
  });

  it('HTTP GET /v1/editions/isbn/:isbn returns 404 for unknown ISBN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/editions/isbn/9780000000026',
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('not_found');
  });

  it('HTTP GET /v1/editions/isbn/:isbn returns 422 for invalid ISBN checksum', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/editions/isbn/1234567890',
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('invalid_field');
  });

  it('Typed FlyleafClient getEditionByIsbn resolves barcode lookup', async () => {
    const res = await client.getEditionByIsbn('978-0-441-01359-3');
    expect(res.work.title).toBe('Dune');
    expect(res.edition.id).toBe(EDITION_DUNE_ID);
  });
});
