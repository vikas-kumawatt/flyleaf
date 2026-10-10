// Audit 10 (A-07-032): avatars on the PV-02 presigned upload path, purpose
// 'avatar'. The policy sets the types and size; complete() checks the magic
// bytes against the declared type; only a current avatar is ever served.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { profiles, users } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { MemoryObjectStorage } from '../providers/storage/index.js';
import { UPLOAD_POLICIES } from '../uploads/index.js';
import { freshDrizzle } from './pg.js';
import { block, makeUser, unlimited, type TestUser } from './interaction-fixtures.js';
import { completeUpload, sendToTarget, startUpload, uploadFile } from './upload-fixtures.js';

let db: Db;
let app: FastifyInstance;
let storage: MemoryObjectStorage;
let alice: TestUser;
let bob: TestUser;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(200, 2)]);

beforeAll(async () => {
  ({ db } = await freshDrizzle());
  storage = new MemoryObjectStorage();
  app = await buildApp({ db, identity: new IdentityService(db, unlimited), storage });
  alice = await makeUser(db, 'alice_av');
  bob = await makeUser(db, 'bob_av');
}, 60_000);
afterAll(async () => app?.close());

const avatar = (bytes: Buffer, contentType: string, who = alice) => uploadFile(app, who.auth, bytes, { purpose: 'avatar', contentType });
const setAvatar = (upload_id: string, who = alice) =>
  app.inject({ method: 'PUT', url: '/v1/me/avatar', headers: who.auth, payload: { upload_id } });
const keyOf = async (u: TestUser) =>
  (await db.select({ k: profiles.avatarKey }).from(profiles).where(eq(profiles.userId, u.id)))[0]!.k;

