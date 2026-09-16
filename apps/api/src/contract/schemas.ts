// Fastify route schemas and OpenAPI 3.1 definitions (FN-80, Architecture §6).
//
// These schemas serve as BOTH runtime validation in Fastify AND the OpenAPI 3.1
// specification exported to openapi.yaml.

export const errorResponseSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Machine-readable error code' },
        message: { type: 'string', description: 'Human-readable error description' },
        field: { type: 'string', description: 'Invalid field name if applicable' },
      },
      required: ['code', 'message'],
    },
  },
  required: ['error'],
} as const;

export const idParamSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Resource UUID' },
  },
  required: ['id'],
} as const;

// ---------------------------------------------------------------- identity

export const userSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    username: { type: 'string' },
  },
  required: ['id', 'email', 'username'],
} as const;

export const profileSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    username: { type: 'string' },
    displayName: { type: ['string', 'null'] },
    bio: { type: ['string', 'null'] },
    avatarKey: { type: ['string', 'null'] },
    isPrivate: { type: 'boolean' },
    followerCount: { type: 'integer' },
    followingCount: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'username', 'isPrivate', 'followerCount', 'followingCount', 'createdAt'],
} as const;

export const registerBodySchema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email', description: 'Valid email address' },
    username: {
      type: 'string',
      minLength: 3,
      maxLength: 20,
      pattern: '^[a-z0-9_]{3,20}$',
      description: '3–20 characters, lowercase alphanumeric and underscores',
    },
    password: { type: 'string', minLength: 10, description: 'Minimum 10 characters' },
    dateOfBirth: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'YYYY-MM-DD format (must be 13+ years old per PRD §26.6)',
    },
  },
  required: ['email', 'username', 'password', 'dateOfBirth'],
} as const;

export const registerResponseSchema = {
  type: 'object',
  properties: {
    user: userSchema,
    accessToken: { type: 'string', description: '15-minute stateless access JWT' },
    refreshToken: { type: 'string', description: '60-day opaque rotating refresh token' },
  },
  required: ['user', 'accessToken', 'refreshToken'],
} as const;

export const loginBodySchema = {
  type: 'object',
  properties: {
    email: { type: 'string' },
    password: { type: 'string' },
  },
  required: ['email', 'password'],
} as const;

export const loginResponseSchema = registerResponseSchema;

export const refreshBodySchema = {
  type: 'object',
  properties: {
    refreshToken: { type: 'string', minLength: 1 },
  },
  required: ['refreshToken'],
} as const;

export const refreshResponseSchema = {
  type: 'object',
  properties: {
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
  },
  required: ['accessToken', 'refreshToken'],
} as const;

export const logoutResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok'] },
  },
  required: ['status'],
} as const;

export const standardStatusResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok'] },
    message: { type: 'string' },
  },
  required: ['status', 'message'],
} as const;

export const verifyEmailBodySchema = {
  type: 'object',
  properties: {
    token: { type: 'string', minLength: 1, description: 'Email verification token' },
  },
  required: ['token'],
} as const;

export const verifyEmailResponseSchema = standardStatusResponseSchema;
export const resendVerificationResponseSchema = standardStatusResponseSchema;

export const forgotPasswordBodySchema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email', description: 'Account email address' },
  },
  required: ['email'],
} as const;

export const forgotPasswordResponseSchema = standardStatusResponseSchema;

export const resetPasswordBodySchema = {
  type: 'object',
  properties: {
    token: { type: 'string', minLength: 1, description: 'Password reset token' },
    newPassword: { type: 'string', minLength: 10, description: 'New password (minimum 10 characters)' },
  },
  required: ['token', 'newPassword'],
} as const;

export const resetPasswordResponseSchema = standardStatusResponseSchema;

// ---------------------------------------------------------------- catalog

export const editionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    isbn13: { type: ['string', 'null'] },
    page_count: { type: ['integer', 'null'] },
    format: { type: 'string' },
    cover_id: { type: ['integer', 'null'] },
  },
  required: ['id', 'format'],
} as const;

export const yourReadSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string' },
    rating: { type: ['number', 'null'] },
    hearted: { type: 'boolean' },
    page: { type: ['integer', 'null'] },
    percent: { type: ['number', 'null'] },
  },
  required: ['id', 'status', 'hearted'],
} as const;

export const workSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    author_name: { type: 'string' },
    first_publish_year: { type: ['integer', 'null'] },
    cover_id: { type: ['integer', 'null'] },
    log_count: { type: 'integer' },
    editions: { type: 'array', items: editionSchema },
    your_read: yourReadSchema,
  },
  required: ['id', 'title', 'author_name', 'log_count'],
} as const;

export const searchQuerySchema = {
  type: 'object',
  properties: {
    q: { type: 'string', description: 'Search term (minimum 2 chars)' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
} as const;

export const searchResponseSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: workSchema },
  },
  required: ['data'],
} as const;

// ---------------------------------------------------------------- reading

export const readSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    user_id: { type: 'string', format: 'uuid' },
    work_id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['want', 'reading', 'paused', 'finished', 'dnf'] },
    attempt_no: { type: 'integer' },
    rating: { type: ['number', 'null'] },
    hearted: { type: 'boolean' },
    visibility: { type: 'string', enum: ['public', 'followers', 'private'] },
    title: { type: 'string' },
    author_name: { type: 'string' },
    cover_id: { type: ['integer', 'null'] },
    page: { type: ['integer', 'null'] },
    percent: { type: ['number', 'null'] },
    page_count: { type: ['integer', 'null'] },
  },
  required: ['id', 'user_id', 'work_id', 'status', 'attempt_no', 'hearted', 'visibility'],
} as const;

export const readListResponseSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: readSchema },
  },
  required: ['data'],
} as const;

export const statusQuerySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['want', 'reading', 'paused', 'finished', 'dnf'] },
  },
} as const;

export const upsertReadBodySchema = {
  type: 'object',
  properties: {
    work_id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['want', 'reading', 'paused', 'finished', 'dnf'] },
    rating: { type: ['number', 'null'], minimum: 0.5, maximum: 5.0 },
    hearted: { type: ['boolean', 'null'] },
    visibility: { type: 'string', enum: ['public', 'followers', 'private'], default: 'public' },
  },
  required: ['work_id', 'status'],
} as const;

export const progressEventBodySchema = {
  type: 'object',
  properties: {
    client_event_id: { type: 'string', format: 'uuid', description: 'Idempotency key' },
    page: { type: ['integer', 'null'], minimum: 0 },
    percent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
    minutes: { type: ['integer', 'null'], minimum: 0 },
  },
  required: ['client_event_id'],
} as const;
