// Typed Flyleaf API Client (FN-81, Architecture §6).

import type {
  Admin2faSetupResponse,
  Admin2faVerifyRequest,
  Admin2faVerifyResponse,
  AdminAuditLogItem,
  AdminAuditLogQuery,
  AdminAuditLogResponse,
  AdminCatalogWorkDetail,
  AdminCatalogWorkResponse,
  AdminCatalogWorkSummary,
  AdminCatalogWorksListResponse,
  AdminCatalogWorksQuery,
  AdminIngestStatusResponse,
  AdminLoginRequest,
  AdminLoginResponse,
  AdminMaturityOverrideRequest,
  AdminMaturityOverrideResponse,
  AdminMeResponse,
  AdminViewer,
  ApiErrorResponse,
  AuthResponse,
  BudgetMetricsResponse,
  CreateReviewRequest,
  DedupePreviewResponse,
  DedupeQueueItem,
  DedupeQueueListResponse,
  DedupeReportRequest,
  DedupeReportResponse,
  DedupeResolveRequest,
  DedupeResolveResponse,
  DnfReadRequest,
  DeleteReadResponse,
  AuthorDetail,
  SeriesDetail,
  EditionLookupResponse,
  FinishReadRequest,
  FollowResult,
  BlockResult,
  BlockedUsersResponse,
  MuteResult,
  MutesResponse,
  ForgotPasswordRequest,
  LoginRequest,
  MergeListItem,
  MergeListResponse,
  PendingFollowRequestsResponse,
  FollowUserListResponse,
  FollowSuggestionsResponse,
  PostEventsResponse,
  Profile,
  ProgressEventRequest,
  Read,
  ReadingStats,
  GoalResponse,
  ShareCard,
  ShareCardImage,
  YearInReview,
  MilestonesResponse,
  ReadListResponse,
  UserReadPage,
  ContentSettingsRequest,
  AvatarResponse,
  ReadStatus,
  RefreshRequest,
  RefreshResponse,
  RegisterRequest,
  ResetPasswordRequest,
  Review,
  SearchResponse,
  Session,
  SessionListResponse,
  StandardResponse,
  TelemetryEvent,
  LikeResponse,
  ReadLikersResponse,
  ReadComment,
  ReadCommentsResponse,
  FeedResponse,
  UndoMergeResponse,
  UpdateProfileRequest,
  UpdateReviewRequest,
  UpsertReadRequest,
  User,
  VerifyEmailRequest,
  UsernameAvailability,
  Shelf,
  ShelfResponse,
  CreateShelfRequest,
  UpdateShelfRequest,
  DeleteShelfResponse,
  ShelfItemsResponse,
  AddShelfItemRequest,
  ShelfItemResponse,
  MyShelvesResponse,
  DeleteShelfItemResponse,
  UpdateShelfItemRequest,
  ReorderShelfRequest,
  ReorderShelfResponse,
  SaveShelfResponse,
  SavedShelvesResponse,
  DeletedShelvesResponse,
  BrowseShelvesQuery,
  BrowseShelvesResponse,
  UserShelvesResponse,
  Work,
  WorkReviewsQuery,
  WorkReviewsResponse,
  ImportSource,
  ImportResponse,
  ImportListResponse,
  CreateImportRequest,
  CreateUploadRequest,
  UploadBody,
  UploadFileOptions,
  UploadPurpose,
  UploadResponse,
  UploadTarget,
  ImportRowState,
  ImportRowItem,
  ImportRowsResponse,
  ResolveImportRowRequest,
  ExportFormat,
  ExportResponse,
  ExportListResponse,
  ExportLinkResponse,
  CreateExportRequest,
  NotificationsResponse,
  UnreadCountResponse,
  NotificationPreferences,
  UpdateNotificationPreferencesRequest,
  RegisterPushTokenRequest,
  CreateReportRequest,
  ReportResponse,
  MyReportsResponse,
  ModerationNotice,
  ModerationNoticesResponse,
  ReportSubjectType,
  AdminReportQueueResponse,
  AdminReportCaseDetail,
  AdminReportActionRequest,
  AdminModerationAction,
  AdminAppealsResponse,
} from './types.js';

/** ?year=&tz= for the stats routes, only what is given. */
function statsQuery(year?: number | string, tz?: string): string {
  const q = new URLSearchParams();
  if (year !== undefined) q.set('year', String(year));
  if (tz) q.set('tz', tz);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export class FlyleafApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public field?: string,
    public status?: number,
    /** From `Retry-After` on a 429: how long the server asks the client to wait (Audit 15). */
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'FlyleafApiError';
  }
}

export interface ClientConfig {
  baseUrl: string;
  getToken?: () => Promise<string | null> | string | null;
  fetch?: typeof fetch;
  /**
   * For the direct upload to object storage (PV-03). Never `fetch` above:
   * an app's API fetch may add the bearer token (a 401 retry does), and the
   * token must not reach a storage host. Defaults to the global fetch.
   */
  uploadFetch?: typeof fetch;
}

/** Statuses worth retrying the direct upload for; anything else will not change. */
const RETRYABLE_UPLOAD_STATUS = (status: number) => status === 408 || status === 429 || status >= 500;

function byteLength(body: UploadBody): number {
  if (typeof body === 'string') return new TextEncoder().encode(body).length;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  return body.size;
}

