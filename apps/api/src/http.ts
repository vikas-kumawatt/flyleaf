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
  static unauthorized(arg1 = 'Sign in to do that.', arg2?: string) {
    if (arg2) return new ApiError(401, arg1, arg2);
    return new ApiError(401, 'auth_required', arg1);
  }
  /** Always 404 for another user's private resource — a 403 confirms it exists. */
  static notFound(message = 'Not found.') {
    return new ApiError(404, 'not_found', message);
  }
  static forbidden(code: string, message: string) {
    return new ApiError(403, code, message);
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

export type AdminViewer = {
  id: string;
  email: string;
  role: 'admin' | 'moderator';
};

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated user, or null for a guest. */
    viewer: string | null;
    /** The authenticated admin or moderator, or null. */
    admin: AdminViewer | null;
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

/**
 * Asserts the request was authenticated with a valid Admin session and has 'admin' role.
 */
export function requireAdmin(req: FastifyRequest): AdminViewer {
  if (!req.admin) {
    throw new ApiError(401, 'admin_auth_required', 'Admin authentication required.');
  }
  if (req.admin.role !== 'admin') {
    throw ApiError.forbidden('insufficient_role', 'Administrator role required.');
  }
  return req.admin;
}

/**
 * Asserts the request has an admin or moderator session.
 */
export function requireModerator(req: FastifyRequest): AdminViewer {
  if (!req.admin) {
    throw new ApiError(401, 'admin_auth_required', 'Admin or moderator authentication required.');
  }
  if (req.admin.role !== 'admin' && req.admin.role !== 'moderator') {
    throw ApiError.forbidden('insufficient_role', 'Moderator or administrator role required.');
  }
  return req.admin;
}

export function sendError(reply: FastifyReply, err: ApiError) {
  return reply.status(err.status).send({
    error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) },
  });
}
