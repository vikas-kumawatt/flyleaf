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

export const profileFavouriteSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    author_name: { type: 'string' },
    cover_id: { type: ['integer', 'null'] },
  },
  required: ['id', 'title', 'author_name'],
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
    favourite_work_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      maxItems: 4,
    },
    favourites: {
      type: 'array',
      items: profileFavouriteSchema,
      maxItems: 4,
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'username', 'isPrivate', 'followerCount', 'followingCount', 'createdAt'],
} as const;

export const updateProfileBodySchema = {
  type: 'object',
  properties: {
    displayName: { type: ['string', 'null'], maxLength: 100 },
    bio: { type: ['string', 'null'], maxLength: 160 },
    isPrivate: { type: 'boolean' },
    favouriteWorkIds: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      maxItems: 4,
    },
  },
} as const;

export const updateProfileResponseSchema = profileSchema;

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
    avg_rating: { type: ['number', 'null'] },
    weighted_rating: { type: ['number', 'null'] },
    rating_count: { type: ['integer', 'null'] },
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
    edition_id: { type: ['string', 'null'], format: 'uuid' },
    status: { type: 'string', enum: ['want', 'reading', 'paused', 'finished', 'dnf'] },
    attempt_no: { type: 'integer' },
    started_at: { type: ['string', 'null'] },
    finished_at: { type: ['string', 'null'] },
    abandoned_at: { type: ['string', 'null'] },
    abandoned_page: { type: ['integer', 'null'] },
    dnf_reason: { type: ['string', 'null'] },
    rating: { type: ['number', 'null'] },
    hearted: { type: 'boolean' },
    format_override: { type: ['string', 'null'], enum: ['print', 'ebook', 'audiobook', null] },
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
    edition_id: { type: ['string', 'null'], format: 'uuid' },
    started_at: { type: ['string', 'null'] },
    finished_at: { type: ['string', 'null'] },
    abandoned_page: { type: ['integer', 'null'] },
    dnf_reason: { type: ['string', 'null'] },
    rating: { type: ['number', 'null'], minimum: 0.5, maximum: 5.0 },
    hearted: { type: ['boolean', 'null'] },
    format_override: { type: ['string', 'null'], enum: ['print', 'ebook', 'audiobook', null] },
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
    audio_seconds: { type: ['integer', 'null'], minimum: 0 },
    minutes: { type: ['integer', 'null'], minimum: 0 },
    note: { type: ['string', 'null'], maxLength: 280 },
  },
  required: ['client_event_id'],
} as const;

export const finishReadBodySchema = {
  type: 'object',
  properties: {
    finished_at: { type: ['string', 'null'] },
    rating: { type: ['number', 'null'], minimum: 0.5, maximum: 5.0 },
    hearted: { type: ['boolean', 'null'] },
    format_override: { type: ['string', 'null'], enum: ['print', 'ebook', 'audiobook', null] },
    review: { type: ['string', 'null'] },
    visibility: { type: 'string', enum: ['public', 'followers', 'private'], default: 'public' },
  },
} as const;

export const dnfReadBodySchema = {
  type: 'object',
  properties: {
    abandoned_page: { type: ['integer', 'null'], minimum: 0 },
    dnf_reason: { type: ['string', 'null'] },
    note: { type: ['string', 'null'], maxLength: 280 },
    rating: { type: ['number', 'null'], minimum: 0.5, maximum: 5.0 },
    visibility: { type: 'string', enum: ['public', 'followers', 'private'], default: 'public' },
  },
} as const;

// ---------------------------------------------------------------- stats (SL-74)

export const monthlyPaceItemSchema = {
  type: 'object',
  properties: {
    month: { type: 'integer', minimum: 1, maximum: 12 },
    books: { type: 'integer', minimum: 0 },
    pages: { type: 'integer', minimum: 0 },
  },
  required: ['month', 'books', 'pages'],
} as const;

export const extremeBookSchema = {
  type: 'object',
  properties: {
    work_id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    author_name: { type: ['string', 'null'] },
    page_count: { type: ['integer', 'null'] },
    cover_id: { type: ['integer', 'null'] },
  },
  required: ['work_id', 'title'],
} as const;

