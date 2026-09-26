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
  PostEventsResponse,
  Profile,
  ProgressEventRequest,
  Read,
  ReadingStats,
  ReadListResponse,
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
  CreateExportRequest,
} from './types.js';

export class FlyleafApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public field?: string,
    public status?: number,
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
      throw new FlyleafApiError(
        err?.code ?? 'unknown_error',
        err?.message ?? `Request failed with status ${res.status}`,
        err?.field,
        res.status,
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

  async getUserProfile(userId: string): Promise<Profile> {
    return this.request<Profile>(`/users/${encodeURIComponent(userId)}`, {
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

  // ---------------------------------------------------------------- Catalog

  async search(q: string, limit = 20): Promise<Work[]> {
    const query = new URLSearchParams({ q, limit: String(limit) });
    const res = await this.request<SearchResponse>(`/search?${query.toString()}`, {
      method: 'GET',
    });
    return res.data;
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

  async getUserReads(userId: string, status?: ReadStatus): Promise<Read[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await this.request<ReadListResponse>(`/users/${encodeURIComponent(userId)}/reads${query}`, {
      method: 'GET',
    });
    return res.data;
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

  async getMyStats(year?: number | string): Promise<ReadingStats> {
    const q = year !== undefined ? `?year=${encodeURIComponent(String(year))}` : '';
    return this.request<ReadingStats>(`/me/stats${q}`, {
      method: 'GET',
    });
  }

  async getUserStats(userId: string, year?: number | string): Promise<ReadingStats> {
    const q = year !== undefined ? `?year=${encodeURIComponent(String(year))}` : '';
    return this.request<ReadingStats>(`/users/${encodeURIComponent(userId)}/stats${q}`, {
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

  async getSavedShelves(): Promise<SavedShelvesResponse> {
    return this.request<SavedShelvesResponse>('/shelves/saved', {
      method: 'GET',
    });
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
}



