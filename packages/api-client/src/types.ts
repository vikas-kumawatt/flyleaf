// Generated API contract types from openapi.yaml (FN-81, Architecture §6).
// DO NOT EDIT MANUALLY.

export interface ApiErrorDetails {
  code: string;
  message: string;
  field?: string;
}

export interface ApiErrorResponse {
  error: ApiErrorDetails;
}

// ---------------------------------------------------------------- Auth

export interface User {
  id: string;
  email: string;
  username: string;
}

export interface Profile {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarKey: string | null;
  isPrivate: boolean;
  followerCount: number;
  followingCount: number;
  createdAt: string;
}

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
  dateOfBirth: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface StandardResponse {
  status: 'ok';
  message: string;
}

export interface VerifyEmailRequest {
  token: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}

export interface Session {
  id: string;
  device: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export interface SessionListResponse {
  data: Session[];
}

// ---------------------------------------------------------------- Catalog

export interface Edition {
  id: string;
  isbn13: string | null;
  page_count: number | null;
  format: string;
  cover_id: number | null;
}

export interface EditionDetail {
  id: string;
  work_id: string;
  isbn13: string | null;
  isbn10: string | null;
  title: string | null;
  publisher: string | null;
  publish_year: number | null;
  page_count: number | null;
  format: string;
  cover_id: number | null;
}

export interface EditionLookupResponse {
  work: Work;
  edition: EditionDetail;
}

export interface YourRead {
  id: string;
  status: string;
  rating: number | null;
  hearted: boolean;
  page: number | null;
  percent: number | null;
}

export interface Work {
  id: string;
  title: string;
  author_name: string;
  first_publish_year: number | null;
  cover_id: number | null;
  log_count: number;
  editions?: Edition[];
  your_read?: YourRead;
}

export interface SearchResponse {
  data: Work[];
}

// ---------------------------------------------------------------- Reading

export type ReadStatus = 'want' | 'reading' | 'paused' | 'finished' | 'dnf';
export type ReadVisibility = 'public' | 'followers' | 'private';

export interface Read {
  id: string;
  user_id: string;
  work_id: string;
  status: ReadStatus;
  attempt_no: number;
  rating: number | null;
  hearted: boolean;
  visibility: ReadVisibility;
  title?: string;
  author_name?: string;
  cover_id?: number | null;
  page?: number | null;
  percent?: number | null;
  page_count?: number | null;
}

export interface ReadListResponse {
  data: Read[];
}

export interface UpsertReadRequest {
  work_id: string;
  status: ReadStatus;
  rating?: number | null;
  hearted?: boolean | null;
  visibility?: ReadVisibility | null;
}

export interface ProgressEventRequest {
  client_event_id: string;
  page?: number | null;
  percent?: number | null;
  minutes?: number | null;
}

// ---------------------------------------------------------------- Dedupe & Admin

export interface DedupeWorkSummary {
  id: string;
  title: string;
  authors: string[];
  first_publish_year: number | null;
  log_count: number;
  edition_count: number;
  reads_count?: number;
  cover_id: number | null;
}

export interface DedupeQueueItem {
  id: string;
  stage: 3 | 4;
  status: 'pending' | 'merged' | 'dismissed';
  confidence: number | null;
  reason: string;
  dismiss_reason?: string | null;
  created_at: string;
  reviewed_at?: string | null;
  reviewed_by_user_id?: string | null;
  survivor: DedupeWorkSummary;
  loser: DedupeWorkSummary;
}

export interface DedupeQueueListResponse {
  data: DedupeQueueItem[];
}

export interface DedupePreviewResponse {
  survivor: DedupeWorkSummary;
  loser: DedupeWorkSummary;
  preview: {
    reads_to_move: number;
    colliding_reads: number;
    editions_to_move: number;
    authors_to_add: number;
    subjects_to_add: number;
  };
}

export interface DedupeResolveRequest {
  action: 'merge' | 'dismiss';
  reason?: string;
}

export interface DedupeResolveResponse {
  success: boolean;
  action: 'merge' | 'dismiss';
  merge_id?: string;
}

export interface DedupeReportRequest {
  survivor_id: string;
  loser_id: string;
  reason: string;
}

export interface DedupeReportResponse {
  id: string;
  queued: boolean;
}

export interface MergeListItem {
  id: string;
  survivor: { id: string; title: string };
  loser: { id: string; title: string };
  stage: number;
  reason: string;
  merged_at: string;
  undone_at: string | null;
  can_undo: boolean;
  stats: {
    reads_moved: number;
    editions_moved: number;
    authors_moved: number;
  };
}

export interface MergeListResponse {
  data: MergeListItem[];
}

export interface UndoMergeResponse {
  undone: boolean;
  merge_id: string;
  survivor_id: string;
  loser_id: string;
  restored: {
    reads: number;
    editions: number;
    authors: number;
    subjects: number;
  };
}

// ---------------------------------------------------------------- Admin Auth & Audit (FN-90, FN-93)

export type AdminRole = 'admin' | 'moderator';

export interface AdminViewer {
  id: string;
  email: string;
  role: AdminRole;
}

export interface AdminLoginRequest {
  email: string;
  password: string;
  totp_code: string;
}

export interface AdminLoginResponse {
  token: string;
  admin: AdminViewer;
}

export interface AdminMeResponse {
  admin: AdminViewer;
}

export interface Admin2faSetupResponse {
  secret: string;
  otpauth_uri: string;
  backup_codes: string[];
}

export interface Admin2faVerifyRequest {
  code: string;
}

export interface Admin2faVerifyResponse {
  success: boolean;
}

export interface AdminAuditLogItem {
  id: number;
  actor_id: string;
  actor_email: string;
  actor_role: string;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AdminAuditLogQuery {
  action?: string;
  actor_id?: string;
  subject_type?: string;
  limit?: number;
  offset?: number;
}

export interface AdminAuditLogResponse {
  data: AdminAuditLogItem[];
}