export const readingStatsQuerySchema = {
  type: 'object',
  properties: {
    year: { type: 'string' },
  },
} as const;

export const readingStatsResponseSchema = {
  type: 'object',
  properties: {
    year: { type: 'string' },
    books_count: { type: 'integer' },
    pages_count: { type: 'integer' },
    audio_hours: { type: 'number' },
    avg_rating: { type: ['number', 'null'] },
    rating_distribution: {
      type: 'object',
      properties: {
        '5': { type: 'integer' },
        '4': { type: 'integer' },
        '3': { type: 'integer' },
        '2': { type: 'integer' },
        '1': { type: 'integer' },
      },
      required: ['5', '4', '3', '2', '1'],
    },
    format_breakdown: {
      type: 'object',
      properties: {
        print: { type: 'integer' },
        ebook: { type: 'integer' },
        audiobook: { type: 'integer' },
      },
      required: ['print', 'ebook', 'audiobook'],
    },
    monthly_pace: {
      type: 'array',
      items: monthlyPaceItemSchema,
    },
    longest_book: {
      anyOf: [extremeBookSchema, { type: 'null' }],
    },
    shortest_book: {
      anyOf: [extremeBookSchema, { type: 'null' }],
    },
    most_read_author: {
      anyOf: [
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'integer' },
          },
          required: ['name', 'count'],
        },
        { type: 'null' },
      ],
    },
    dnf_count: { type: 'integer' },
    dnf_rate: { type: 'number' },
    current_streak: { type: 'integer' },
    longest_streak: { type: 'integer' },
  },
  required: [
    'year',
    'books_count',
    'pages_count',
    'audio_hours',
    'rating_distribution',
    'format_breakdown',
    'monthly_pace',
    'dnf_count',
    'dnf_rate',
    'current_streak',
    'longest_streak',
  ],
} as const;

// ---------------------------------------------------------------- reviews & social (SL-63, SL-64)

export const reviewAuthorSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    username: { type: 'string' },
    display_name: { type: ['string', 'null'] },
    avatar_url: { type: ['string', 'null'] },
  },
  required: ['id', 'username'],
} as const;

export const reviewSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    read_id: { type: 'string', format: 'uuid' },
    user_id: { type: 'string', format: 'uuid' },
    work_id: { type: 'string', format: 'uuid' },
    body: { type: 'string' },
    has_spoilers: { type: 'boolean' },
    spoiler_after_page: { type: ['integer', 'null'] },
    visibility: { type: 'string', enum: ['public', 'followers', 'private'] },
    published_at: { type: 'string' },
    edited_at: { type: ['string', 'null'] },
    rating: { type: ['number', 'null'] },
    hearted: { type: 'boolean' },
    format_override: { type: ['string', 'null'] },
    like_count: { type: 'integer' },
    viewer_has_liked: { type: 'boolean' },
    author: reviewAuthorSchema,
    work_title: { type: ['string', 'null'] },
    work_author: { type: ['string', 'null'] },
    work_cover_id: { type: ['integer', 'null'] },
  },
  required: [
    'id',
    'read_id',
    'user_id',
    'work_id',
    'body',
    'has_spoilers',
    'visibility',
    'published_at',
    'hearted',
    'like_count',
    'viewer_has_liked',
    'author',
  ],
} as const;

export const createReviewBodySchema = {
  type: 'object',
  properties: {
    body: { type: 'string', minLength: 1, maxLength: 10000 },
    has_spoilers: { type: 'boolean', default: false },
    spoiler_after_page: { type: ['integer', 'null'], minimum: 0 },
    visibility: { type: 'string', enum: ['public', 'followers', 'private'], default: 'public' },
    rating: { type: ['number', 'null'], minimum: 0.5, maximum: 5.0 },
    hearted: { type: ['boolean', 'null'] },
  },
  required: ['body'],
} as const;

