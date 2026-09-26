// The route that plays the provider for `disk` and `memory` storage (PV-01).
//
// PUT with a signed URL stores an upload; GET with a signed URL serves a
// download. The checks mirror what S3 does with a presigned PUT: the
// signature covers key, content type, exact length and expiry, and a
// mismatch in any of them is refused before the body is read.
//
// Registered by buildApp only when the storage is a LocalObjectStorage, which
// production never allows (providers/index.ts). Hidden from the OpenAPI spec:
// it is not part of the API, it stands in for a vendor's endpoint.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ApiError } from '../../http.js';
import { attachmentDisposition } from './types.js';
import { LOCAL_OBJECT_ROUTE, type LocalObjectStorage, type SignedParams } from './local.js';

/** Above every upload policy's maximum; the signed length is the real cap. */
const ROUTE_BODY_LIMIT = 16 * 1024 * 1024;

type Query = Record<string, string | undefined>;

function putParams(q: Query): SignedParams | null {
  const len = Number(q.len);
  const exp = Number(q.exp);
  if (q.op !== 'put' || !q.key || q.ct === undefined || !Number.isSafeInteger(len) || !Number.isSafeInteger(exp)) {
    return null;
  }
  return { op: 'put', key: q.key, ct: q.ct, len, exp };
}

function getParams(q: Query): SignedParams | null {
  const exp = Number(q.exp);
  if (q.op !== 'get' || !q.key || !Number.isSafeInteger(exp)) return null;
  return { op: 'get', key: q.key, filename: q.filename ?? '', exp };
}

function check(storage: LocalObjectStorage, params: SignedParams | null, sig: string | undefined) {
  if (!params || !sig) throw ApiError.forbidden('signature_invalid', 'The signed URL is invalid.');
  const verdict = storage.verify(params, sig);
  if (verdict === 'bad_signature') throw ApiError.forbidden('signature_invalid', 'The signed URL is invalid.');
  if (verdict === 'expired') throw ApiError.forbidden('signature_expired', 'The signed URL has expired.');
  return params;
}

export function localStorageRoutes(storage: LocalObjectStorage): FastifyPluginAsync {
  return async (app) => {
    // Any body, any declared type, as raw bytes: this is an object store,
    // not a JSON endpoint. Scoped to this plugin.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    app.put(
      LOCAL_OBJECT_ROUTE,
      {
        bodyLimit: ROUTE_BODY_LIMIT,
        schema: { hide: true },
        // Before the body is read: a bad signature or a wrong declared
        // length costs nothing.
        onRequest: async (req: FastifyRequest) => {
          const q = req.query as Query;
          const params = check(storage, putParams(q), q.sig) as Extract<SignedParams, { op: 'put' }>;
          if ((req.headers['content-type'] ?? '') !== params.ct) {
            throw ApiError.forbidden('signature_invalid', 'Content-Type does not match the signed URL.');
          }
          if (Number(req.headers['content-length']) !== params.len) {
            throw ApiError.forbidden('signature_invalid', 'Content-Length does not match the signed URL.');
          }
        },
      },
      async (req, reply) => {
        const params = putParams(req.query as Query) as Extract<SignedParams, { op: 'put' }>;
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (body.length !== params.len) {
          throw ApiError.badRequest('length_mismatch', 'Body length does not match the signed URL.');
        }
        await storage.put(params.key, body, params.ct);
        return reply.status(200).send();
      },
    );

    app.get(LOCAL_OBJECT_ROUTE, { schema: { hide: true } }, async (req, reply) => {
      const q = req.query as Query;
      const params = check(storage, getParams(q), q.sig) as Extract<SignedParams, { op: 'get' }>;
      const obj = await storage.readForDownload(params.key);
      if (!obj) throw ApiError.notFound();
      reply.header('content-type', obj.contentType ?? 'application/octet-stream');
      if (params.filename) reply.header('content-disposition', attachmentDisposition(params.filename));
      reply.header('cache-control', 'private, no-store');
      return reply.send(obj.data);
    });
  };
}
