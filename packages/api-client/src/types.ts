// API contract types, kept in step with openapi.yaml (FN-81, Architecture §6).
// HAND-WRITTEN, not generated (Audit 05, A-05 FN-81): when a route schema
// changes, update the matching type here. Recommended: generate these with
// openapi-typescript and check the output in CI, as spec:check does for the spec.

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
  /** Present on GET /me. False: reviews, comments and follows get 403 email_unverified. */
  emailVerified?: boolean;
  /**
   * Present on GET /me. False: the date of birth was never entered (D-07-3);
   * ask for it with confirmDateOfBirth. Until then the account is treated as a minor.
   */
  dobConfirmed?: boolean;
  /** Present on GET /me: "Show explicit titles in search" (PRD §7.8). */
  showExplicit?: boolean;
  /** Present on GET /me: false hides the control entirely (under 18, or date of birth not confirmed). */
  explicitSettingAvailable?: boolean;
}

/** PUT /me/content-settings. dateOfBirth is required to turn it on and must match the account's. */
export interface ContentSettingsRequest {
  showExplicit: boolean;
  dateOfBirth?: string;
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
  /** GET /v1/avatars/… (relative to the API origin), or null for the generated avatar. */
  avatarUrl?: string | null;
  isPrivate: boolean;
  isRestricted?: boolean;
  followerCount: number;
  followingCount: number;
  favourite_work_ids?: string[];
  favourites?: ProfileFavourite[];
  createdAt: string;
  followStatus?: 'none' | 'pending' | 'accepted' | 'self';
  followedBy?: boolean;
}

export type FollowState = 'pending' | 'accepted' | 'none';

export interface FollowResult {
  status: FollowState;
  follower_id: string;
  followee_id: string;
}

export interface PendingFollowRequest {
  id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  bio: string | null;
  requested_at: string;
}