export const updateReviewBodySchema = {
  type: 'object',
  properties: {
    body: { type: 'string', minLength: 1, maxLength: 10000 },
    has_spoilers: { type: 'boolean' },
    spoiler_after_page: { type: ['integer', 'null'], minimum: 0 },
    visibility: { type: 'string', enum: ['public', 'followers', 'private'] },
    rating: { type: ['number', 'null'], minimum: 0.5, maximum: 5.0 },
    hearted: { type: ['boolean', 'null'] },
  },
} as const;

export const workReviewsQuerySchema = {
  type: 'object',
  properties: {
    sort: { type: 'string', enum: ['friends', 'likes', 'newest', 'highest', 'lowest'], default: 'friends' },
    rating: { type: 'number', minimum: 0.5, maximum: 5.0 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const workReviewsResponseSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: reviewSchema },
    total: { type: 'integer' },
  },
  required: ['data', 'total'],
} as const;

export const toggleLikeResponseSchema = {
  type: 'object',
  properties: {
    liked: { type: 'boolean' },
    like_count: { type: 'integer' },
  },
  required: ['liked', 'like_count'],
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

export const adminCatalogWorkSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    subtitle: { type: ['string', 'null'] },
    author_name: { type: 'string' },
    first_publish_year: { type: ['integer', 'null'] },
    ol_cover_id: { type: ['integer', 'null'] },
    maturity: { type: 'string', enum: ['general', 'mature', 'explicit', 'unclassified'] },
    log_count: { type: 'integer' },
    is_locked: { type: 'boolean' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'title', 'author_name', 'maturity', 'log_count', 'is_locked', 'updated_at'],
} as const;

export const adminCatalogWorksQuerySchema = {
  type: 'object',
  properties: {
    maturity: { type: 'string', enum: ['general', 'mature', 'explicit', 'unclassified'] },
    q: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const adminCatalogWorksListResponseSchema = {
  type: 'object',
  properties: {
    works: { type: 'array', items: adminCatalogWorkSummarySchema },
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  },
  required: ['works', 'total', 'limit', 'offset'],
} as const;

export const adminCatalogWorkResponseSchema = {
  type: 'object',
  properties: {
    work: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        subtitle: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        alternate_titles: { type: 'array', items: { type: 'string' } },
        first_publish_year: { type: ['integer', 'null'] },
        ol_cover_id: { type: ['integer', 'null'] },
        maturity: { type: 'string', enum: ['general', 'mature', 'explicit', 'unclassified'] },
        log_count: { type: 'integer' },
        is_locked: { type: 'boolean' },
        ol_work_key: { type: ['string', 'null'] },
        authors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              role: { type: 'string' },
            },
            required: ['id', 'name', 'role'],
          },
        },
        subjects: { type: 'array', items: { type: 'string' } },
        editions_count: { type: 'integer' },
        provenance: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field_name: { type: 'string' },
              provider: { type: 'string' },
              is_locked: { type: 'boolean' },
              fetched_at: { type: 'string', format: 'date-time' },
            },
            required: ['field_name', 'provider', 'is_locked', 'fetched_at'],
          },
        },
        audit_history: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              action: { type: 'string' },
              actor_email: { type: 'string' },
              reason: { type: ['string', 'null'] },
              payload: { type: 'object' },
              created_at: { type: 'string', format: 'date-time' },
            },
            required: ['id', 'action', 'actor_email', 'payload', 'created_at'],
          },
        },
      },
      required: [
        'id',
        'title',
        'maturity',
        'log_count',
        'is_locked',
        'authors',
        'subjects',
        'editions_count',
        'provenance',
        'audit_history',
      ],
    },
  },
  required: ['work'],
} as const;

export const adminMaturityOverrideBodySchema = {
  type: 'object',
  properties: {
    maturity: { type: 'string', enum: ['general', 'mature', 'explicit', 'unclassified'] },
    reason: { type: 'string', minLength: 3 },
  },
  required: ['maturity', 'reason'],
} as const;

export const adminMaturityOverrideResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    work_id: { type: 'string', format: 'uuid' },
    previous_maturity: { type: 'string', enum: ['general', 'mature', 'explicit', 'unclassified'] },
    new_maturity: { type: 'string', enum: ['general', 'mature', 'explicit', 'unclassified'] },
    is_locked: { type: 'boolean' },
  },
  required: ['success', 'work_id', 'previous_maturity', 'new_maturity', 'is_locked'],
} as const;

