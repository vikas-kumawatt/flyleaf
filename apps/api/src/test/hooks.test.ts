// Fastify hook chain and guest-safe auth tests (FN-82, PRD §4.2, §24.2, Architecture §3.3 & §7).

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { registerCoreHooks } from '../app.js';
import { ApiError, requireViewer } from '../http.js';

describe('Hook chain and guest-safe auth (FN-82)', () => {
  function createTestApp(identityLookup?: (token: string) => Promise<string | null>) {
    const app = Fastify();
    registerCoreHooks(app, { identityLookup });

    // Guest-accessible route
    app.get('/test/guest-allowed', async (req) => ({
      viewer: req.viewer,
      isGuest: req.viewer === null,
    }));

    // Protected route requiring authenticated viewer
    app.get('/test/protected', async (req) => {
      const viewer = requireViewer(req);
      return { viewer };
    });

    // Route with Fastify body schema validation
    app.post(
      '/test/validation',
      {
        schema: {
          body: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email' },
              count: { type: 'integer', minimum: 1 },
            },
            required: ['email', 'count'],
          },
        },
      },
      async (req) => req.body,
    );

    // Route that throws ApiError
    app.get('/test/api-error', async () => {
      throw ApiError.notFound('Custom item not found.');
    });

    // Route that throws unhandled Error
    app.get('/test/unhandled-error', async () => {
      throw new Error('Database exploded unexpectedly');
    });

    return app;
  }

  it('guest requests have viewer === null and succeed on guest-accessible routes (PRD §4.2)', async () => {
    const app = createTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test/guest-allowed',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.viewer).toBeNull();
    expect(body.isGuest).toBe(true);

    await app.close();
  });

  it('protected routes reject guest requests with 401 auth_required', async () => {
    const app = createTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test/protected',
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('auth_required');

    await app.close();
  });

  it('valid Bearer token populates req.viewer and allows access to protected routes', async () => {
    const app = createTestApp(async (token) => {
      if (token === 'valid-jwt-token') return 'user-uuid-123';
      return null;
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: 'Bearer valid-jwt-token' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.viewer).toBe('user-uuid-123');

    await app.close();
  });

  it('auth hook is case-insensitive and handles extra whitespace', async () => {
    const app = createTestApp(async (token) => {
      if (token === 'valid-jwt-token') return 'user-uuid-456';
      return null;
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: 'bearer   valid-jwt-token  ' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).viewer).toBe('user-uuid-456');

    await app.close();
  });

  it('auth hook NEVER rejects on expired or invalid token — falls back to guest (PRD §4.2)', async () => {
    const app = createTestApp(async (_token) => {
      // Token expired or signature invalid
      return null;
    });
    await app.ready();

    // Guest route MUST succeed even with expired token
    const guestRes = await app.inject({
      method: 'GET',
      url: '/test/guest-allowed',
      headers: { authorization: 'Bearer expired-or-invalid-jwt' },
    });

    expect(guestRes.statusCode).toBe(200);
    expect(JSON.parse(guestRes.payload).viewer).toBeNull();

    // Protected route fails with 401 via requireViewer, not at the hook level
    const protectedRes = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: 'Bearer expired-or-invalid-jwt' },
    });

    expect(protectedRes.statusCode).toBe(401);

    await app.close();
  });

  it('auth hook safely handles lookup exceptions without crashing or 500ing', async () => {
    const app = createTestApp(async () => {
      throw new Error('Key store connection temporarily down');
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test/guest-allowed',
      headers: { authorization: 'Bearer some-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).viewer).toBeNull();

    await app.close();
  });

  it.each([
    'Basic dXNlcjpwYXNz',
    'Bearer',
    'Bearer ',
    'Token xyz123',
    'garbage-header-value',
  ])('auth hook safely ignores non-bearer or empty authorization header: %s', async (headerVal) => {
    const app = createTestApp(async () => 'should-not-reach-here');
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test/guest-allowed',
      headers: { authorization: headerVal },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).viewer).toBeNull();

    await app.close();
  });

  it('onSend hook attaches X-Request-Id and security headers', async () => {
    const app = createTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test/guest-allowed',
    });

    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');

    await app.close();
  });

  it('error handler maps ApiError to standard JSON envelope', async () => {
    const app = createTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test/api-error',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      error: {
        code: 'not_found',
        message: 'Custom item not found.',
      },
    });

    await app.close();
  });

  it('error handler maps Fastify validation errors to 422 invalid_field', async () => {
    const app = createTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/test/validation',
      payload: { email: 'not-an-email', count: 0 },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('invalid_field');

    await app.close();
  });

  it('error handler maps malformed JSON bodies to 400 invalid_json', async () => {
    const app = createTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/test/validation',
      headers: { 'content-type': 'application/json' },
      payload: '{ not valid json syntax ...',
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('invalid_json');

    await app.close();
  });

  it('setNotFoundHandler returns 404 with standard envelope for unknown routes', async () => {
    const app = createTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/non-existent-route-path',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      error: {
        code: 'not_found',
        message: 'Not found.',
      },
    });

    await app.close();
  });

  it('error handler sanitizes unhandled exceptions as 500 internal', async () => {
    const app = createTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test/unhandled-error',
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      error: {
        code: 'internal',
        message: 'Something went wrong.',
      },
    });

    await app.close();
  });
});
