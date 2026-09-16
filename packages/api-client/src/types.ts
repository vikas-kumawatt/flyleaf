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