export const adminIngestRunSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    dump_type: { type: 'string' },
    status: { type: 'string' },
    lines_read: { type: 'integer' },
    rows_written: { type: 'integer' },
    rows_skipped: { type: 'integer' },
    error: { type: ['string', 'null'] },
    started_at: { type: 'string', format: 'date-time' },
    finished_at: { type: ['string', 'null'], format: 'date-time' },
    duration_seconds: { type: ['integer', 'null'] },
  },
  required: ['id', 'dump_type', 'status', 'lines_read', 'rows_written', 'rows_skipped', 'started_at'],
} as const;

export const adminIngestStatusResponseSchema = {
  type: 'object',
  properties: {
    last_run: { anyOf: [adminIngestRunSchema, { type: 'null' }] },
    recent_runs: { type: 'array', items: adminIngestRunSchema },
    runs_summary: {
      type: 'object',
      properties: {
        total_runs: { type: 'integer' },
        completed: { type: 'integer' },
        failed: { type: 'integer' },
        interrupted: { type: 'integer' },
        running: { type: 'integer' },
      },
      required: ['total_runs', 'completed', 'failed', 'interrupted', 'running'],
    },
    catalog: {
      type: 'object',
      properties: {
        works_count: { type: 'integer' },
        editions_count: { type: 'integer' },
        authors_count: { type: 'integer' },
        authorship_links_count: { type: 'integer' },
        works_with_cover_count: { type: 'integer' },
        raw_payloads_count: { type: 'integer' },
      },
      required: [
        'works_count',
        'editions_count',
        'authors_count',
        'authorship_links_count',
        'works_with_cover_count',
        'raw_payloads_count',
      ],
    },
    maturity_breakdown: {
      type: 'object',
      properties: {
        general: { type: 'integer' },
        mature: { type: 'integer' },
        explicit: { type: 'integer' },
        unclassified: { type: 'integer' },
        overridden_locked: { type: 'integer' },
      },
      required: ['general', 'mature', 'explicit', 'unclassified', 'overridden_locked'],
    },
    telemetry: {
      type: 'object',
      properties: {
        circuit_breaker: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: ['closed', 'open', 'half-open'] },
            threshold: { type: 'integer' },
            cooldown_seconds: { type: 'integer' },
          },
          required: ['state', 'threshold', 'cooldown_seconds'],
        },
        outbound_limiter: {
          type: 'object',
          properties: {
            rate_per_second: { type: 'number' },
            burst: { type: 'integer' },
          },
          required: ['rate_per_second', 'burst'],
        },
        pending_work_authors_count: { type: 'integer' },
        dedupe_queue_pending_count: { type: 'integer' },
      },
      required: [
        'circuit_breaker',
        'outbound_limiter',
        'pending_work_authors_count',
        'dedupe_queue_pending_count',
      ],
    },
  },
  required: ['last_run', 'recent_runs', 'runs_summary', 'catalog', 'maturity_breakdown', 'telemetry'],
} as const;

// ---------------------------------------------------------------------------
// 9. Telemetry & Budgets (SL-80, SL-81, PRD §4.4, §28.1)
// ---------------------------------------------------------------------------

export const eventItemSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    session_id: { type: ['string', 'null'], format: 'uuid' },
    platform: { type: ['string', 'null'], maxLength: 50 },
    app_version: { type: ['string', 'null'], maxLength: 50 },
    properties: { type: 'object', additionalProperties: true },
    at: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['name'],
} as const;

export const postEventsBatchBodySchema = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: eventItemSchema,
      minItems: 1,
      maxItems: 100,
    },
  },
  required: ['events'],
} as const;

export const postEventsResponseSchema = {
  type: 'object',
  properties: {
    accepted: { type: 'integer' },
  },
  required: ['accepted'],
} as const;