export interface PendingFollowRequestsResponse {
  requests: PendingFollowRequest[];
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

/** The keys of Work.rating_distribution: the ten half-star ratings. */
export type RatingBucket = '0.5' | '1.0' | '1.5' | '2.0' | '2.5' | '3.0' | '3.5' | '4.0' | '4.5' | '5.0';

export interface ReadingStats {
  year: string;
  books_count: number;
  pages_count: number;
  audio_hours: number;
  avg_rating?: number | null;
  /** Different works among books_count: a re-read counts once here (PRD §17.2). */
  distinct_works_count: number;
  /** Finished reads per half-star rating, "0.5" to "5.0" (A-09-043). */
  rating_distribution: Record<RatingBucket, number>;
  /** format_override, else the edition format; unknown when neither says (never guessed as print). */
  format_breakdown: {
    print: number;
    ebook: number;
    audiobook: number;
    unknown: number;
  };
  monthly_pace: MonthlyPaceItem[];
  longest_book?: ExtremeBook | null;
  shortest_book?: ExtremeBook | null;
  most_read_author?: MostReadAuthor | null;
  dnf_count: number;
  dnf_rate: number;
  current_streak: number;
  longest_streak: number;
  /** PRD §17.4: what the figures leave out, so the screen can say so. */
  excluded: { undated: number; missing_page_count: number };
  /** Reading or paused now, whatever the year (§17.2). */
  books_in_progress: number;
  /** Mean of (your rating − the book's average without yours); negative = below average. Null with nothing to compare. */
  vs_crowd: number | null;
  /** Each finished book once, under its strongest genre: top 8, the rest in other. */
  genres: { top: Array<{ name: string; count: number }>; other: number };
  decades: Array<{ decade: number; count: number }>;
  /** Shown only with more than one language (§17.2). */
  languages: Array<{ language: string; count: number }>;
  /** Days to finish, start and finish day included. */
  velocity: { median_days: number | null; by_month: Array<{ month: number; median_days: number | null }> };
  /** Pages per hour from sessions with minutes and a page rise (§8.4); null when there are none. */
  speed: { pages_per_hour: number | null; pages: number; minutes: number };
  /** Pages per Monday-start week and the 7-day average. */
  pace: Array<{ week_start: string; pages: number; pages_per_day: number }>;
  /** Progress events per weekday (Monday first) × hour 0–23. */
  time_of_day: number[][];
  fastest_read?: (ExtremeBook & { days: number }) | null;
  slowest_read?: (ExtremeBook & { days: number }) | null;
  highest_rated?: (ExtremeBook & { rating: number }) | null;
  lowest_rated?: (ExtremeBook & { rating: number }) | null;
  oldest_publication?: (ExtremeBook & { year: number }) | null;
  most_reread?: (ExtremeBook & { count: number }) | null;
  /** §8.7 streak ranges (two-day grace; length is the span). */
  current_streak_range: StatsDateRange | null;
  longest_streak_range: StatsDateRange | null;
  /** ST-03: "based on N of M" per figure (books, except pace and speed: sessions). */
  coverage: Record<StatsCoverageKey, StatsCoverage>;
}

export interface StatsDateRange {
  start: string;
  end: string;
}

export interface StatsCoverage {
  based_on: number;
  of: number;
}

export type StatsCoverageKey =
  | 'pages' | 'months' | 'ratings' | 'vs_crowd' | 'formats' | 'authors' | 'genres'
  | 'decades' | 'languages' | 'velocity' | 'audio' | 'pace' | 'speed';

/** ST-05, PRD §8.6: a reading goal and progress as this viewer may count it. For the profile ring only. */
export interface GoalResponse {
  year: number;
  goal: {
    target_books: number;
    target_pages: number | null;
    books_count: number;
    pages_count: number;
    books_reached: boolean;
    pages_reached: boolean | null;
    pages_coverage: StatsCoverage;
  } | null;
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

/** GET /auth/username-available (PRD §6.7). */
export interface UsernameAvailability {
  username: string;
  available: boolean;
  reason?: 'invalid' | 'reserved' | 'taken';
  suggestions?: string[];
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
  /** GET /works/:id only. */
  publisher?: string | null;
  /** GET /works/:id only. */
  publish_year?: number | null;
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
  maturity: 'general' | 'mature' | 'explicit' | 'unclassified';
  /** Explicit, and hidden from this viewer in search: show the §7.8 interstitial. */
  content_warning: boolean;
}

export interface YourRead {
  id: string;
  status: string;
  rating: number | null;
  hearted: boolean;
  page: number | null;
  percent: number | null;
  /** GET /works/:id only: your live review of this read (the composer edits it). */
  review_id?: string | null;
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
  /** GET /works/:id only: readers who hearted the book (PRD §9.4). */
  heart_count?: number;
  editions?: Edition[];
  your_read?: YourRead;
  /** GET /works/:id only: the requested id was merged into this work; this is the survivor (D3). */
  merged_into?: string;
  /** GET /works/:id only (PRD §7.8). */
  maturity?: 'general' | 'mature' | 'explicit' | 'unclassified';
  /** GET /works/:id only: explicit, and search would hide it from this viewer. Show the interstitial. */
  content_warning?: boolean;
  /** GET /works/:id only. */
  description?: string | null;
  /** GET /works/:id only: credited authors, in credit order. */
  authors?: { id: string; name: string }[];
  /** GET /works/:id only. */
  series?: { id: string; name: string; position: number | null }[];
  /** GET /works/:id only: readers per half-star rating, "0.5" to "5.0" (PRD §9.6); each reader once, at their latest rated attempt. Sums to rating_count. */
  rating_distribution?: Record<RatingBucket, number>;
  /** GET /works/:id only: the page count progress and stats use with no edition chosen (default edition, else the median, D-08-3). */
  page_count?: number | null;
}

/** GET /authors/:id (SL-43). */
export interface AuthorDetail {
  id: string;
  name: string;
  alternate_names: string[];
  bio: string | null;
  works_count: number;
  /** Works by this author the viewer has finished; 0 for a guest. */
  read_count: number;
  works: Work[];
}

/** GET /series/:id (SL-43). */
export interface SeriesDetail {
  id: string;
  name: string;
  /** Entries the viewer has finished; 0 for a guest. */
  read_books: number;
  entries: {
    work_id: string;
    position: number | null;
    title: string;
    author_name: string;
    cover_id: number | null;
    your_status: ReadStatus | null;
  }[];
}

export interface SearchResponse {
  data: Work[];
  /** "Did you mean …?" (PRD §14.7) when the local catalog found nothing; else null. */
  suggestion: string | null;
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
  /** The DNF flow's optional note (PRD §6.18). */
  dnf_note?: string | null;
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

export interface DeleteReadResponse {
  deleted: true;
  id: string;
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
  /** Half steps. null or omitted leaves the rating unchanged; use clear_rating to remove it. */
  rating?: number | null;
  /** true removes the rating (PRD §9.3). 422 together with a rating. */
  clear_rating?: boolean | null;
  hearted?: boolean | null;
  format_override?: string | null;
  visibility?: ReadVisibility | null;
  /** true writes only if the viewer has no read of the work; otherwise 409 already_in_library (D-11-1). */
  if_absent?: boolean | null;
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
  /** Refused with 422 unless null: publish a review with saveReview (POST /reads/{id}/review). */
  review?: null;
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
  /** Star bucket 1–5: 4 lists reviews rated 3.5 and 4.0 (rating_distribution's "3.5" and "4.0"). */
  rating?: number;
  limit?: number;
  offset?: number;
}

export interface WorkReviewsResponse {
  data: Review[];
  total: number;
}

/** Response of POST and DELETE /reads/{id}/like (SO-21). */
export interface ToggleLikeResponse {
  liked: boolean;
  like_count: number;
}
export type LikeResponse = ToggleLikeResponse;

// ---------------------------------------------------------------- Read interactions (SO-2x)

export interface InteractionUser {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface ReadLikersResponse {
  read_id: string;
  like_count: number;
  users: (InteractionUser & { liked_at: string })[];
}

export interface ReadComment {
  id: string;
  read_id: string;
  body: string;
  created_at: string;
  author: InteractionUser;
  viewer_can_delete: boolean;
}

export interface ReadCommentsResponse {
  read_id: string;
  comment_count: number;
  /** The read's review was deleted: the thread is read-only. */
  locked: boolean;
  comments: ReadComment[];
  next_cursor: string | null;
}

/** Like/comment state of the read behind a feed card; null when the card is not a social object. */
export interface FeedInteraction {
  read_id: string;
  like_count: number;
  comment_count: number;
  viewer_has_liked: boolean;
}

export interface FeedItem {
  id: string;
  actor_id: string;
  actor: InteractionUser;
  verb: 'started' | 'finished' | 'rated' | 'reviewed' | 'dnf' | 'shelved' | 'followed' | 'goal_reached' | 'quoted';
  work_id: string | null;
  work: { id: string; title: string; author_name: string | null; cover_id: number | null } | null;
  object_type: string | null;
  object_id: string | null;
  metadata: Record<string, unknown>;
  visibility: 'public' | 'followers' | 'private';
  created_at: string;
  interaction?: FeedInteraction | null;
}

export interface FeedResponse {
  items: FeedItem[];
  /** Opaque; pass it back as `cursor`. A page may hold fewer than `limit` items while has_more is true. */
  next_cursor: string | null;
  has_more: boolean;
  tab: string;
  is_cold_start?: boolean;
  following_count?: number;
  cold_start_reason?: string | null;
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
  /** 1-2: pairs too ambiguous to auto-merge (Audit 03b); 3: fuzzy; 4: reported. */
  stage: 1 | 2 | 3 | 4;
  status: 'pending' | 'merged' | 'dismissed';
  confidence: number | null;
  /** User-data rows on either work; the queue is ordered by this, highest first. */
  impact: number;
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
  /**
   * Stored in the admin audit log (D-06-1). Optional for a pair a rule queued
   * (stages 1-3: defaults to the rule); a user-reported pair needs 10+ characters.
   */
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
  /** Null for a failed login whose email is not a staff account. */
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  ip?: string | null;
  user_agent?: string | null;
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
  /** True when totals and the maturity breakdown are planner statistics, not exact counts. */
  counts_are_estimates: boolean;
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
  /** Dropped by the caps: unknown name, properties, timestamp, budget measurement. */
  rejected: number;
}

export interface BudgetMetricItem {
  sample_count: number;
  /** null: no samples in the window. */
  passing: boolean | null;
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
  abandonment_rate: number | null;
  abandoned_count: number;
  completed_count: number;
  budget_max_rate: number;
}

export interface BudgetMetricsResponse {
  window_days: number;
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
  /** The URL to load the avatar from (A-11-029). */
  avatarUrl: string | null;
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
  total: number;
}

export interface DeletedShelf extends Shelf {
  deleted_at: string;
  /** After this the shelf can no longer be restored (30 days, PRD §15.6). */
  purge_after: string;
}

export interface DeletedShelvesResponse {
  shelves: DeletedShelf[];
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

// ---------------------------------------------------------------- Uploads (PV-02)

export type UploadPurpose = 'import' | 'avatar';

/** PUT/DELETE /me/avatar. */
export interface AvatarResponse {
  avatar_url: string | null;
}

/** GET /users/:id/reads: one page, newest update first. */
export interface UserReadPage {
  data: Read[];
  next_cursor: string | null;
}
export type UploadStatus = 'pending' | 'uploaded' | 'consumed' | 'expired';

export interface CreateUploadRequest {
  purpose: UploadPurpose;
  content_type: string;
  /** Exact size in bytes; the upload must match it. */
  size: number;
  filename?: string;
}

/** Where to send the bytes: straight to object storage, never to the API. */
export interface UploadTarget {
  url: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  fields?: Record<string, string>;
}

export interface UploadResponse {
  id: string;
  purpose: UploadPurpose;
  status: UploadStatus;
  content_type: string;
  size: number;
  max_bytes: number;
  filename?: string | null;
  expires_at: string;
  created_at: string;
  completed_at?: string | null;
  /** Only in the response to createUpload. */
  target?: UploadTarget;
}

/** A file's bytes: text, a Blob, or raw bytes. */
export type UploadBody = string | Blob | Uint8Array | ArrayBuffer;

export interface UploadFileOptions {
  /** Declared and signed: storage refuses a different Content-Type. */
  contentType: string;
  filename?: string;
  /** Bytes sent so far; uses XMLHttpRequest where it exists (browsers, React Native). */
  onProgress?: (sent: number, total: number) => void;
  /** Tries for the direct-upload step only (network error, 408, 429, 5xx). Default 3. */
  attempts?: number;
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

/** POST /v1/imports (PV-02): from a completed upload with purpose `import`. */
export interface CreateImportRequest {
  upload_id: string;
  source: ImportSource;
  /** Bypass duplicate detection by content hash (IM-11): "import anyway". */
  force?: boolean;
}

export type ImportRowState = 'matched' | 'unmatched' | 'resolved' | 'skipped';

export interface ImportRowItem {
  import_id: string;
  row_no: number;
  raw: Record<string, unknown>;
  state: ImportRowState;
  work_id: string | null;
  edition_id: string | null;
  confidence: number | null;
  failure_reason: string | null;
  created_at: string;
}

export interface ImportRowsResponse {
  rows: ImportRowItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ResolveImportRowRequest {
  work_id: string;
  edition_id?: string;
}

// ---------------------------------------------------------------- Exports (IM-10)

export type ExportFormat = 'csv' | 'json';
export type ExportState = 'queued' | 'processing' | 'completed' | 'failed';

export interface ExportResponse {
  id: string;
  user_id: string;
  format: ExportFormat;
  state: ExportState;
  file_size_bytes?: number | null;
  /** Always null since audit 12: use getExportLink(). */
  download_url?: string | null;
  expires_at?: string | null;
  error?: string | null;
  created_at: string;
  finished_at?: string | null;
}

export interface ExportListResponse {
  exports: ExportResponse[];
}

export interface CreateExportRequest {
  format?: ExportFormat;
}

/** GET /v1/exports/:id/link: a storage URL for the owner, valid 5 minutes. */
export interface ExportLinkResponse {
  url: string;
  expires_at: string;
}

// ---------------------------------------------------------------- Blocking (SO-03)

export type BlockState = 'blocked' | 'unblocked';

export interface BlockResult {
  status: BlockState;
  blocker_id: string;
  blocked_id: string;
}

export interface BlockedUserItem {
  id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  blocked_at: string;
}

export interface BlockedUsersResponse {
  blocks: BlockedUserItem[];
}

// ---------------------------------------------------------------- Muting (SO-04)

export type MuteState = 'muted' | 'unmuted';
export type MuteTargetType = 'user' | 'work';

export interface MuteResult {
  status: MuteState;
  target_type: MuteTargetType;
  target_id: string;
  user_id: string;
}

export interface MutedUserItem {
  id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  muted_at: string;
}

export interface MutedWorkItem {
  id: string;
  title: string;
  author_name: string | null;
  cover_id: number | null;
  muted_at: string;
}

export interface MutesResponse {
  users: MutedUserItem[];
  works: MutedWorkItem[];
}

// ---------------------------------------------------------------- Followers / Following Lists (SO-05)

export interface FollowUserListItem {
  id: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
  isPrivate: boolean;
  followedByViewer: boolean;
  followsViewer: boolean;
  followedAt: string;
}

export interface FollowUserListResponse {
  users: FollowUserListItem[];
  total: number;
}

/** GET /v1/me/follow-suggestions (SO-52, PRD §6.11). */
export type FollowSuggestionReason = 'favourites' | 'genres' | 'reviewer' | 'popular';

export interface FollowSuggestion {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  follower_count: number;
  /** Up to four of their favourites, never an explicit book. */
  favourites: { id: string; title: string; cover_id: number | null }[];
  reason: FollowSuggestionReason;
}

export interface FollowSuggestionsResponse {
  users: FollowSuggestion[];
}




// ---------------------------------------------------------------- Notifications (SO-30 to SO-33)

/** reply: a comment in a thread you commented in (SO-4x). moderation: a decision about your content (PRD §27.6). */
export type NotificationType = 'follow' | 'follow_request' | 'like' | 'comment' | 'import_complete' | 'reply' | 'moderation';

export interface NotificationActor {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface NotificationItem {
  id: string;
  type: NotificationType;
  /** Composed by the server, the same words as the push. */
  text: string;
  /** flyleaf:// URL of the screen this opens. */
  deep_link: string;
  read: boolean;
  created_at: string;
  /** Moves when an aggregated row gains an actor; the list's sort key. */
  updated_at: string;
  /** The newest actor; null for system notifications (import complete). */
  actor: NotificationActor | null;
  actor_count: number;
  read_id: string | null;
  review_id: string | null;
  work_id: string | null;
  comment_id: string | null;
  import_id: string | null;
}

export interface NotificationsResponse {
  items: NotificationItem[];
  next_cursor: string | null;
  unread_count: number;
}

export interface UnreadCountResponse {
  /** Capped at 100: the badge shows "99+". */
  unread_count: number;
}

export type NotificationCategoryKey =
  | 'new_follower'
  | 'follow_request'
  | 'likes'
  | 'comments'
  | 'comment_replies'
  | 'mentions'
  | 'import_complete'
  | 'year_in_review'
  | 'invite_joined'
  | 'friend_finished_want'
  | 'author_new_book'
  | 'milestones'
  | 'weekly_summary';

export interface NotificationCategoryPreference {
  key: NotificationCategoryKey;
  /** null: the category has no push channel (PRD §19.2). */
  push: boolean | null;
  /** null: the category has no in-app channel. */
  in_app: boolean | null;
  /** Something sends this category today. */
  live: boolean;
}

export interface NotificationPreferences {
  push_enabled: boolean;
  categories: NotificationCategoryPreference[];
  quiet_hours: { enabled: boolean; start: string; end: string };
  timezone: string;
  reading_reminder: { enabled: boolean; time: string | null };
}

export interface UpdateNotificationPreferencesRequest {
  push_enabled?: boolean;
  categories?: Partial<Record<NotificationCategoryKey, { push?: boolean; in_app?: boolean }>>;
  quiet_hours?: { enabled?: boolean; start?: string; end?: string };
  timezone?: string;
  /** HH:MM local; null turns the reminder off. There is no default time. */
  reading_reminder?: { time: string | null };
}

export interface RegisterPushTokenRequest {
  token: string;
  platform: 'android' | 'ios';
  /** IANA zone of the device: quiet hours and the reminder are read in it. */
  timezone?: string;
}

// ---------------------------------------------------------------- Moderation (SO-40 to SO-42)

export type ReportSubjectType = 'review' | 'comment' | 'user' | 'shelf' | 'work';
/** PRD §6.44's reason picker. */
export type ReportReason = 'spam' | 'harassment' | 'hate_speech' | 'spoilers' | 'nsfw' | 'copyright' | 'fake_review' | 'other';
/** PRD §27.3: the rule a moderator applies. */
export type ModerationRule = 'spoilers' | 'spam' | 'harassment' | 'hate_speech' | 'fake_review' | 'impersonation' | 'vote_manipulation';

export interface CreateReportRequest {
  subject_type: ReportSubjectType;
  subject_id: string;
  reason: ReportReason;
  detail?: string | null;
}

export interface Report {
  id: string;
  subject_type: ReportSubjectType;
  subject_id: string;
  reason: ReportReason;
  /** PRD §27.6: open or reviewed, never the outcome for someone else. */
  status: 'open' | 'reviewed';
  created_at: string;
  reviewed_at: string | null;
}

export interface ReportResponse {
  report: Report;
}

export interface MyReportsResponse {
  reports: Report[];
}

export interface ModerationAppeal {
  /** upheld: the decision stands. overturned: it was reversed. */
  state: 'pending' | 'upheld' | 'overturned';
  body: string;
  appealed_at: string;
  resolved_at: string | null;
}

export interface ModerationNotice {
  id: string;
  subject_type: ReportSubjectType;
  subject_id: string;
  rule: ModerationRule;
  rule_label: string;
  summary: string;
  consequences: string[];
  created_at: string;
  reversed: boolean;
  can_appeal: boolean;
  appeal: ModerationAppeal | null;
}

export interface ModerationNoticesResponse {
  notices: ModerationNotice[];
}

export interface AdminModerationAction {
  id: string;
  subject_type: ReportSubjectType;
  subject_id: string;
  target_user_id: string | null;
  decision: 'dismiss' | 'enforce' | 'resolve';
  rule: ModerationRule | null;
  step: number | null;
  effects: Record<string, unknown>;
  reason: string;
  created_at: string;
  reversed_at: string | null;
  appeal: { state: string; body: string; appealed_at: string; resolved_at: string | null } | null;
}

export interface AdminReportCase {
  subject_type: ReportSubjectType;
  subject_id: string;
  owner: { id: string; username: string | null } | null;
  report_count: number;
  weight: number;
  first_reported_at: string;
  last_reported_at: string;
  reasons: string[];
  auto_rules: string[];
  snapshot: Record<string, unknown>;
}

export interface AdminReportQueueResponse {
  cases: AdminReportCase[];
  open_cases: number;
  pending_appeals: number;
}

export interface AdminReportCaseDetail {
  subject_type: ReportSubjectType;
  subject_id: string;
  subject: Record<string, unknown> | null;
  owner: {
    id: string; username: string | null; display_name: string | null; created_at: string;
    suspended_until: string | null; banned_at: string | null; deleted_at: string | null;
    ratings_excluded_at: string | null; review_flag_until: string | null;
  } | null;
  reports: Array<{
    id: string; source: string; auto_rule: string | null; reason: string; detail: string | null;
    snapshot: Record<string, unknown>; state: string; created_at: string; resolved_at: string | null;
    reporter: { id: string; username: string | null } | null; reporter_reputation: number | null;
  }>;
  open_reports: number;
  history: Array<{
    id: string; subject_type: string; subject_id: string; decision: string; rule: string | null; step: number | null;
    reason: string; created_at: string; reversed_at: string | null; appeal_state: string | null;
  }>;
  ladder: Array<{ rule: ModerationRule; label: string; strikes: number; step: number; consequences: string[]; needs_admin: boolean }>;
}

export interface AdminReportActionRequest {
  decision: 'dismiss' | 'enforce' | 'resolve';
  rule?: ModerationRule;
  /** At least 10 characters; kept in the audit log. */
  reason: string;
}

export interface AdminAppealsResponse {
  appeals: Array<AdminModerationAction & { owner: { id: string; username: string | null } | null; needs_admin: boolean }>;
}
