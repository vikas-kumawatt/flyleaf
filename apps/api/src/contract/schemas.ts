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

export const sessionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Session family UUID' },
    device: { type: ['string', 'null'], description: 'Device description or User-Agent' },
    createdAt: { type: 'string', format: 'date-time' },
    lastUsedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'createdAt', 'lastUsedAt'],
} as const;

export const sessionListResponseSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: sessionSchema },
  },
  required: ['data'],
} as const;

export const revokeSessionResponseSchema = standardStatusResponseSchema;

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

export const editionDetailSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    work_id: { type: 'string', format: 'uuid' },
    isbn13: { type: ['string', 'null'] },
    isbn10: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    publisher: { type: ['string', 'null'] },
    publish_year: { type: ['integer', 'null'] },
    page_count: { type: ['integer', 'null'] },
    format: { type: 'string' },
    cover_id: { type: ['integer', 'null'] },
  },
  required: ['id', 'work_id', 'format'],
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

export const editionLookupResponseSchema = {
  type: 'object',
  properties: {
    work: workSchema,
    edition: editionDetailSchema,
  },
  required: ['work', 'edition'],
} as const;

export const isbnParamSchema = {
  type: 'object',
  properties: {
    isbn: { type: 'string', minLength: 9, description: 'ISBN-10 or ISBN-13 barcode/string' },
  },
  required: ['isbn'],
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

// ---------------------------------------------------------------------------
// 4. Dedupe & Admin Schemas (FN-51, PRD §40.3, §3721)
// ---------------------------------------------------------------------------

export const dedupeWorkSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    authors: { type: 'array', items: { type: 'string' } },
    first_publish_year: { type: ['integer', 'null'] },
    log_count: { type: 'integer' },
    edition_count: { type: 'integer' },
    reads_count: { type: 'integer' },
    cover_id: { type: ['integer', 'null'] },
  },
  required: ['id', 'title', 'authors', 'log_count', 'edition_count'],
} as const;

export const dedupeQueueItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    stage: { type: 'integer', enum: [3, 4] },
    status: { type: 'string', enum: ['pending', 'merged', 'dismissed'] },
    confidence: { type: ['number', 'null'] },
    reason: { type: 'string' },
    dismiss_reason: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
    reviewed_at: { type: ['string', 'null'], format: 'date-time' },
    reviewed_by_user_id: { type: ['string', 'null'], format: 'uuid' },
    survivor: dedupeWorkSummarySchema,
    loser: dedupeWorkSummarySchema,
  },
  required: ['id', 'stage', 'status', 'reason', 'created_at', 'survivor', 'loser'],
} as const;

export const dedupeQueueListResponseSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: dedupeQueueItemSchema },
  },
  required: ['data'],
} as const;

export const dedupeQueueQuerySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pending', 'merged', 'dismissed'], default: 'pending' },
    stage: { type: 'integer', enum: [3, 4] },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const dedupePreviewResponseSchema = {
  type: 'object',
  properties: {
    survivor: dedupeWorkSummarySchema,
    loser: dedupeWorkSummarySchema,
    preview: {
      type: 'object',
      properties: {
        reads_to_move: { type: 'integer' },
        colliding_reads: { type: 'integer' },
        editions_to_move: { type: 'integer' },
        authors_to_add: { type: 'integer' },
        subjects_to_add: { type: 'integer' },
      },
      required: ['reads_to_move', 'colliding_reads', 'editions_to_move', 'authors_to_add', 'subjects_to_add'],
    },
  },
  required: ['survivor', 'loser', 'preview'],
} as const;

export const dedupeResolveBodySchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['merge', 'dismiss'] },
    reason: { type: 'string' },
  },
  required: ['action'],
} as const;

export const dedupeResolveResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    action: { type: 'string', enum: ['merge', 'dismiss'] },
    merge_id: { type: 'string', format: 'uuid' },
  },
  required: ['success', 'action'],
} as const;

export const dedupeReportBodySchema = {
  type: 'object',
  properties: {
    survivor_id: { type: 'string', format: 'uuid' },
    loser_id: { type: 'string', format: 'uuid' },
    reason: { type: 'string', minLength: 3 },
  },
  required: ['survivor_id', 'loser_id', 'reason'],
} as const;