export const budgetMetricsResponseSchema = {
  type: 'object',
  properties: {
    progress_updated: {
      type: 'object',
      properties: {
        p75_duration_ms: { type: ['number', 'null'] },
        budget_ms: { type: 'number' },
        sample_count: { type: 'integer' },
        passing: { type: 'boolean' },
      },
      required: ['p75_duration_ms', 'budget_ms', 'sample_count', 'passing'],
    },
    book_logged: {
      type: 'object',
      properties: {
        p75_tap_count: { type: ['number', 'null'] },
        budget_taps: { type: 'number' },
        sample_count: { type: 'integer' },
        passing: { type: 'boolean' },
      },
      required: ['p75_tap_count', 'budget_taps', 'sample_count', 'passing'],
    },
    finish_completed: {
      type: 'object',
      properties: {
        p75_duration_seconds: { type: ['number', 'null'] },
        budget_seconds: { type: 'number' },
        sample_count: { type: 'integer' },
        passing: { type: 'boolean' },
      },
      required: ['p75_duration_seconds', 'budget_seconds', 'sample_count', 'passing'],
    },
    log_sheet_completed: {
      type: 'object',
      properties: {
        p75_duration_ms: { type: ['number', 'null'] },
        budget_ms: { type: 'number' },
        sample_count: { type: 'integer' },
        passing: { type: 'boolean' },
      },
      required: ['p75_duration_ms', 'budget_ms', 'sample_count', 'passing'],
    },
    finish_flow_abandoned: {
      type: 'object',
      properties: {
        abandonment_rate: { type: 'number' },
        abandoned_count: { type: 'integer' },
        completed_count: { type: 'integer' },
        budget_max_rate: { type: 'number' },
        passing: { type: 'boolean' },
      },
      required: ['abandonment_rate', 'abandoned_count', 'completed_count', 'budget_max_rate', 'passing'],
    },
  },
  required: [
    'progress_updated',
    'book_logged',
    'finish_completed',
    'log_sheet_completed',
    'finish_flow_abandoned',
  ],
} as const;

// ---------------------------------------------------------------- shelves (SH-01, SH-02)

export const shelfPrivacyEnum = ['public', 'followers', 'private'] as const;

export const shelfOwnerSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    username: { type: 'string' },
    displayName: { type: ['string', 'null'] },
    avatarKey: { type: ['string', 'null'] },
  },
  required: ['id', 'username'],
} as const;

export const shelfSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    user_id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: ['string', 'null'] },
    is_ranked: { type: 'boolean' },
    privacy: { type: 'string', enum: shelfPrivacyEnum },
    cover_work_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
    },
    cover_ids: {
      type: 'array',
      items: { type: ['integer', 'null'] },
    },
    item_count: { type: 'integer' },
    save_count: { type: 'integer' },
    is_saved: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    owner: shelfOwnerSchema,
  },
  required: [
    'id',
    'user_id',
    'name',
    'slug',
    'is_ranked',
    'privacy',
    'cover_work_ids',
    'item_count',
    'save_count',
    'created_at',
    'owner',
  ],
} as const;

export const createShelfBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    is_ranked: { type: 'boolean' },
    privacy: { type: 'string', enum: shelfPrivacyEnum },
  },
  required: ['name'],
} as const;

export const updateShelfBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    is_ranked: { type: 'boolean' },
    privacy: { type: 'string', enum: shelfPrivacyEnum },
  },
} as const;

export const shelfResponseSchema = {
  type: 'object',
  properties: {
    shelf: shelfSchema,
  },
  required: ['shelf'],
} as const;

export const deleteShelfResponseSchema = {
  type: 'object',
  properties: {
    deleted: { type: 'boolean', enum: [true] },
    id: { type: 'string', format: 'uuid' },
  },
  required: ['deleted', 'id'],
} as const;

export const shelfItemWorkSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    author_name: { type: 'string' },
    cover_id: { type: ['integer', 'null'] },
    first_publish_year: { type: ['integer', 'null'] },
    log_count: { type: 'integer' },
    rating: { type: ['number', 'null'] },
    your_read: {
      type: ['object', 'null'],
      properties: {
        status: { type: 'string' },
        rating: { type: ['number', 'null'] },
        hearted: { type: 'boolean' },
      },
    },
  },
  required: ['id', 'title', 'author_name', 'cover_id', 'log_count'],
} as const;

