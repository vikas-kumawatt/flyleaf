// HTTP conventions every route shares: the error shape and the viewer.
//
// The error envelope and the viewer-in-context pattern are the two things
// from this file that survive Phase -1 unchanged.

import type { FastifyReply, FastifyRequest } from 'fastify';

export const ERROR_SHAPE = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        field: { type: 'string' },
      },
      required: ['code', 'message'],
    },
  },
} as const;

/** Thrown anywhere; the global handler turns it into the standard envelope. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(code: string, message: string, field?: string) {
    return new ApiError(400, code, message, field);
  }
  static unauthorized(message = 'Sign in to do that.') {
    return new ApiError(401, 'auth_required', message);
  }
  /** Always 404 for another user's private resource — a 403 confirms it exists. */
  static notFound(message = 'Not found.') {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(code: string, message: string) {
    return new ApiError(409, code, message);
  }
  static unprocessable(code: string, message: string, field?: string) {
    return new ApiError(422, code, message, field);
  }
  static rateLimited(message = 'Too many attempts. Try again shortly.') {
    return new ApiError(429, 'rate_limited', message);
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated user, or null for a guest. */
    viewer: string | null;
  }
}

/**
 * Returns the viewer, or throws for routes that cannot serve a guest.
 *
 * A null viewer is a LEGITIMATE caller, not an error — that is what makes
 * guest mode a middleware concern rather than something every route
 * reimplements (PRD §4.2).
 */
export function requireViewer(req: FastifyRequest): string {
  if (!req.viewer) throw ApiError.unauthorized();
  return req.viewer;
}

export function sendError(reply: FastifyReply, err: ApiError) {
  return reply.status(err.status).send({
    error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) },
  });
}