export const dedupeReportResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    queued: { type: 'boolean' },
  },
  required: ['id', 'queued'],
} as const;

export const mergeListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    survivor: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
      },
      required: ['id', 'title'],
    },
    loser: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
      },
      required: ['id', 'title'],
    },
    stage: { type: 'integer' },
    reason: { type: 'string' },
    merged_at: { type: 'string', format: 'date-time' },
    undone_at: { type: ['string', 'null'], format: 'date-time' },
    can_undo: { type: 'boolean' },
    stats: {
      type: 'object',
      properties: {
        reads_moved: { type: 'integer' },
        editions_moved: { type: 'integer' },
        authors_moved: { type: 'integer' },
      },
      required: ['reads_moved', 'editions_moved', 'authors_moved'],
    },
  },
  required: ['id', 'survivor', 'loser', 'stage', 'reason', 'merged_at', 'can_undo', 'stats'],
} as const;

export const mergeListResponseSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: mergeListItemSchema },
  },
  required: ['data'],
} as const;

export const undoMergeResponseSchema = {
  type: 'object',
  properties: {
    undone: { type: 'boolean' },
    merge_id: { type: 'string', format: 'uuid' },
    survivor_id: { type: 'string', format: 'uuid' },
    loser_id: { type: 'string', format: 'uuid' },
    restored: {
      type: 'object',
      properties: {
        reads: { type: 'integer' },
        editions: { type: 'integer' },
        authors: { type: 'integer' },
        subjects: { type: 'integer' },
      },
      required: ['reads', 'editions', 'authors', 'subjects'],
    },
  },
  required: ['undone', 'merge_id', 'survivor_id', 'loser_id', 'restored'],
} as const;

// ---------------------------------------------------------------------------
// 5. Admin Auth & Audit Schemas (FN-90, FN-93, PRD §27.5)
// ---------------------------------------------------------------------------

export const adminViewerSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['admin', 'moderator'] },
  },
  required: ['id', 'email', 'role'],
} as const;

export const adminLoginBodySchema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 1 },
    totp_code: { type: 'string', minLength: 6, maxLength: 10, description: '6-digit TOTP code or backup code' },
  },
  required: ['email', 'password', 'totp_code'],
} as const;

export const adminLoginResponseSchema = {
  type: 'object',
  properties: {
    token: { type: 'string', description: 'Admin JWT scoped to flyleaf-admin' },
    admin: adminViewerSchema,
  },
  required: ['token', 'admin'],
} as const;

export const adminMeResponseSchema = {
  type: 'object',
  properties: {
    admin: adminViewerSchema,
  },
  required: ['admin'],
} as const;

export const admin2faSetupResponseSchema = {
  type: 'object',
  properties: {
    secret: { type: 'string' },
    otpauth_uri: { type: 'string' },
    backup_codes: { type: 'array', items: { type: 'string' } },
  },
  required: ['secret', 'otpauth_uri', 'backup_codes'],
} as const;

export const admin2faVerifyBodySchema = {
  type: 'object',
  properties: {
    code: { type: 'string', minLength: 6, maxLength: 6 },
  },
  required: ['code'],
} as const;

export const admin2faVerifyResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
  },
  required: ['success'],
} as const;

export const adminAuditLogItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    actor_id: { type: 'string', format: 'uuid' },
    actor_email: { type: 'string' },
    actor_role: { type: 'string' },
    action: { type: 'string' },
    subject_type: { type: ['string', 'null'] },
    subject_id: { type: ['string', 'null'], format: 'uuid' },
    reason: { type: ['string', 'null'] },
    payload: { type: 'object' },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'actor_id', 'actor_email', 'actor_role', 'action', 'payload', 'created_at'],
} as const;

export const adminAuditLogQuerySchema = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    actor_id: { type: 'string', format: 'uuid' },
    subject_type: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const adminAuditLogListResponseSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: adminAuditLogItemSchema },
  },
  required: ['data'],
} as const;