export const shelfItemSchema = {
  type: 'object',
  properties: {
    shelf_id: { type: 'string', format: 'uuid' },
    work_id: { type: 'string', format: 'uuid' },
    position: { type: 'integer' },
    note: { type: ['string', 'null'] },
    added_at: { type: 'string', format: 'date-time' },
    work: shelfItemWorkSchema,
  },
  required: ['shelf_id', 'work_id', 'position', 'added_at', 'work'],
} as const;

export const shelfItemsResponseSchema = {
  type: 'object',
  properties: {
    data: {
      type: 'array',
      items: shelfItemSchema,
    },
    total: { type: 'integer' },
  },
  required: ['data', 'total'],
} as const;

export const addShelfItemBodySchema = {
  type: 'object',
  properties: {
    work_id: { type: 'string', format: 'uuid' },
    note: { type: ['string', 'null'], maxLength: 280 },
    position: { type: 'integer', minimum: 1 },
  },
  required: ['work_id'],
} as const;

export const shelfItemResponseSchema = {
  type: 'object',
  properties: {
    item: shelfItemSchema,
  },
  required: ['item'],
} as const;

export const shelfWithWorkStateSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    user_id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: ['string', 'null'] },
    is_ranked: { type: 'boolean' },
    privacy: { type: 'string', enum: shelfPrivacyEnum },
    cover_work_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
    },
    cover_ids: {
      type: 'array',
      items: { type: ['integer', 'null'] },
    },
    item_count: { type: 'integer' },
    save_count: { type: 'integer' },
    is_saved: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    owner: shelfOwnerSchema,
    contains_work: { type: 'boolean' },
    item_note: { type: ['string', 'null'] },
    position: { type: ['integer', 'null'] },
  },
  required: [
    'id',
    'user_id',
    'name',
    'slug',
    'is_ranked',
    'privacy',
    'cover_work_ids',
    'item_count',
    'save_count',
    'created_at',
    'owner',
    'contains_work',
  ],
} as const;

export const myShelvesQuerySchema = {
  type: 'object',
  properties: {
    work_id: { type: 'string', format: 'uuid' },
  },
} as const;

export const myShelvesResponseSchema = {
  type: 'object',
  properties: {
    shelves: {
      type: 'array',
      items: shelfWithWorkStateSchema,
    },
  },
  required: ['shelves'],
} as const;

export const shelfItemParamSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    workId: { type: 'string', format: 'uuid' },
  },
  required: ['id', 'workId'],
} as const;

export const deleteShelfItemResponseSchema = {
  type: 'object',
  properties: {
    deleted: { type: 'boolean', enum: [true] },
    shelf_id: { type: 'string', format: 'uuid' },
    work_id: { type: 'string', format: 'uuid' },
  },
  required: ['deleted', 'shelf_id', 'work_id'],
} as const;

export const updateShelfItemBodySchema = {
  type: 'object',
  properties: {
    note: { type: ['string', 'null'], maxLength: 280 },
    position: { type: 'integer', minimum: 1 },
  },
} as const;

export const reorderShelfBodySchema = {
  type: 'object',
  properties: {
    work_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      minItems: 1,
    },
  },
  required: ['work_ids'],
} as const;

export const reorderShelfResponseSchema = {
  type: 'object',
  properties: {
    reordered: { type: 'boolean', enum: [true] },
    shelf_id: { type: 'string', format: 'uuid' },
    count: { type: 'integer' },
  },
  required: ['reordered', 'shelf_id', 'count'],
} as const;

export const saveShelfResponseSchema = {
  type: 'object',
  properties: {
    saved: { type: 'boolean' },
    shelf_id: { type: 'string', format: 'uuid' },
    save_count: { type: 'integer', minimum: 0 },
  },
  required: ['saved', 'shelf_id', 'save_count'],
} as const;

export const savedShelvesResponseSchema = {
  type: 'object',
  properties: {
    shelves: {
      type: 'array',
      items: shelfSchema,
    },
  },
  required: ['shelves'],
} as const;

