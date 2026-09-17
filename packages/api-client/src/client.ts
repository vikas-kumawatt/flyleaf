// Typed Flyleaf API Client (FN-81, Architecture §6).

import type {
  Admin2faSetupResponse,
  Admin2faVerifyRequest,
  Admin2faVerifyResponse,
  AdminAuditLogItem,
  AdminAuditLogQuery,
  AdminAuditLogResponse,
  AdminLoginRequest,
  AdminLoginResponse,
  AdminMeResponse,
  AdminViewer,
  ApiErrorResponse,
  AuthResponse,
  DedupePreviewResponse,
  DedupeQueueItem,
  DedupeQueueListResponse,
  DedupeReportRequest,
  DedupeReportResponse,
  DedupeResolveRequest,
  DedupeResolveResponse,
  EditionLookupResponse,
  ForgotPasswordRequest,
  LoginRequest,
  MergeListItem,
  MergeListResponse,
  Profile,
  ProgressEventRequest,
  Read,
  ReadListResponse,
  ReadStatus,
  RefreshRequest,
  RefreshResponse,
  RegisterRequest,
  ResetPasswordRequest,
  SearchResponse,
  Session,
  SessionListResponse,
  StandardResponse,
  UndoMergeResponse,
  UpsertReadRequest,
  User,
  VerifyEmailRequest,
  Work,
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
}

export class FlyleafClient {
  private baseUrl: string;
  private getToken?: () => Promise<string | null> | string | null;
  private fetchFn: typeof fetch;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.getToken = config.getToken;
    this.fetchFn = config.fetch ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.getToken ? await this.getToken() : null;
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    const headers: Record<string, string> = {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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

  async undoMerge(mergeId: string): Promise<UndoMergeResponse> {
    return this.request<UndoMergeResponse>(`/admin/merges/${encodeURIComponent(mergeId)}/undo`, {
      method: 'POST',
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
}


