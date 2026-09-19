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

export interface ProfileFavourite {
  id: string;
  title: string;
  author_name: string;
  cover_id?: number | null;
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
  favourite_work_ids?: string[];
  favourites?: ProfileFavourite[];
  createdAt: string;
}

export interface UpdateProfileRequest {
  displayName?: string | null;
  bio?: string | null;
  isPrivate?: boolean;
  favouriteWorkIds?: string[];
}

export interface MonthlyPaceItem {
  month: number;
  books: number;
  pages: number;
}

export interface ExtremeBook {
  work_id: string;
  title: string;
  author_name?: string | null;
  page_count?: number | null;
  cover_id?: number | null;
}

export interface MostReadAuthor {
  name: string;
  count: number;
}

export interface ReadingStats {
  year: string;
  books_count: number;
  pages_count: number;
  audio_hours: number;
  avg_rating?: number | null;
  rating_distribution: {
    '5': number;
    '4': number;
    '3': number;
    '2': number;
    '1': number;
  };
  format_breakdown: {
    print: number;
    ebook: number;
    audiobook: number;
  };
  monthly_pace: MonthlyPaceItem[];
  longest_book?: ExtremeBook | null;
  shortest_book?: ExtremeBook | null;
  most_read_author?: MostReadAuthor | null;
  dnf_count: number;
  dnf_rate: number;
  current_streak: number;
  longest_streak: number;
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
  avg_rating?: number | null;
  weighted_rating?: number | null;
  rating_count?: number;
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
  edition_id?: string | null;
  status: ReadStatus;
  attempt_no: number;
  started_at?: string | null;
  finished_at?: string | null;
  abandoned_at?: string | null;
  abandoned_page?: number | null;
  dnf_reason?: string | null;
  rating: number | null;
  hearted: boolean;
  format_override?: string | null;
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
  edition_id?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  abandoned_page?: number | null;
  dnf_reason?: string | null;
  rating?: number | null;
  hearted?: boolean | null;
  format_override?: string | null;
  visibility?: ReadVisibility | null;
}

export interface ProgressEventRequest {
  client_event_id: string;
  page?: number | null;
  percent?: number | null;
  audio_seconds?: number | null;
  minutes?: number | null;
  note?: string | null;
}

export interface FinishReadRequest {
  finished_at?: string | null;
  rating?: number | null;
  hearted?: boolean | null;
  format_override?: string | null;
  review?: string | null;
  visibility?: ReadVisibility | null;
}

export interface DnfReadRequest {
  abandoned_page?: number | null;
  dnf_reason?: string | null;
  note?: string | null;
  rating?: number | null;
  visibility?: ReadVisibility | null;
}

// ---------------------------------------------------------------- Reviews & Social (SL-63, SL-64)