export const browseShelvesQuerySchema = {
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 100 },
    sort: { type: 'string', enum: ['ranked', 'popular', 'recent'], default: 'ranked' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const browseShelvesResponseSchema = {
  type: 'object',
  properties: {
    shelves: {
      type: 'array',
      items: shelfSchema,
    },
    total: { type: 'integer', minimum: 0 },
  },
  required: ['shelves', 'total'],
} as const;

export const userShelvesResponseSchema = {
  type: 'object',
  properties: {
    shelves: {
      type: 'array',
      items: shelfSchema,
    },
  },
  required: ['shelves'],
} as const;

export const shelfSlugParamsSchema = {
  type: 'object',
  properties: {
    username: { type: 'string' },
    slug: { type: 'string' },
  },
  required: ['username', 'slug'],
} as const;

// ---------------------------------------------------------------- imports (IM-02)

export const importSourceEnum = [
  'goodreads',
  'storygraph',
  'librarything',
  'calibre',
  'openlibrary',
  'openreads',
] as const;

export const importStateEnum = [
  'queued',
  'processing',
  'completed',
  'failed',
] as const;

export const importResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    job_id: { type: 'string', format: 'uuid' },
    source: {
      type: 'string',
      enum: importSourceEnum,
    },
    state: {
      type: 'string',
      enum: importStateEnum,
    },
    total_rows: { type: 'integer' },
    matched: { type: 'integer' },
    unmatched: { type: 'integer' },
    filename: { type: ['string', 'null'] },
    file_size_bytes: { type: ['integer', 'null'] },
    content_hash: { type: ['string', 'null'] },
    error: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    finished_at: { type: ['string', 'null'], format: 'date-time' },
  },
  required: [
    'id',
    'job_id',
    'source',
    'state',
    'total_rows',
    'matched',
    'unmatched',
    'created_at',
    'updated_at',
  ],
} as const;

export const importListResponseSchema = {
  type: 'object',
  properties: {
    imports: {
      type: 'array',
      items: importResponseSchema,
    },
  },
  required: ['imports'],
} as const;

export const uploadImportQuerySchema = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      enum: importSourceEnum,
      description: 'Source platform export format (can also be provided as a multipart form field)',
    },
    force: {
      type: 'boolean',
      description: 'If true, bypasses duplicate-import detection by content hash (IM-11)',
    },
  },
} as const;

export const importRowStateEnum = [
  'matched',
  'unmatched',
  'resolved',
  'skipped',
] as const;

export const importRowSchema = {
  type: 'object',
  properties: {
    import_id: { type: 'string', format: 'uuid' },
    row_no: { type: 'integer' },
    raw: { type: 'object', additionalProperties: true },
    state: {
      type: 'string',
      enum: importRowStateEnum,
    },
    work_id: { type: ['string', 'null'], format: 'uuid' },
    edition_id: { type: ['string', 'null'], format: 'uuid' },
    confidence: { type: ['number', 'null'] },
    failure_reason: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: ['import_id', 'row_no', 'raw', 'state', 'created_at'],
} as const;

export const importRowsResponseSchema = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: importRowSchema,
    },
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  },
  required: ['rows', 'total', 'limit', 'offset'],
} as const;

export const importRowsQuerySchema = {
  type: 'object',
  properties: {
    state: {
      type: 'string',
      enum: importRowStateEnum,
    },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const resolveImportRowBodySchema = {
  type: 'object',
  properties: {
    work_id: { type: 'string', format: 'uuid' },
    edition_id: { type: 'string', format: 'uuid' },
  },
  required: ['work_id'],
} as const;

export const importRowParamSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    rowNo: { type: 'integer' },
  },
  required: ['id', 'rowNo'],
} as const;

// ---------------------------------------------------------------- Exports (IM-10)

export const exportFormatEnum = ['csv', 'json'] as const;

export const exportStateEnum = [
  'queued',
  'processing',
  'completed',
  'failed',
] as const;