describe('avatar upload policy', () => {
  it('accepts JPEG, PNG and WebP up to 2 MB; refuses other types and larger files', async () => {
    expect(UPLOAD_POLICIES.avatar.maxBytes).toBe(2 * 1024 * 1024);
    const gif = await startUpload(app, alice.auth, 'GIF89a', { purpose: 'avatar', contentType: 'image/gif' });
    expect(gif.res.statusCode).toBe(415);
    const csv = await startUpload(app, alice.auth, 'a,b', { purpose: 'avatar', contentType: 'text/csv' });
    expect(csv.res.statusCode).toBe(415);
    const big = await startUpload(app, alice.auth, 'x', { purpose: 'avatar', contentType: 'image/jpeg', size: 2 * 1024 * 1024 + 1 });
    expect(big.res.statusCode).toBe(413);
    expect(big.res.json().error.message).toMatch(/2MB/);
    for (const [bytes, type] of [[JPEG, 'image/jpeg'], [PNG, 'image/png'], [WEBP, 'image/webp']] as const) {
      expect(await avatar(bytes, type)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('complete() refuses bytes that are not the declared image (magic bytes), and deletes them', async () => {
    for (const [bytes, type] of [[PNG, 'image/jpeg'], [Buffer.from('<svg onload=alert(1)>'), 'image/png'], [JPEG, 'image/webp']] as const) {
      const { res } = await startUpload(app, alice.auth, bytes, { purpose: 'avatar', contentType: type });
      const { id, target } = res.json();
      await sendToTarget(app, target, bytes);
      const done = await completeUpload(app, alice.auth, id);
      expect(done.statusCode).toBe(422);
      expect(done.json().error.code).toBe('upload_invalid_content');
    }
  });

  it('an image is still not an import: the import policy keeps refusing it', async () => {
    const { res } = await startUpload(app, alice.auth, JPEG, { contentType: 'text/csv' });
    const { id, target } = res.json();
    await sendToTarget(app, target, JPEG);
    expect((await completeUpload(app, alice.auth, id)).statusCode).toBe(422);
  });
});

describe('PUT/DELETE /me/avatar and GET /avatars/…', () => {
  it('sets the avatar, serves it to a guest by redirect, and the profile carries its URL', async () => {
    const id = await avatar(JPEG, 'image/jpeg');
    const res = await setAvatar(id);
    expect(res.statusCode).toBe(200);
    const url: string = res.json().avatar_url;
    expect(url).toBe(`/v1/avatars/uploads/${alice.id}/${id}`);
    const served = await app.inject({ method: 'GET', url });
    expect(served.statusCode).toBe(302);
    expect(served.headers.location).toBeTruthy();
    const profile = await app.inject({ method: 'GET', url: `/v1/users/${alice.id}`, headers: bob.auth });
    expect(profile.json().avatarUrl).toBe(url);
    // A replay of the same request is a success.
    expect((await setAvatar(id)).statusCode).toBe(200);
  });

  it('replacing it deletes the old image; the old URL is 404 and its upload cannot come back', async () => {
    const first = await avatar(PNG, 'image/png');
    await setAvatar(first);
    const oldKey = (await keyOf(alice))!;
    const second = await avatar(JPEG, 'image/jpeg');
    await setAvatar(second);
    expect(await storage.head(oldKey)).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/v1/avatars/${oldKey}` })).statusCode).toBe(404);
    const again = await setAvatar(first);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('upload_consumed');
  });

  it('only current avatars are served: an import file at the same path shape is 404', async () => {
    const csv = await uploadFile(app, alice.auth, 'Title,Author\nX,Y\n');
    const res = await app.inject({ method: 'GET', url: `/v1/avatars/uploads/${alice.id}/${csv}` });
    expect(res.statusCode).toBe(404);
  });

  it('another user\'s upload, an import upload, or a pending one cannot become my avatar', async () => {
    const bobs = await avatar(JPEG, 'image/jpeg', bob);
    expect((await setAvatar(bobs)).statusCode).toBe(404);
    const csv = await uploadFile(app, alice.auth, 'Title,Author\nX,Y\n');
    expect((await setAvatar(csv)).statusCode).toBe(404);
    const { res } = await startUpload(app, alice.auth, JPEG, { purpose: 'avatar', contentType: 'image/jpeg' });
    const pending = await setAvatar(res.json().id);
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error.code).toBe('upload_not_complete');
  });

  it('DELETE goes back to the generated avatar; a deleted account\'s avatar is not served', async () => {
    const id = await avatar(JPEG, 'image/jpeg', bob);
    const url = (await setAvatar(id, bob)).json().avatar_url;
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, bob.id));
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    await db.update(users).set({ deletedAt: null }).where(eq(users.id, bob.id));
    const removed = await app.inject({ method: 'DELETE', url: '/v1/me/avatar', headers: bob.auth });
    expect(removed.json()).toEqual({ avatar_url: null });
    expect(await keyOf(bob)).toBeNull();
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('PRD §16.3: a private account avatar is 404 to a guest, served to a signed-in user, and never across a block', async () => {
    const priv = await makeUser(db, 'priv_av', { isPrivate: true });
    const stranger = await makeUser(db, 'stranger_av');
    const url = (await setAvatar(await avatar(JPEG, 'image/jpeg', priv), priv)).json().avatar_url;
    const random = await app.inject({ method: 'GET', url: `/v1/avatars/uploads/${priv.id}/00000000-0000-4000-8000-000000000000` });
    expect(random.statusCode).toBe(404);
    const guest = await app.inject({ method: 'GET', url });
    expect(guest.statusCode).toBe(404);
    expect(guest.body).toBe(random.body);
    expect((await app.inject({ method: 'GET', url, headers: stranger.auth })).statusCode).toBe(302);
    await block(db, priv.id, stranger.id);
    const blocked = await app.inject({ method: 'GET', url, headers: stranger.auth });
    expect(blocked.statusCode).toBe(404);
    expect(blocked.body).toBe(random.body);
  });

  it('guests cannot set one', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v1/me/avatar', payload: { upload_id: '00000000-0000-4000-8000-000000000000' } });
    expect(res.statusCode).toBe(401);
  });
});