export interface ReviewAuthor {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

export interface Review {
  id: string;
  read_id: string;
  user_id: string;
  work_id: string;
  body: string;
  has_spoilers: boolean;
  spoiler_after_page?: number | null;
  visibility: 'public' | 'followers' | 'private';
  published_at: string;
  edited_at?: string | null;
  rating?: number | null;
  hearted: boolean;
  format_override?: string | null;
  like_count: number;
  comment_count?: number;
  viewer_has_liked: boolean;
  author: ReviewAuthor;
  work_title?: string | null;
  work_author?: string | null;
  work_cover_id?: number | null;
}

export interface CreateReviewRequest {
  body: string;
  has_spoilers?: boolean;
  spoiler_after_page?: number | null;
  visibility?: 'public' | 'followers' | 'private';
  rating?: number | null;
  hearted?: boolean | null;
}

export interface UpdateReviewRequest {
  body?: string;
  has_spoilers?: boolean;
  spoiler_after_page?: number | null;
  visibility?: 'public' | 'followers' | 'private';
  rating?: number | null;
  hearted?: boolean | null;
}

export interface WorkReviewsQuery {
  sort?: 'friends' | 'likes' | 'newest' | 'highest' | 'lowest';
  rating?: number;
  limit?: number;
  offset?: number;
}

export interface WorkReviewsResponse {
  data: Review[];
  total: number;
}

export interface ToggleLikeResponse {
  liked: boolean;
  like_count: number;
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

// ---------------------------------------------------------------- Admin Catalog & Ingest (FN-92)

export type AdminMaturityRating = 'general' | 'mature' | 'explicit' | 'unclassified';

export interface AdminCatalogWorkSummary {
  id: string;
  title: string;
  subtitle: string | null;
  author_name: string;
  first_publish_year: number | null;
  ol_cover_id: number | null;
  maturity: AdminMaturityRating;
  log_count: number;
  is_locked: boolean;
  updated_at: string;
}

export interface AdminCatalogWorksQuery {
  maturity?: AdminMaturityRating;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AdminCatalogWorksListResponse {
  works: AdminCatalogWorkSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminCatalogWorkDetail {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  alternate_titles: string[];
  first_publish_year: number | null;
  ol_cover_id: number | null;
  maturity: AdminMaturityRating;
  log_count: number;
  is_locked: boolean;
  ol_work_key: string | null;
  authors: Array<{ id: string; name: string; role: string }>;
  subjects: string[];
  editions_count: number;
  provenance: Array<{
    field_name: string;
    provider: string;
    is_locked: boolean;
    fetched_at: string;
  }>;
  audit_history: Array<{
    id: string;
    action: string;
    actor_email: string;
    reason: string | null;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
}

export interface AdminCatalogWorkResponse {
  work: AdminCatalogWorkDetail;
}

export interface AdminMaturityOverrideRequest {
  maturity: AdminMaturityRating;
  reason: string;
}

export interface AdminMaturityOverrideResponse {
  success: boolean;
  work_id: string;
  previous_maturity: AdminMaturityRating;
  new_maturity: AdminMaturityRating;
  is_locked: boolean;
}

export interface AdminIngestRun {
  id: string;
  dump_type: string;
  status: string;
  lines_read: number;
  rows_written: number;
  rows_skipped: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
}

export interface AdminIngestStatusResponse {
  last_run: AdminIngestRun | null;
  recent_runs: AdminIngestRun[];
  runs_summary: {
    total_runs: number;
    completed: number;
    failed: number;
    interrupted: number;
    running: number;
  };
  catalog: {
    works_count: number;
    editions_count: number;
    authors_count: number;
    authorship_links_count: number;
    works_with_cover_count: number;
    raw_payloads_count: number;
  };
  maturity_breakdown: {
    general: number;
    mature: number;
    explicit: number;
    unclassified: number;
    overridden_locked: number;
  };
  telemetry: {
    circuit_breaker: {
      state: 'closed' | 'open' | 'half-open';
      threshold: number;
      cooldown_seconds: number;
    };
    outbound_limiter: {
      rate_per_second: number;
      burst: number;
    };
    pending_work_authors_count: number;
    dedupe_queue_pending_count: number;
  };
}

// ---------------------------------------------------------------- Telemetry (SL-80, SL-81)

export interface TelemetryEvent {
  name: string;
  session_id?: string | null;
  platform?: string | null;
  app_version?: string | null;
  properties?: Record<string, any>;
  at?: string | null;
}

export interface PostEventsBatchRequest {
  events: TelemetryEvent[];
}

export interface PostEventsResponse {
  accepted: number;
}

export interface BudgetMetricItem {
  sample_count: number;
  passing: boolean;
}

export interface DurationBudgetMetric extends BudgetMetricItem {
  p75_duration_ms: number | null;
  budget_ms: number;
}

export interface TapBudgetMetric extends BudgetMetricItem {
  p75_tap_count: number | null;
  budget_taps: number;
}

export interface SecondsBudgetMetric extends BudgetMetricItem {
  p75_duration_seconds: number | null;
  budget_seconds: number;
}

export interface AbandonmentBudgetMetric extends BudgetMetricItem {
  abandonment_rate: number;
  abandoned_count: number;
  completed_count: number;
  budget_max_rate: number;
}

export interface BudgetMetricsResponse {
  progress_updated: DurationBudgetMetric;
  book_logged: TapBudgetMetric;
  finish_completed: SecondsBudgetMetric;
  log_sheet_completed: DurationBudgetMetric;
  finish_flow_abandoned: AbandonmentBudgetMetric;
}

// ---------------------------------------------------------------- Shelves (SH-01, SH-02)

export type ShelfPrivacy = 'public' | 'followers' | 'private';

export interface ShelfOwner {
  id: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
}

export interface Shelf {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  description: string | null;
  is_ranked: boolean;
  privacy: ShelfPrivacy;
  cover_work_ids: string[];
  cover_ids?: (number | null)[];
  item_count: number;
  save_count: number;
  is_saved?: boolean;
  created_at: string;
  owner: ShelfOwner;
}

export interface ShelfResponse {
  shelf: Shelf;
}

export interface CreateShelfRequest {
  name: string;
  description?: string | null;
  is_ranked?: boolean;
  privacy?: ShelfPrivacy;
}

export interface UpdateShelfRequest {
  name?: string;
  description?: string | null;
  is_ranked?: boolean;
  privacy?: ShelfPrivacy;
}

export interface DeleteShelfResponse {
  deleted: boolean;
  id: string;
}

export interface ShelfItemWork {
  id: string;
  title: string;
  author_name: string;
  cover_id: number | null;
  first_publish_year: number | null;
  log_count: number;
  rating: number | null;
  your_read?: {
    status: string;
    rating: number | null;
    hearted: boolean;
  } | null;
}

export interface ShelfItem {
  shelf_id: string;
  work_id: string;
  position: number;
  note: string | null;
  added_at: string;
  work: ShelfItemWork;
}

export interface ShelfItemsResponse {
  data: ShelfItem[];
  total: number;
}

export interface AddShelfItemRequest {
  work_id: string;
  note?: string | null;
  position?: number;
}

export interface ShelfItemResponse {
  item: ShelfItem;
}

export interface ShelfWithWorkState extends Shelf {
  contains_work: boolean;
  item_note: string | null;
  position: number | null;
}

export interface MyShelvesResponse {
  shelves: ShelfWithWorkState[];
}

export interface DeleteShelfItemResponse {
  deleted: boolean;
  shelf_id: string;
  work_id: string;
}

export interface UpdateShelfItemRequest {
  note?: string | null;
  position?: number;
}

export interface ReorderShelfRequest {
  work_ids: string[];
}

export interface ReorderShelfResponse {
  reordered: boolean;
  shelf_id: string;
  count: number;
}

export interface SaveShelfResponse {
  saved: boolean;
  shelf_id: string;
  save_count: number;
}

export interface SavedShelvesResponse {
  shelves: Shelf[];
}

export interface BrowseShelvesQuery {
  query?: string;
  sort?: 'ranked' | 'popular' | 'recent';
  limit?: number;
  offset?: number;
}

export interface BrowseShelvesResponse {
  shelves: Shelf[];
  total: number;
}

export interface UserShelvesResponse {
  shelves: Shelf[];
}

// ---------------------------------------------------------------- Imports (IM-02)

export type ImportSource =
  | 'goodreads'
  | 'storygraph'
  | 'librarything'
  | 'calibre'
  | 'openlibrary'
  | 'openreads';

export type ImportState = 'queued' | 'processing' | 'completed' | 'failed';

export interface ImportResponse {
  id: string;
  job_id: string;
  source: ImportSource;
  state: ImportState;
  total_rows: number;
  matched: number;
  unmatched: number;
  filename?: string | null;
  file_size_bytes?: number | null;
  content_hash?: string | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
}

export interface ImportListResponse {
  imports: ImportResponse[];
}