export const createExportBodySchema = {
  type: 'object',
  properties: {
    format: {
      type: 'string',
      enum: exportFormatEnum,
      default: 'csv',
      description:
        'Export format: csv for reading spreadsheets and re-importing, json for full data archive.',
    },
  },
} as const;

export const exportResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    user_id: { type: 'string', format: 'uuid' },
    format: {
      type: 'string',
      enum: exportFormatEnum,
    },
    state: {
      type: 'string',
      enum: exportStateEnum,
    },
    file_size_bytes: { type: ['integer', 'null'] },
    download_url: { type: ['string', 'null'] },
    expires_at: { type: ['string', 'null'], format: 'date-time' },
    error: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
    finished_at: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['id', 'user_id', 'format', 'state', 'created_at'],
} as const;

export const exportListResponseSchema = {
  type: 'object',
  properties: {
    exports: {
      type: 'array',
      items: exportResponseSchema,
    },
  },
  required: ['exports'],
} as const;

export const downloadExportQuerySchema = {
  type: 'object',
  properties: {
    token: {
      type: 'string',
      description: 'Single-use or time-limited download token sent via email',
    },
  },
} as const;

// ---------------------------------------------------------------- Social Graph & Follows (SO-01, SO-02)

export const followStateEnum = ['pending', 'accepted', 'none'] as const;
export const followStatusEnum = ['none', 'pending', 'accepted', 'self'] as const;

export const followResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: followStateEnum },
    follower_id: { type: 'string', format: 'uuid' },
    followee_id: { type: 'string', format: 'uuid' },
  },
  required: ['status', 'follower_id', 'followee_id'],
} as const;

export const pendingFollowRequestSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Requester user ID' },
    username: { type: 'string' },
    display_name: { type: ['string', 'null'] },
    avatar_key: { type: ['string', 'null'] },
    bio: { type: ['string', 'null'] },
    requested_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'username', 'requested_at'],
} as const;

export const pendingFollowRequestsResponseSchema = {
  type: 'object',
  properties: {
    requests: {
      type: 'array',
      items: pendingFollowRequestSchema,
    },
  },
  required: ['requests'],
} as const;

// ---------------------------------------------------------------- Blocking (SO-03)

export const blockStateEnum = ['blocked', 'unblocked'] as const;

export const blockUserResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: blockStateEnum },
    blocker_id: { type: 'string', format: 'uuid' },
    blocked_id: { type: 'string', format: 'uuid' },
  },
  required: ['status', 'blocker_id', 'blocked_id'],
} as const;

export const blockedUserSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Blocked user ID' },
    username: { type: 'string' },
    display_name: { type: ['string', 'null'] },
    avatar_key: { type: ['string', 'null'] },
    blocked_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'username', 'blocked_at'],
} as const;

export const blockedUsersResponseSchema = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: blockedUserSchema,
    },
  },
  required: ['blocks'],
} as const;

// ---------------------------------------------------------------- Muting (SO-04)

export const muteStateEnum = ['muted', 'unmuted'] as const;
export const muteTargetTypeEnum = ['user', 'work'] as const;

export const muteResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: muteStateEnum },
    target_type: { type: 'string', enum: muteTargetTypeEnum },
    target_id: { type: 'string', format: 'uuid' },
    user_id: { type: 'string', format: 'uuid' },
  },
  required: ['status', 'target_type', 'target_id', 'user_id'],
} as const;

export const mutedUserSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Muted user ID' },
    username: { type: 'string' },
    display_name: { type: ['string', 'null'] },
    avatar_key: { type: ['string', 'null'] },
    muted_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'username', 'muted_at'],
} as const;

export const mutedWorkSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Muted work ID' },
    title: { type: 'string' },
    author_name: { type: ['string', 'null'] },
    cover_id: { type: ['integer', 'null'] },
    muted_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'title', 'muted_at'],
} as const;

export const mutesResponseSchema = {
  type: 'object',
  properties: {
    users: {
      type: 'array',
      items: mutedUserSchema,
    },
    works: {
      type: 'array',
      items: mutedWorkSchema,
    },
  },
  required: ['users', 'works'],
} as const;