export class FlyleafClient {
  private baseUrl: string;
  private getToken?: () => Promise<string | null> | string | null;
  private fetchFn: typeof fetch;
  private uploadFetchFn?: typeof fetch;
  /** Uploads in progress, so cancelPendingUploads() can stop them (logout). */
  private inflightUploads = new Set<AbortController>();

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.getToken = config.getToken;
    this.fetchFn = config.fetch ?? fetch;
    this.uploadFetchFn = config.uploadFetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.getToken ? await this.getToken() : null;
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
    const headers: Record<string, string> = {
      ...(init.body !== undefined && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };

    const res = await this.fetchFn(url, {
      ...init,
      headers,
    });

    const text = await res.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!res.ok) {
      const err = (body as ApiErrorResponse | null)?.error;
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      throw new FlyleafApiError(
        err?.code ?? 'unknown_error',
        err?.message ?? `Request failed with status ${res.status}`,
        err?.field,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }

    return body as T;
  }

  // ---------------------------------------------------------------- Auth

  async register(data: RegisterRequest): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async login(data: LoginRequest): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async refresh(data: RefreshRequest): Promise<RefreshResponse> {
    return this.request<RefreshResponse>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async logout(data: RefreshRequest): Promise<{ status: string }> {
    return this.request<{ status: string }>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async verifyEmail(data: VerifyEmailRequest): Promise<StandardResponse> {
    return this.request<StandardResponse>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async checkUsername(username: string, init?: { signal?: AbortSignal }): Promise<UsernameAvailability> {
    return this.request<UsernameAvailability>(`/auth/username-available?username=${encodeURIComponent(username)}`, {
      method: 'GET',
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  }

  async resendVerification(): Promise<StandardResponse> {
    return this.request<StandardResponse>('/auth/resend-verification', {
      method: 'POST',
    });
  }

  async forgotPassword(data: ForgotPasswordRequest): Promise<StandardResponse> {
    return this.request<StandardResponse>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async resetPassword(data: ResetPasswordRequest): Promise<StandardResponse> {
    return this.request<StandardResponse>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getSessions(): Promise<Session[]> {
    const res = await this.request<SessionListResponse>('/auth/sessions', {
      method: 'GET',
    });
    return res.data;
  }

  async revokeSession(sessionId: string): Promise<StandardResponse> {
    return this.request<StandardResponse>(`/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  async logoutAll(): Promise<StandardResponse> {
    return this.request<StandardResponse>('/auth/logout-all', {
      method: 'POST',
    });
  }

  async getMe(): Promise<User> {
    return this.request<User>('/me', {
      method: 'GET',
    });
  }

  /** Once, while GET /me says dobConfirmed false. Same rules as signup; 409 dob_already_confirmed after. */
  async confirmDateOfBirth(dateOfBirth: string): Promise<User> {
    return this.request<User>('/me/date-of-birth', {
      method: 'POST',
      body: JSON.stringify({ dateOfBirth }),
    });
  }

  /** PRD §7.8: turning it on needs the account's date of birth (422 dob_required / dob_mismatch); 403 setting_unavailable under 18. */
  async setContentSettings(data: ContentSettingsRequest): Promise<User> {
    return this.request<User>('/me/content-settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** Consumes a completed upload with purpose 'avatar' (uploadFile). */
  async setAvatar(uploadId: string): Promise<AvatarResponse> {
    return this.request<AvatarResponse>('/me/avatar', {
      method: 'PUT',
      body: JSON.stringify({ upload_id: uploadId }),
    });
  }

  async removeAvatar(): Promise<AvatarResponse> {
    return this.request<AvatarResponse>('/me/avatar', { method: 'DELETE' });
  }

  async getUserProfile(userId: string): Promise<Profile> {
    return this.request<Profile>(`/users/${encodeURIComponent(userId)}`, {
      method: 'GET',
    });
  }

  /** The profile behind a username, current or former (App Links for /@username). 404 like a random id. */
  async getUserByUsername(username: string): Promise<Profile> {
    return this.request<Profile>(`/users/by-username/${encodeURIComponent(username)}`, {
      method: 'GET',
    });
  }

  async getMyProfile(): Promise<Profile> {
    return this.request<Profile>('/me/profile', {
      method: 'GET',
    });
  }

  async updateProfile(data: UpdateProfileRequest): Promise<Profile> {
    return this.request<Profile>('/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  /**
   * Changes the viewer's username (D-11-2). The old name stays reserved to
   * this account and its share links redirect. 409 `username_taken`.
   */
  async changeUsername(username: string): Promise<Profile> {
    return this.request<Profile>('/me/username', {
      method: 'PATCH',
      body: JSON.stringify({ username }),
    });
  }

  // ---------------------------------------------------------------- Catalog

  /**
   * `sessionId`: a guest app's telemetry session id, sent as
   * `x-flyleaf-session` so a search with no results counts its searcher in
   * the weekly zero-result summary (D-10-3). Never stored as sent.
   */
  async search(q: string, limit = 20, sessionId?: string): Promise<Work[]> {
    return (await this.searchWithSuggestion(q, limit, sessionId)).data;
  }

  /** search() plus the "Did you mean …?" suggestion when nothing was found (PRD §14.7). */
  async searchWithSuggestion(q: string, limit = 20, sessionId?: string): Promise<SearchResponse> {
    const query = new URLSearchParams({ q, limit: String(limit) });
    return this.request<SearchResponse>(`/search?${query.toString()}`, {
      method: 'GET',
      ...(sessionId ? { headers: { 'x-flyleaf-session': sessionId } } : {}),
    });
  }

  async getWork(id: string): Promise<Work> {
    return this.request<Work>(`/works/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  async getEditionByIsbn(isbn: string): Promise<EditionLookupResponse> {
    return this.request<EditionLookupResponse>(`/editions/isbn/${encodeURIComponent(isbn)}`, {
      method: 'GET',
    });
  }

  // ---------------------------------------------------------------- Reading

  async getReads(status?: ReadStatus): Promise<Read[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await this.request<ReadListResponse>(`/reads${query}`, {
      method: 'GET',
    });
    return res.data;
  }

  async getRead(id: string): Promise<Read> {
    return this.request<Read>(`/reads/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  /** One page of another user's reads they let the viewer see, newest update first. Pass next_cursor back as cursor. */
  async getUserReads(
    userId: string,
    opts: { status?: ReadStatus; cursor?: string; limit?: number } = {},
  ): Promise<UserReadPage> {
    const query = new URLSearchParams();
    if (opts.status) query.set('status', opts.status);
    if (opts.cursor) query.set('cursor', opts.cursor);
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    const qs = query.toString();
    return this.request<UserReadPage>(`/users/${encodeURIComponent(userId)}/reads${qs ? `?${qs}` : ''}`, {
      method: 'GET',
    });
  }

  async createRead(data: UpsertReadRequest): Promise<Read> {
    return this.request<Read>('/reads', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async addProgress(readId: string, data: ProgressEventRequest): Promise<Read> {
    return this.request<Read>(`/reads/${encodeURIComponent(readId)}/progress`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async finishRead(readId: string, data: FinishReadRequest): Promise<Read> {
    return this.request<Read>(`/reads/${encodeURIComponent(readId)}/finish`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async dnfRead(readId: string, data: DnfReadRequest): Promise<Read> {
    return this.request<Read>(`/reads/${encodeURIComponent(readId)}/dnf`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /** An author and their works, most logged first (SL-43). */
  async getAuthor(id: string, params?: { limit?: number; offset?: number }): Promise<AuthorDetail> {
    const q = new URLSearchParams();
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    if (params?.offset !== undefined) q.set('offset', String(params.offset));
    const qs = q.toString();
    return this.request<AuthorDetail>(`/authors/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`);
  }

  /** A series in reading order with the viewer's status on each entry (SL-43). */
  async getSeries(id: string): Promise<SeriesDetail> {
    return this.request<SeriesDetail>(`/series/${encodeURIComponent(id)}`);
  }

  /** Deletes a read with its progress, review, likes, comments and activity (PRD §34.2). 404 if already gone. */
  async deleteRead(readId: string): Promise<DeleteReadResponse> {
    return this.request<DeleteReadResponse>(`/reads/${encodeURIComponent(readId)}`, { method: 'DELETE' });
  }

  /** ST-05: the viewer's goal for a year (default this year in tz). goal is null when none is set. */
  async getMyGoal(year?: number | string, tz?: string): Promise<GoalResponse> {
    return this.request<GoalResponse>(`/me/goal${statsQuery(year, tz)}`, { method: 'GET' });
  }

  /** A user's goal as this viewer may count it (§17.5); 404 where their stats are hidden. */
  async getUserGoal(userId: string, year?: number | string, tz?: string): Promise<GoalResponse> {
    return this.request<GoalResponse>(`/users/${encodeURIComponent(userId)}/goal${statsQuery(year, tz)}`, { method: 'GET' });
  }

  /** Set or change the goal: any time, downward included (§8.6). 422 invalid_goal outside 1–10,000 books / 1–10,000,000 pages. */
  async setMyGoal(goal: { year: number; target_books: number; target_pages?: number | null }, tz?: string): Promise<GoalResponse> {
    return this.request<GoalResponse>(`/me/goal${statsQuery(undefined, tz)}`, { method: 'PUT', body: JSON.stringify(goal) });
  }

  async deleteMyGoal(year: number): Promise<GoalResponse> {
    return this.request<GoalResponse>(`/me/goal?year=${encodeURIComponent(String(year))}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------- Share cards (ST-07, ST-08)

  /**
   * The path of a share card under the API base (GET, image/png). For
   * clients that download it to a file themselves; send the bearer token.
   */
  shareCardPath(card: ShareCard): string {
    const q = (params: Record<string, string | number | undefined>) => {
      const parts = Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
      return parts.length ? `?${parts.join('&')}` : '';
    };
    const id = encodeURIComponent;
    switch (card.template) {
      case 'finish': return `/cards/finish/${id(card.readId)}`;
      case 'review': return `/cards/review/${id(card.reviewId)}`;
      case 'stat': return `/cards/users/${id(card.userId)}/stat/${id(card.stat)}${q({ year: card.year, tz: card.tz })}`;
      case 'profile': return `/cards/users/${id(card.userId)}/profile${q({ tz: card.tz })}`;
      case 'wall': return `/cards/users/${id(card.userId)}/wall${q({ layout: card.layout, year: card.year })}`;
      case 'year': return `/cards/users/${id(card.userId)}/year/${id(String(card.year))}/${id(card.card)}${q({ tz: card.tz })}`;
    }
  }

  /** A share card's PNG (1080 × 1920), rendered server-side. Errors as every other call (404, 422 nothing_to_share, 429). */
  async getShareCard(card: ShareCard): Promise<ShareCardImage> {
    const token = this.getToken ? await this.getToken() : null;
    const res = await this.fetchFn(`${this.baseUrl}${this.shareCardPath(card)}`, {
      method: 'GET',
      headers: { Accept: 'image/png', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) {
      let body: any = null;
      try { body = JSON.parse(await res.text()); } catch { body = null; }
      const err = (body as ApiErrorResponse | null)?.error;
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      throw new FlyleafApiError(
        err?.code ?? 'unknown_error',
        err?.message ?? `Request failed with status ${res.status}`,
        err?.field,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return { png: await res.arrayBuffer(), etag: res.headers?.get?.('etag') ?? null };
  }

  // ---------------------------------------------------------------- Year in Review (ST-09), milestones (ST-10)

  /** The reader's own Year in Review. Year absent: the latest open one in tz. Locked before 1 December (unlocked: false). */
  async getYearInReview(year?: number | string, tz?: string): Promise<YearInReview> {
    return this.request<YearInReview>(`/me/year-in-review${statsQuery(year, tz)}`, { method: 'GET' });
  }

  /** Milestone moments not shown yet; with readId, whether that finish is the longest book yet. */
  async getMilestones(readId?: string): Promise<MilestonesResponse> {
    return this.request<MilestonesResponse>(`/me/milestones${readId ? `?read_id=${encodeURIComponent(readId)}` : ''}`, { method: 'GET' });
  }

  /** The app showed these moments. */
  async markMilestonesSeen(keys: string[]): Promise<void> {
    await this.request<null>('/me/milestones/seen', { method: 'POST', body: JSON.stringify({ keys }) });
  }

  /** `tz`: the IANA zone whose days count for streaks and the default year (PRD §8.7). Default UTC. */
  async getMyStats(year?: number | string, tz?: string): Promise<ReadingStats> {
    return this.request<ReadingStats>(`/me/stats${statsQuery(year, tz)}`, {
      method: 'GET',
    });
  }

  async getUserStats(userId: string, year?: number | string, tz?: string): Promise<ReadingStats> {
    return this.request<ReadingStats>(`/users/${encodeURIComponent(userId)}/stats${statsQuery(year, tz)}`, {
      method: 'GET',
    });
  }

  // ---------------------------------------------------------------- Reviews & Social (SL-63, SL-64)

  async createReview(readId: string, data: CreateReviewRequest): Promise<Review> {
    return this.request<Review>(`/reads/${encodeURIComponent(readId)}/review`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getReview(id: string): Promise<Review> {
    return this.request<Review>(`/reviews/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  async updateReview(id: string, data: UpdateReviewRequest): Promise<Review> {
    return this.request<Review>(`/reviews/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteReview(id: string): Promise<void> {
    await this.request<void>(`/reviews/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async getWorkReviews(workId: string, query?: WorkReviewsQuery): Promise<WorkReviewsResponse> {
    const q = new URLSearchParams();
    if (query?.sort) q.set('sort', query.sort);
    if (query?.rating != null) q.set('rating', String(query.rating));
    if (query?.limit != null) q.set('limit', String(query.limit));
    if (query?.offset != null) q.set('offset', String(query.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<WorkReviewsResponse>(`/works/${encodeURIComponent(workId)}/reviews${qs}`, {
      method: 'GET',
    });
  }

  // ---------------------------------------------------------------- Read interactions (SO-2x)
  // Likes and comments target the READ, so a finish with no review is likeable.

  /** Idempotent: liking twice is one like, so an offline replay is safe. */
  async likeRead(readId: string): Promise<LikeResponse> {
    return this.request<LikeResponse>(`/reads/${encodeURIComponent(readId)}/like`, { method: 'POST' });
  }

  /** Idempotent. */
  async unlikeRead(readId: string): Promise<LikeResponse> {
    return this.request<LikeResponse>(`/reads/${encodeURIComponent(readId)}/like`, { method: 'DELETE' });
  }

  /**
   * Set the like state explicitly. Callers pass the state they WANT, never
   * "flip whatever it is now" — a flip is not safe to retry.
   */
  async setLiked(readId: string, liked: boolean): Promise<LikeResponse> {
    return liked ? this.likeRead(readId) : this.unlikeRead(readId);
  }

  async getReadLikes(readId: string, params?: { limit?: number; offset?: number }): Promise<ReadLikersResponse> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<ReadLikersResponse>(`/reads/${encodeURIComponent(readId)}/likes${qs}`, { method: 'GET' });
  }

  async getReadComments(readId: string, params?: { cursor?: string; limit?: number }): Promise<ReadCommentsResponse> {
    const q = new URLSearchParams();
    if (params?.cursor) q.set('cursor', params.cursor);
    if (params?.limit != null) q.set('limit', String(params.limit));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<ReadCommentsResponse>(`/reads/${encodeURIComponent(readId)}/comments${qs}`, {
      method: 'GET',
    });
  }

  /** 429 `rate_limited` after 5 in a minute; 409 `thread_locked` if the review was deleted. */
  async addReadComment(readId: string, body: string): Promise<ReadComment> {
    return this.request<ReadComment>(`/reads/${encodeURIComponent(readId)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.request<void>(`/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
  }

  async getFeed(params?: { tab?: 'friends' | 'popular'; cursor?: string; limit?: number }): Promise<FeedResponse> {
    const q = new URLSearchParams();
    if (params?.tab) q.set('tab', params.tab);
    if (params?.cursor) q.set('cursor', params.cursor);
    if (params?.limit != null) q.set('limit', String(params.limit));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<FeedResponse>(`/feed${qs}`, { method: 'GET' });
  }

  // ---------------------------------------------------------------- Admin Dedupe

  async getDedupeQueue(params?: {
    status?: 'pending' | 'merged' | 'dismissed';
    stage?: number;
    limit?: number;
    offset?: number;
  }): Promise<DedupeQueueItem[]> {
    const q = new URLSearchParams();
    if (params?.status) q.set('status', params.status);
    if (params?.stage != null) q.set('stage', String(params.stage));
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    const res = await this.request<DedupeQueueListResponse>(`/admin/dedupe/queue${qs}`, {
      method: 'GET',
    });
    return res.data;
  }

  async previewMerge(survivorId: string, loserId: string): Promise<DedupePreviewResponse> {
    return this.request<DedupePreviewResponse>(
      `/admin/dedupe/preview/${encodeURIComponent(survivorId)}/${encodeURIComponent(loserId)}`,
      { method: 'GET' },
    );
  }

  async resolveDedupeQueueItem(
    id: string,
    data: DedupeResolveRequest,
  ): Promise<DedupeResolveResponse> {
    return this.request<DedupeResolveResponse>(
      `/admin/dedupe/queue/${encodeURIComponent(id)}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    );
  }

  async reportDuplicate(data: DedupeReportRequest): Promise<DedupeReportResponse> {
    return this.request<DedupeReportResponse>('/admin/dedupe/report', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getRecentMerges(params?: { limit?: number; offset?: number }): Promise<MergeListItem[]> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    const res = await this.request<MergeListResponse>(`/admin/merges${qs}`, {
      method: 'GET',
    });
    return res.data;
  }

  /** `reason` (at least 10 characters) is stored in the admin audit log (D-06-1). */
  async undoMerge(mergeId: string, reason: string): Promise<UndoMergeResponse> {
    return this.request<UndoMergeResponse>(`/admin/merges/${encodeURIComponent(mergeId)}/undo`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  // ---------------------------------------------------------------- Admin Auth & Audit (FN-90, FN-93)

  async adminLogin(data: AdminLoginRequest): Promise<AdminLoginResponse> {
    return this.request<AdminLoginResponse>('/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async adminGetMe(): Promise<AdminViewer> {
    const res = await this.request<AdminMeResponse>('/admin/auth/me', {
      method: 'GET',
    });
    return res.admin;
  }

  async adminSetup2fa(): Promise<Admin2faSetupResponse> {
    return this.request<Admin2faSetupResponse>('/admin/auth/2fa/setup', {
      method: 'POST',
    });
  }

  async adminVerify2fa(data: Admin2faVerifyRequest): Promise<Admin2faVerifyResponse> {
    return this.request<Admin2faVerifyResponse>('/admin/auth/2fa/verify', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getAdminAuditLog(query?: AdminAuditLogQuery): Promise<AdminAuditLogItem[]> {
    const q = new URLSearchParams();
    if (query?.action) q.set('action', query.action);
    if (query?.actor_id) q.set('actor_id', query.actor_id);
    if (query?.subject_type) q.set('subject_type', query.subject_type);
    if (query?.limit != null) q.set('limit', String(query.limit));
    if (query?.offset != null) q.set('offset', String(query.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    const res = await this.request<AdminAuditLogResponse>(`/admin/audit-log${qs}`, {
      method: 'GET',
    });
    return res.data;
  }

  // ---------------------------------------------------------------- Admin Catalog & Ingest (FN-92)

  async adminGetCatalogWorks(
    params?: AdminCatalogWorksQuery,
  ): Promise<AdminCatalogWorksListResponse> {
    const q = new URLSearchParams();
    if (params?.maturity) q.set('maturity', params.maturity);
    if (params?.q) q.set('q', params.q);
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<AdminCatalogWorksListResponse>(`/admin/catalog/works${qs}`, {
      method: 'GET',
    });
  }

  async adminGetCatalogWork(workId: string): Promise<AdminCatalogWorkDetail> {
    const res = await this.request<AdminCatalogWorkResponse>(
      `/admin/catalog/works/${encodeURIComponent(workId)}`,
      { method: 'GET' },
    );
    return res.work;
  }

  async adminOverrideMaturity(
    workId: string,
    data: AdminMaturityOverrideRequest,
  ): Promise<AdminMaturityOverrideResponse> {
    return this.request<AdminMaturityOverrideResponse>(
      `/admin/catalog/works/${encodeURIComponent(workId)}/maturity`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    );
  }

  async adminGetIngestStatus(): Promise<AdminIngestStatusResponse> {
    return this.request<AdminIngestStatusResponse>('/admin/ingest/status', {
      method: 'GET',
    });
  }

  // ---------------------------------------------------------------- Telemetry (SL-80, SL-81)

  async postEvents(events: TelemetryEvent[]): Promise<PostEventsResponse> {
    return this.request<PostEventsResponse>('/events', {
      method: 'POST',
      body: JSON.stringify({ events }),
    });
  }

  async getBudgetMetrics(): Promise<BudgetMetricsResponse> {
    return this.request<BudgetMetricsResponse>('/admin/telemetry/budgets', {
      method: 'GET',
    });
  }

  // ---------------------------------------------------------------- Shelves (SH-01, SH-02)

  async createShelf(data: CreateShelfRequest): Promise<ShelfResponse> {
    return this.request<ShelfResponse>('/shelves', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getShelf(id: string): Promise<ShelfResponse> {
    return this.request<ShelfResponse>(`/shelves/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  async updateShelf(id: string, data: UpdateShelfRequest): Promise<ShelfResponse> {
    return this.request<ShelfResponse>(`/shelves/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteShelf(id: string): Promise<DeleteShelfResponse> {
    return this.request<DeleteShelfResponse>(`/shelves/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async getShelfItems(
    id: string,
    params?: { limit?: number; offset?: number },
  ): Promise<ShelfItemsResponse> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<ShelfItemsResponse>(`/shelves/${encodeURIComponent(id)}/items${qs}`, {
      method: 'GET',
    });
  }

  async addShelfItem(id: string, data: AddShelfItemRequest): Promise<ShelfItemResponse> {
    return this.request<ShelfItemResponse>(`/shelves/${encodeURIComponent(id)}/items`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getMyShelves(params?: { work_id?: string }): Promise<MyShelvesResponse> {
    const q = new URLSearchParams();
    if (params?.work_id) q.set('work_id', params.work_id);
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<MyShelvesResponse>(`/shelves/mine${qs}`, {
      method: 'GET',
    });
  }

  async removeShelfItem(shelfId: string, workId: string): Promise<DeleteShelfItemResponse> {
    return this.request<DeleteShelfItemResponse>(
      `/shelves/${encodeURIComponent(shelfId)}/items/${encodeURIComponent(workId)}`,
      {
        method: 'DELETE',
      },
    );
  }

  async updateShelfItem(
    shelfId: string,
    workId: string,
    data: UpdateShelfItemRequest,
  ): Promise<ShelfItemResponse> {
    return this.request<ShelfItemResponse>(
      `/shelves/${encodeURIComponent(shelfId)}/items/${encodeURIComponent(workId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      },
    );
  }

  async reorderShelf(id: string, data: ReorderShelfRequest): Promise<ReorderShelfResponse> {
    return this.request<ReorderShelfResponse>(`/shelves/${encodeURIComponent(id)}/order`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async saveShelf(id: string): Promise<SaveShelfResponse> {
    return this.request<SaveShelfResponse>(`/shelves/${encodeURIComponent(id)}/save`, {
      method: 'POST',
    });
  }

  async unsaveShelf(id: string): Promise<SaveShelfResponse> {
    return this.request<SaveShelfResponse>(`/shelves/${encodeURIComponent(id)}/save`, {
      method: 'DELETE',
    });
  }

  async getSavedShelves(params?: { limit?: number; offset?: number }): Promise<SavedShelvesResponse> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<SavedShelvesResponse>(`/shelves/saved${qs}`, {
      method: 'GET',
    });
  }

  /** The viewer's shelves deleted in the last 30 days (restorable). */
  async getDeletedShelves(): Promise<DeletedShelvesResponse> {
    return this.request<DeletedShelvesResponse>('/shelves/deleted', { method: 'GET' });
  }

  async restoreShelf(id: string): Promise<ShelfResponse> {
    return this.request<ShelfResponse>(`/shelves/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  }

  async browseShelves(params?: BrowseShelvesQuery): Promise<BrowseShelvesResponse> {
    const q = new URLSearchParams();
    if (params?.query) q.set('query', params.query);
    if (params?.sort) q.set('sort', params.sort);
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<BrowseShelvesResponse>(`/shelves/browse${qs}`, {
      method: 'GET',
    });
  }

  async getUserShelves(userId: string): Promise<UserShelvesResponse> {
    return this.request<UserShelvesResponse>(`/users/${encodeURIComponent(userId)}/shelves`, {
      method: 'GET',
    });
  }

  /** Follows a 301 to the current address when the shelf or its owner was renamed (D-11-2). */
  async getShelfBySlug(username: string, slug: string): Promise<ShelfResponse> {
    return this.request<ShelfResponse>(
      `/users/${encodeURIComponent(username)}/shelves/slug/${encodeURIComponent(slug)}`,
      {
        method: 'GET',
      },
    );
  }

  // ---------------------------------------------------------------- Uploads (PV-02, PV-03)

  async createUpload(data: CreateUploadRequest): Promise<UploadResponse> {
    return this.request<UploadResponse>('/uploads', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async completeUpload(id: string): Promise<UploadResponse> {
    return this.request<UploadResponse>(`/uploads/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
    });
  }

  /**
   * Intent -> direct upload to storage -> complete. Only the direct upload is
   * retried: retrying the intent or complete here would hide an error the
   * caller must see (413, 415, 422). Resolves with the completed upload; its
   * id goes to a consumer (createImport).
   */
  async uploadFile(purpose: UploadPurpose, file: UploadBody, options: UploadFileOptions): Promise<UploadResponse> {
    const controller = new AbortController();
    this.inflightUploads.add(controller);
    const cancelled = () => new FlyleafApiError('upload_cancelled', 'The upload was cancelled.');
    try {
      const size = byteLength(file);
      const intent = await this.createUpload({
        purpose,
        content_type: options.contentType,
        size,
        ...(options.filename ? { filename: options.filename } : {}),
      });
      if (!intent.target) throw new FlyleafApiError('upload_target_missing', 'The server returned no upload target.');

      const attempts = Math.max(1, options.attempts ?? 3);
      for (let attempt = 1; ; attempt++) {
        if (controller.signal.aborted) throw cancelled();
        let status: number;
        try {
          status = await this.sendToTarget(intent.target, file, size, options.onProgress, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) throw cancelled();
          if (attempt >= attempts) throw err;
          await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
          continue;
        }
        if (status >= 200 && status < 300) break;
        if (!RETRYABLE_UPLOAD_STATUS(status) || attempt >= attempts) {
          throw new FlyleafApiError('upload_failed', `Storage refused the upload (status ${status}).`, undefined, status);
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }

      if (controller.signal.aborted) throw cancelled();
      return await this.completeUpload(intent.id);
    } finally {
      this.inflightUploads.delete(controller);
    }
  }

  /** Stop every upload in progress. Call on logout: the next user must not finish them. */
  cancelPendingUploads(): void {
    for (const controller of this.inflightUploads) controller.abort();
    this.inflightUploads.clear();
  }

  /** One attempt. Resolves with the HTTP status; rejects on a network error. */
  private async sendToTarget(
    target: UploadTarget,
    file: UploadBody,
    size: number,
    onProgress: UploadFileOptions['onProgress'],
    signal: AbortSignal,
  ): Promise<number> {
    let body: UploadBody | FormData = file;
    if (target.method === 'POST') {
      const form = new FormData();
      for (const [k, v] of Object.entries(target.fields ?? {})) form.append(k, v);
      form.append('file', file instanceof Blob ? file : new Blob([file as BlobPart]));
      body = form;
    }

    if (onProgress && typeof XMLHttpRequest !== 'undefined') {
      return new Promise<number>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(target.method, target.url);
        if (target.method === 'PUT') {
          for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
        }
        xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : size);
        xhr.onload = () => resolve(xhr.status);
        xhr.onerror = () => reject(new FlyleafApiError('network_error', 'The upload could not reach storage.'));
        xhr.onabort = () => reject(new FlyleafApiError('upload_cancelled', 'The upload was cancelled.'));
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.send(body as XMLHttpRequestBodyInit);
      });
    }

    const res = await (this.uploadFetchFn ?? fetch)(target.url, {
      method: target.method,
      headers: target.method === 'PUT' ? target.headers : undefined,
      body: body as BodyInit,
      signal,
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) onProgress?.(size, size);
    return res.status;
  }

  // ---------------------------------------------------------------- Imports (IM-02)

  async createImport(data: CreateImportRequest): Promise<ImportResponse> {
    return this.request<ImportResponse>('/imports', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getImport(id: string): Promise<ImportResponse> {
    return this.request<ImportResponse>(`/imports/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  async listImports(): Promise<ImportListResponse> {
    return this.request<ImportListResponse>('/imports', {
      method: 'GET',
    });
  }

  async getImportRows(
    id: string,
    params?: { state?: ImportRowState; limit?: number; offset?: number },
  ): Promise<ImportRowsResponse> {
    const q = new URLSearchParams();
    if (params?.state) q.set('state', params.state);
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<ImportRowsResponse>(
      `/imports/${encodeURIComponent(id)}/rows${qs}`,
      {
        method: 'GET',
      },
    );
  }

  async resolveImportRow(
    id: string,
    rowNo: number,
    data: ResolveImportRowRequest,
  ): Promise<ImportRowItem> {
    return this.request<ImportRowItem>(
      `/imports/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowNo)}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    );
  }

  async skipImportRow(id: string, rowNo: number): Promise<ImportRowItem> {
    return this.request<ImportRowItem>(
      `/imports/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowNo)}/skip`,
      {
        method: 'POST',
      },
    );
  }

  // ---------------------------------------------------------------- Exports (IM-10)

  async requestExport(data?: CreateExportRequest): Promise<ExportResponse> {
    return this.request<ExportResponse>('/exports', {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
  }

  async getExport(id: string): Promise<ExportResponse> {
    return this.request<ExportResponse>(`/exports/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  async listExports(): Promise<ExportListResponse> {
    return this.request<ExportListResponse>('/exports', {
      method: 'GET',
    });
  }

  /** The owner's short-lived download link for a completed export (audit 12). */
  async getExportLink(id: string): Promise<ExportLinkResponse> {
    return this.request<ExportLinkResponse>(`/exports/${encodeURIComponent(id)}/link`, {
      method: 'GET',
    });
  }

  // ---------------------------------------------------------------- Social & Follows (SO-01, SO-02)

  async followUser(userId: string): Promise<FollowResult> {
    return this.request<FollowResult>(`/users/${encodeURIComponent(userId)}/follow`, {
      method: 'POST',
    });
  }

  async unfollowUser(userId: string): Promise<FollowResult> {
    return this.request<FollowResult>(`/users/${encodeURIComponent(userId)}/follow`, {
      method: 'DELETE',
    });
  }

  async getPendingFollowRequests(): Promise<PendingFollowRequestsResponse> {
    return this.request<PendingFollowRequestsResponse>('/me/follow-requests', {
      method: 'GET',
    });
  }

  async acceptFollowRequest(requesterId: string): Promise<FollowResult> {
    return this.request<FollowResult>(
      `/me/follow-requests/${encodeURIComponent(requesterId)}/accept`,
      {
        method: 'POST',
      },
    );
  }

  async rejectFollowRequest(requesterId: string): Promise<FollowResult> {
    return this.request<FollowResult>(
      `/me/follow-requests/${encodeURIComponent(requesterId)}/reject`,
      {
        method: 'POST',
      },
    );
  }

  // ---------------------------------------------------------------- Blocking (SO-03)

  async blockUser(userId: string): Promise<BlockResult> {
    return this.request<BlockResult>(`/users/${encodeURIComponent(userId)}/block`, {
      method: 'POST',
    });
  }

  async unblockUser(userId: string): Promise<BlockResult> {
    return this.request<BlockResult>(`/users/${encodeURIComponent(userId)}/block`, {
      method: 'DELETE',
    });
  }

  async getBlockedUsers(): Promise<BlockedUsersResponse> {
    return this.request<BlockedUsersResponse>('/me/blocks', {
      method: 'GET',
    });
  }

  // ---------------------------------------------------------------- Muting (SO-04)

  async muteUser(userId: string): Promise<MuteResult> {
    return this.request<MuteResult>(`/users/${encodeURIComponent(userId)}/mute`, {
      method: 'POST',
    });
  }

  async unmuteUser(userId: string): Promise<MuteResult> {
    return this.request<MuteResult>(`/users/${encodeURIComponent(userId)}/mute`, {
      method: 'DELETE',
    });
  }

  async muteWork(workId: string): Promise<MuteResult> {
    return this.request<MuteResult>(`/works/${encodeURIComponent(workId)}/mute`, {
      method: 'POST',
    });
  }

  async unmuteWork(workId: string): Promise<MuteResult> {
    return this.request<MuteResult>(`/works/${encodeURIComponent(workId)}/mute`, {
      method: 'DELETE',
    });
  }

  async getMutes(): Promise<MutesResponse> {
    return this.request<MutesResponse>('/me/mutes', {
      method: 'GET',
    });
  }

  // ---------------------------------------------------------------- Followers / Following Lists (SO-05)

  async getFollowers(
    userId: string,
    query?: { limit?: number; offset?: number },
  ): Promise<FollowUserListResponse> {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) params.append('limit', String(query.limit));
    if (query?.offset !== undefined) params.append('offset', String(query.offset));
    const queryString = params.toString();
    const endpoint = `/users/${encodeURIComponent(userId)}/followers${queryString ? `?${queryString}` : ''}`;
    return this.request<FollowUserListResponse>(endpoint, { method: 'GET' });
  }

  async getFollowing(
    userId: string,
    query?: { limit?: number; offset?: number },
  ): Promise<FollowUserListResponse> {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) params.append('limit', String(query.limit));
    if (query?.offset !== undefined) params.append('offset', String(query.offset));
    const queryString = params.toString();
    const endpoint = `/users/${encodeURIComponent(userId)}/following${queryString ? `?${queryString}` : ''}`;
    return this.request<FollowUserListResponse>(endpoint, { method: 'GET' });
  }

  /** Readers to follow during onboarding (SO-52). Signed in only. */
  async getFollowSuggestions(params?: { limit?: number }): Promise<FollowSuggestionsResponse> {
    const qs = params?.limit !== undefined ? `?limit=${encodeURIComponent(String(params.limit))}` : '';
    return this.request<FollowSuggestionsResponse>(`/me/follow-suggestions${qs}`, { method: 'GET' });
  }
  // ---------------------------------------------------------------- Notifications (SO-30 to SO-33)

  async getNotifications(params?: { cursor?: string; limit?: number }): Promise<NotificationsResponse> {
    const q = new URLSearchParams();
    if (params?.cursor) q.set('cursor', params.cursor);
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    const qs = q.toString();
    return this.request<NotificationsResponse>(`/notifications${qs ? `?${qs}` : ''}`, { method: 'GET' });
  }

  async getUnreadNotificationCount(): Promise<UnreadCountResponse> {
    return this.request<UnreadCountResponse>('/notifications/unread-count', { method: 'GET' });
  }

  /** Marks the given notifications read; with no ids, all of them. */
  async markNotificationsRead(ids?: string[]): Promise<UnreadCountResponse> {
    return this.request<UnreadCountResponse>('/notifications/read', {
      method: 'POST',
      body: JSON.stringify(ids ? { ids } : {}),
    });
  }

  async getNotificationPreferences(): Promise<NotificationPreferences> {
    return this.request<NotificationPreferences>('/me/notification-preferences', { method: 'GET' });
  }

  async updateNotificationPreferences(data: UpdateNotificationPreferencesRequest): Promise<NotificationPreferences> {
    return this.request<NotificationPreferences>('/me/notification-preferences', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  /** On every app open (PRD §19.5: tokens refresh on launch). */
  async registerPushToken(data: RegisterPushTokenRequest): Promise<{ registered: boolean }> {
    return this.request<{ registered: boolean }>('/me/push-tokens', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async unregisterPushToken(token: string): Promise<void> {
    await this.request<null>(`/me/push-tokens/${encodeURIComponent(token)}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------- Moderation (SO-40 to SO-42)

  /** PRD §6.44. 201 for a new report; a repeat of an open one returns it unchanged. */
  async createReport(data: CreateReportRequest): Promise<ReportResponse> {
    return this.request<ReportResponse>('/reports', { method: 'POST', body: JSON.stringify(data) });
  }

  async getMyReports(params?: { limit?: number; offset?: number }): Promise<MyReportsResponse> {
    const q = new URLSearchParams();
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    if (params?.offset !== undefined) q.set('offset', String(params.offset));
    const qs = q.toString();
    return this.request<MyReportsResponse>(`/me/reports${qs ? `?${qs}` : ''}`, { method: 'GET' });
  }

  async getModerationNotices(): Promise<ModerationNoticesResponse> {
    return this.request<ModerationNoticesResponse>('/me/moderation', { method: 'GET' });
  }

  async getModerationNotice(id: string): Promise<ModerationNotice> {
    return this.request<ModerationNotice>(`/me/moderation/${encodeURIComponent(id)}`, { method: 'GET' });
  }

  /** Once per decision (PRD §27.6). */
  async appealModeration(id: string, body: string): Promise<ModerationNotice> {
    return this.request<ModerationNotice>(`/me/moderation/${encodeURIComponent(id)}/appeal`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async adminGetReportQueue(params?: { subject_type?: ReportSubjectType; limit?: number; offset?: number }): Promise<AdminReportQueueResponse> {
    const q = new URLSearchParams();
    if (params?.subject_type) q.set('subject_type', params.subject_type);
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    if (params?.offset !== undefined) q.set('offset', String(params.offset));
    const qs = q.toString();
    return this.request<AdminReportQueueResponse>(`/admin/reports${qs ? `?${qs}` : ''}`, { method: 'GET' });
  }

  async adminGetReportCase(subjectType: ReportSubjectType, subjectId: string): Promise<AdminReportCaseDetail> {
    return this.request<AdminReportCaseDetail>(
      `/admin/reports/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`,
      { method: 'GET' },
    );
  }

  async adminActOnReport(subjectType: ReportSubjectType, subjectId: string, data: AdminReportActionRequest): Promise<AdminModerationAction> {
    return this.request<AdminModerationAction>(
      `/admin/reports/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}/action`,
      { method: 'POST', body: JSON.stringify(data) },
    );
  }

  async adminGetAppeals(params?: { limit?: number; offset?: number }): Promise<AdminAppealsResponse> {
    const q = new URLSearchParams();
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    if (params?.offset !== undefined) q.set('offset', String(params.offset));
    const qs = q.toString();
    return this.request<AdminAppealsResponse>(`/admin/appeals${qs ? `?${qs}` : ''}`, { method: 'GET' });
  }

  async adminResolveAppeal(id: string, data: { decision: 'uphold' | 'overturn'; reason: string }): Promise<AdminModerationAction> {
    return this.request<AdminModerationAction>(`/admin/appeals/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
}



