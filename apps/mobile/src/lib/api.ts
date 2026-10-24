// Mobile API client backed by @flyleaf/api-client (FN-80, FN-81, SL-03, SL-04).
//
// Features:
// 1. Dual-token storage in expo-secure-store (keychain/keystore).
// 2. 401 refresh interceptor with single-flight mutex.
// 3. client_event_id on all progress writes for offline idempotency.

import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { createAuthFetch } from './authFetch';
import { resolveApiBase, resolvePublicBase } from './apiBase';
import { PUBLIC_BASE_URL } from './followSuggestions';
import { getSessionId } from './events';

import {
  FlyleafClient,
  FlyleafApiError,
  type User,
  type ShareCard,
  type Profile,
  type Edition,
  type EditionDetail,
  type EditionLookupResponse,
  type YourRead,
  type Work,
  type Read,
  type ReadStatus,
  type AuthResponse,
  type RefreshResponse,
  type Review,
  type CreateReviewRequest,
  type UpdateReviewRequest,
  type WorkReviewsResponse,
  type ProfileFavourite,
  type UpdateProfileRequest,
  type MonthlyPaceItem,
  type ExtremeBook,
  type MostReadAuthor,
  type ReadingStats,
  type GoalResponse,
  type TelemetryEvent,
  type PostEventsResponse,
  type BudgetMetricsResponse,
  type Shelf,
  type ShelfOwner,
  type ShelfPrivacy,
  type CreateShelfRequest,
  type UpdateShelfRequest,
  type ShelfResponse,
  type DeleteShelfResponse,
  type ShelfItem,
  type ShelfItemWork,
  type ShelfItemsResponse,
  type AddShelfItemRequest,
  type ShelfWithWorkState,
  type MyShelvesResponse,
  type DeleteShelfItemResponse,
  type UpdateShelfItemRequest,
  type ReorderShelfRequest,
  type ReorderShelfResponse,
  type SaveShelfResponse,
  type SavedShelvesResponse,
  type BrowseShelvesQuery,
  type BrowseShelvesResponse,
  type UserShelvesResponse,
  type ImportSource,
  type ImportResponse,
  type ImportListResponse,
  type CreateImportRequest,
  type UploadFileOptions,
  type UploadResponse,
  type ImportRowState,
  type ImportRowItem,
  type ImportRowsResponse,
  type ResolveImportRowRequest,
  type ExportFormat,
  type ExportState,
  type ExportResponse,
  type ExportListResponse,
  type CreateExportRequest,
  type UpdateNotificationPreferencesRequest,
  type CreateReportRequest,
  type RegisterPushTokenRequest,
  type FollowResult,
  type PendingFollowRequest,
  type PendingFollowRequestsResponse,
  type BlockState,
  type BlockResult,
  type BlockedUserItem,
  type BlockedUsersResponse,
  type MuteState,
  type MuteTargetType,
  type MuteResult,
  type MutedUserItem,
  type MutedWorkItem,
  type MutesResponse,
  type FollowUserListItem,
  type FollowUserListResponse,
  type FollowSuggestion,
  type FollowSuggestionsResponse,
} from '@flyleaf/api-client';

export type {
  AuthorDetail,
  SeriesDetail,
  ReadComment,
  ReadCommentsResponse,
  ReadLikersResponse,
  LikeResponse,
  FeedResponse,
  FeedItem,
  NotificationItem,
  NotificationsResponse,
  NotificationPreferences,
  Report,
  ReportReason,
  ReportSubjectType,
  ModerationNotice,
} from '@flyleaf/api-client';
export type {
  User,
  Profile,
  ProfileFavourite,
  UpdateProfileRequest,
  MonthlyPaceItem,
  ExtremeBook,
  MostReadAuthor,
  ReadingStats,
  GoalResponse,
  TelemetryEvent,
  PostEventsResponse,
  BudgetMetricsResponse,
  Shelf,
  ShelfOwner,
  ShelfPrivacy,
  CreateShelfRequest,
  UpdateShelfRequest,
  ShelfResponse,
  DeleteShelfResponse,
  ShelfItem,
  ShelfItemWork,
  ShelfItemsResponse,
  AddShelfItemRequest,
  ShelfWithWorkState,
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
  ImportSource,
  ImportResponse,
  ImportListResponse,
  CreateImportRequest,
  UploadFileOptions,
  UploadResponse,
  ImportRowState,
  ImportRowItem,
  ImportRowsResponse,
  ResolveImportRowRequest,
  ExportFormat,
  ExportState,
  ExportResponse,
  ExportListResponse,
  CreateExportRequest,
  FollowResult,
  PendingFollowRequest,
  PendingFollowRequestsResponse,
  BlockState,
  BlockResult,
  BlockedUserItem,
  BlockedUsersResponse,
  MuteState,
  MuteTargetType,
  MuteResult,
  MutedUserItem,
  MutedWorkItem,
  MutesResponse,
  FollowUserListItem,
  FollowUserListResponse,
  FollowSuggestion,
  FollowSuggestionsResponse,
  Edition,
  EditionDetail,
  EditionLookupResponse,
  YourRead,
  Work,
  Read,
  ReadStatus,
  AuthResponse,
  RefreshResponse,
  Review,
  CreateReviewRequest,
  UpdateReviewRequest,
  WorkReviewsResponse,
};
export { FlyleafApiError, FlyleafApiError as ApiError };

const CONFIGURED_API_URL = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;

function resolveBase(): string {
  return resolveApiBase({
    apiUrl: CONFIGURED_API_URL,
    hostUri: Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost,
    isDev: __DEV__,
  });
}

export const BASE_URL: string = resolveBase();
export const API_BASE = `${BASE_URL}/v1`;
/** Where shared links point: the server this build talks to, else production. */
export const PUBLIC_BASE: string = resolvePublicBase(CONFIGURED_API_URL, PUBLIC_BASE_URL);

const ACCESS_TOKEN_KEY = 'flyleaf.access_token';
const REFRESH_TOKEN_KEY = 'flyleaf.refresh_token';
// Legacy key for backwards compatibility
const LEGACY_TOKEN_KEY = 'flyleaf.token';

// ---------------------------------------------------------------- Storage
export async function saveTokens(accessToken: string, refreshToken?: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken);
  await SecureStore.setItemAsync(LEGACY_TOKEN_KEY, accessToken);
  if (refreshToken) {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
  }
}

export async function loadAccessToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
  if (token) return token;
  return SecureStore.getItemAsync(LEGACY_TOKEN_KEY);
}

export async function loadRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function clearAllTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(SESSION_USER_KEY).catch(() => {}),
  ]);
}

// Backwards-compatible aliases
export const saveToken = (t: string) => saveTokens(t);
export const loadToken = () => loadAccessToken();
export const clearToken = () => clearAllTokens();

// The signed-in user, so a cold start with no network keeps the session
// (PRD §6.1: "Network failure → route to Home in cached/offline mode").
const SESSION_USER_KEY = 'flyleaf.session_user';

export async function saveSessionUser(user: User): Promise<void> {
  await SecureStore.setItemAsync(SESSION_USER_KEY, JSON.stringify(user));
}

export async function loadSessionUser(): Promise<User | null> {
  const raw = await SecureStore.getItemAsync(SESSION_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 401 Refresh Interceptor
type AuthListener = (user: User | null) => void;
const authListeners = new Set<AuthListener>();

export function subscribeAuthChange(listener: AuthListener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function notifyAuthFailed() {
  // Uploads in flight belong to the session that just ended (PV-03).
  client.cancelPendingUploads();
  for (const listener of authListeners) {
    listener(null);
  }
}

// Single-flight, and only a refused refresh token ends the session (authFetch.ts).
const interceptedFetch = createAuthFetch({
  fetch: (input, init) => fetch(input, init),
  refreshUrl: `${API_BASE}/auth/refresh`,
  loadAccessToken,
  loadRefreshToken,
  saveTokens,
  clearTokens: clearAllTokens,
  onSessionEnded: notifyAuthFailed,
});

// 403 email_unverified from any call (review, comment, follow; A-05-011) opens
// the "verify your email" prompt, wherever the call was made from.
const unverifiedListeners = new Set<() => void>();

export function subscribeEmailUnverified(listener: () => void): () => void {
  unverifiedListeners.add(listener);
  return () => unverifiedListeners.delete(listener);
}

const apiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await interceptedFetch(input, init);
  if (res.status === 403) {
    void res
      .clone()
      .json()
      .then((body: { error?: { code?: string } }) => {
        if (body?.error?.code === 'email_unverified') unverifiedListeners.forEach((l) => l());
      })
      .catch(() => {});
  }
  return res;
}) as typeof fetch;

// ---------------------------------------------------------------- FlyleafClient
export const client = new FlyleafClient({
  baseUrl: API_BASE,
  getToken: loadAccessToken,
  fetch: apiFetch,
  // Direct uploads go to object storage with the plain fetch: the
  // interceptor above re-sends a 401 with the bearer token (PV-03).
  uploadFetch: fetch,
});

// ---------------------------------------------------------------- API Service
export const api = {
  client,

  register: async (
    email: string,
    username: string,
    password: string,
    dateOfBirth: string,
  ) => {
    const r = await client.register({ email, username, password, dateOfBirth });
    await saveTokens(r.accessToken, r.refreshToken);
    return { user: r.user, token: r.accessToken, refreshToken: r.refreshToken };
  },

  login: async (email: string, password: string) => {
    const r = await client.login({ email, password });
    await saveTokens(r.accessToken, r.refreshToken);
    return { user: r.user, token: r.accessToken, refreshToken: r.refreshToken, restored: r.restored === true };
  },

  logout: async () => {
    // An upload started by this user must not be completed by the next one.
    client.cancelPendingUploads();
    try {
      // This device must stop receiving this user's pushes (SO-30). While the
      // session still holds a token, so the call is authorised.
      for (const hook of beforeLogout) {
        try {
          await hook();
        } catch {
          // Best-effort, like the server call below.
        }
      }
      const refreshToken = await loadRefreshToken();
      if (refreshToken) await client.logout({ refreshToken });
    } catch {
      // Best-effort server notification
    } finally {
      // Whatever happened above, this device holds no token afterwards.
      await clearAllTokens();
      notifyAuthFailed();
    }
  },

  me: () => client.getMe(),
  // LA-01: the server ends every session; the screen then signs out here.
  deleteAccount: (password: string) => client.deleteAccount(password),
  confirmDateOfBirth: (dateOfBirth: string) => client.confirmDateOfBirth(dateOfBirth),
  setContentSettings: (data: { showExplicit: boolean; dateOfBirth?: string }) => client.setContentSettings(data),
  myProfile: () => client.getMyProfile(),
  updateProfile: (data: UpdateProfileRequest) => client.updateProfile(data),
  userProfile: (userId: string) => client.getUserProfile(userId),
  userByUsername: (username: string) => client.getUserByUsername(username),
  myStats: (year?: string, tz?: string) => client.getMyStats(year, tz),
  userStats: (userId: string, year?: string, tz?: string) => client.getUserStats(userId, year, tz),
  // ST-05 goals: the profile ring only (PRD §8.6).
  myGoal: (year?: number, tz?: string) => client.getMyGoal(year, tz),
  userGoal: (userId: string, year?: number, tz?: string) => client.getUserGoal(userId, year, tz),
  setMyGoal: (goal: { year: number; target_books: number; target_pages?: number | null }, tz?: string) => client.setMyGoal(goal, tz),
  deleteMyGoal: (year: number) => client.deleteMyGoal(year),
  // ST-04 / ST-09 share cards (the preview fetches the PNG), ST-09 Year in Review, ST-10 milestones.
  shareCard: (card: ShareCard) => client.getShareCard(card),
  yearInReview: (year?: number, tz?: string) => client.getYearInReview(year, tz),
  milestones: (readId?: string) => client.getMilestones(readId),
  markMilestonesSeen: (keys: string[]) => client.markMilestonesSeen(keys),

  // The telemetry session id rides along for the zero-result summary (D-10-3).
  search: (q: string) => client.search(q, 20, getSessionId()),
  searchWithSuggestion: (q: string) => client.searchWithSuggestion(q, 20, getSessionId()),

  work: (id: string) => client.getWork(id),

  reads: (status?: string) => client.getReads(status as ReadStatus | undefined),

  /**
   * Another user's reads the viewer may see (GET /users/:id/reads), every
   * page up to `max` (audit 10: the Wall filters on the device). The server
   * applies privacy; this only pages.
   */
  userReads: async (userId: string, status?: ReadStatus, max = 3000) => {
    const all: Awaited<ReturnType<typeof client.getUserReads>>['data'] = [];
    let cursor: string | undefined;
    do {
      const page = await client.getUserReads(userId, { status, cursor, limit: 100 });
      all.push(...page.data);
      cursor = page.next_cursor ?? undefined;
    } while (cursor && all.length < max);
    return all;
  },

  setStatus: (
    workId: string,
    status: string,
    rating?: number | null,
    hearted?: boolean,
    extra?: { edition_id?: string; format_override?: string; started_at?: string; clear_rating?: boolean; if_absent?: boolean },
  ) =>
    client.createRead({
      work_id: workId,
      status: status as ReadStatus,
      rating: rating ?? null,
      hearted: hearted ?? null,
      edition_id: extra?.edition_id ?? null,
      format_override: extra?.format_override ?? null,
      started_at: extra?.started_at ?? null,
      // rating: null means "unchanged"; removing a rating is explicit (PRD §9.3).
      ...(extra?.clear_rating ? { clear_rating: true } : {}),
      // The feed's want-to-read swipe: never overwrite a read (D-11-1).
      ...(extra?.if_absent ? { if_absent: true } : {}),
    }),

  addProgress: (
    readId: string,
    page: number | null,
    percent: number | null,
    minutes?: number | null,
    note?: string | null,
    audioSeconds?: number | null,
  ) =>
    client.addProgress(readId, {
      client_event_id: Crypto.randomUUID(),
      page: page ?? null,
      percent: percent ?? null,
      minutes: minutes ?? null,
      note: note ?? null,
      audio_seconds: audioSeconds ?? null,
    }),

  finishRead: (
    readId: string,
    data: {
      finished_at?: string | null;
      rating?: number | null;
      hearted?: boolean | null;
      format_override?: string | null;
      visibility?: any;
    },
  ) => client.finishRead(readId, data),

  dnfRead: (
    readId: string,
    data: {
      abandoned_page?: number | null;
      dnf_reason?: string | null;
      note?: string | null;
      rating?: number | null;
      visibility?: any;
    },
  ) => client.dnfRead(readId, data),

  forgotPassword: (email: string) => client.forgotPassword({ email }),

  resetPassword: (token: string, newPassword: string) =>
    client.resetPassword({ token, newPassword }),

  verifyEmail: (token: string) => client.verifyEmail({ token }),

  resendVerification: () => client.resendVerification(),

  checkUsername: (username: string, signal?: AbortSignal) => client.checkUsername(username, { signal }),

  lookupIsbn: (isbn: string) => client.getEditionByIsbn(isbn),
  reviews: (workId: string, options?: { sort?: 'friends' | 'likes' | 'newest' | 'highest' | 'lowest'; rating?: number; limit?: number; offset?: number }) =>
    client.getWorkReviews(workId, options),
  review: (id: string) => client.getReview(id),
  createReview: (readId: string, payload: CreateReviewRequest) => client.createReview(readId, payload),
  updateReview: (id: string, payload: UpdateReviewRequest) => client.updateReview(id, payload),
  deleteReview: (id: string) => client.deleteReview(id),
  // Likes & comments target the READ (SO-21/22). Pass the state you want —
  // never a flip, which the offline queue could replay into an unlike.
  likeRead: (readId: string) => client.likeRead(readId),
  unlikeRead: (readId: string) => client.unlikeRead(readId),
  setLiked: (readId: string, liked: boolean) => client.setLiked(readId, liked),
  getReadLikes: (readId: string, params?: { limit?: number; offset?: number }) =>
    client.getReadLikes(readId, params),
  getReadComments: (readId: string, params?: { cursor?: string; limit?: number }) =>
    client.getReadComments(readId, params),
  addReadComment: (readId: string, body: string) => client.addReadComment(readId, body),
  deleteComment: (commentId: string) => client.deleteComment(commentId),

  // SL-43 (audit 08): the real endpoints. The author page used to search
  // for the author's NAME as a title and invent a bio and books; the series
  // page was hard-coded.
  author: (id: string, params?: { limit?: number; offset?: number }) => client.getAuthor(id, params),
  series: (id: string) => client.getSeries(id),

  postEvents: (events: TelemetryEvent[]) => client.postEvents(events),
  getBudgetMetrics: () => client.getBudgetMetrics(),

  // Shelves (SH-01, SH-02, SH-03)
  createShelf: (data: CreateShelfRequest) => client.createShelf(data),
  getShelf: (id: string) => client.getShelf(id),
  updateShelf: (id: string, data: UpdateShelfRequest) => client.updateShelf(id, data),
  deleteShelf: (id: string) => client.deleteShelf(id),
  getShelfItems: (id: string, params?: { limit?: number; offset?: number }) =>
    client.getShelfItems(id, params),
  addShelfItem: (id: string, data: AddShelfItemRequest) => client.addShelfItem(id, data),
  getMyShelves: (params?: { work_id?: string }) => client.getMyShelves(params),
  removeShelfItem: (shelfId: string, workId: string) => client.removeShelfItem(shelfId, workId),
  updateShelfItem: (shelfId: string, workId: string, data: UpdateShelfItemRequest) =>
    client.updateShelfItem(shelfId, workId, data),
  reorderShelf: (id: string, data: ReorderShelfRequest) => client.reorderShelf(id, data),
  saveShelf: (id: string) => client.saveShelf(id),
  unsaveShelf: (id: string) => client.unsaveShelf(id),
  getSavedShelves: (params?: { limit?: number; offset?: number }) => client.getSavedShelves(params),
  getDeletedShelves: () => client.getDeletedShelves(),
  restoreShelf: (id: string) => client.restoreShelf(id),
  browseShelves: (params?: BrowseShelvesQuery) => client.browseShelves(params),
  getUserShelves: (userId: string) => client.getUserShelves(userId),
  getShelfBySlug: (username: string, slug: string) => client.getShelfBySlug(username, slug),

  // Imports (IM-02, IM-08, IM-09, IM-11)
  // Presigned: intent -> straight to storage -> complete (PV-02, PV-03).
  uploadFile: (file: string | Blob | Uint8Array | ArrayBuffer, options: UploadFileOptions) =>
    client.uploadFile('import', file, options),

  // Avatar (audit 10, A-07-032): the same presigned path, purpose 'avatar'.
  uploadAvatar: async (jpeg: Uint8Array) => {
    const upload = await client.uploadFile('avatar', jpeg, { contentType: 'image/jpeg', filename: 'avatar.jpg' });
    return client.setAvatar(upload.id);
  },
  removeAvatar: () => client.removeAvatar(),
  createImport: (data: CreateImportRequest) => client.createImport(data),
  getImport: (id: string) => client.getImport(id),
  listImports: () => client.listImports(),
  getImportRows: (
    id: string,
    params?: { state?: ImportRowState; limit?: number; offset?: number },
  ) => client.getImportRows(id, params),
  resolveImportRow: (id: string, rowNo: number, data: ResolveImportRowRequest) =>
    client.resolveImportRow(id, rowNo, data),
  skipImportRow: (id: string, rowNo: number) => client.skipImportRow(id, rowNo),

  // Exports (IM-10)
  requestExport: (data?: CreateExportRequest) => client.requestExport(data),
  getExport: (id: string) => client.getExport(id),
  listExports: () => client.listExports(),
  getExportLink: (id: string) => client.getExportLink(id),

  // Social & Follows (SO-01, SO-02)
  followUser: (userId: string) => client.followUser(userId),
  /** SO-52: readers to follow during onboarding (PRD §6.11). */
  followSuggestions: (limit?: number) => client.getFollowSuggestions(limit === undefined ? undefined : { limit }),
  unfollowUser: (userId: string) => client.unfollowUser(userId),
  getPendingFollowRequests: () => client.getPendingFollowRequests(),
  acceptFollowRequest: (requesterId: string) => client.acceptFollowRequest(requesterId),
  rejectFollowRequest: (requesterId: string) => client.rejectFollowRequest(requesterId),

  // Blocking (SO-03)
  blockUser: (userId: string) => client.blockUser(userId),
  unblockUser: (userId: string) => client.unblockUser(userId),
  getBlockedUsers: () => client.getBlockedUsers(),

  // Muting (SO-04)
  muteUser: (userId: string) => client.muteUser(userId),
  unmuteUser: (userId: string) => client.unmuteUser(userId),
  muteWork: (workId: string) => client.muteWork(workId),
  unmuteWork: (workId: string) => client.unmuteWork(workId),
  getMutes: () => client.getMutes(),

  // Followers & Following Lists (SO-05)
  getFollowers: (userId: string, query?: { limit?: number; offset?: number }) =>
    client.getFollowers(userId, query),
  getFollowing: (userId: string, query?: { limit?: number; offset?: number }) =>
    client.getFollowing(userId, query),

  // Notifications (SO-30 to SO-33)
  getNotifications: (params?: { cursor?: string; limit?: number }) => client.getNotifications(params),
  getUnreadNotificationCount: () => client.getUnreadNotificationCount(),
  markNotificationsRead: (ids?: string[]) => client.markNotificationsRead(ids),
  getNotificationPreferences: () => client.getNotificationPreferences(),
  updateNotificationPreferences: (data: UpdateNotificationPreferencesRequest) => client.updateNotificationPreferences(data),
  registerPushToken: (data: RegisterPushTokenRequest) => client.registerPushToken(data),
  unregisterPushToken: (token: string) => client.unregisterPushToken(token),

  // Moderation (SO-40, SO-42)
  createReport: (data: CreateReportRequest) => client.createReport(data),
  getMyReports: (params?: { limit?: number; offset?: number }) => client.getMyReports(params),
  getModerationNotices: () => client.getModerationNotices(),
  getModerationNotice: (id: string) => client.getModerationNotice(id),
  appealModeration: (id: string, body: string) => client.appealModeration(id, body),
};

/** Run by api.logout() before the session ends (push token removal, SO-30). */
const beforeLogout: Array<() => Promise<void>> = [];
export function onBeforeLogout(hook: () => Promise<void>): () => void {
  beforeLogout.push(hook);
  return () => {
    const i = beforeLogout.indexOf(hook);
    if (i >= 0) beforeLogout.splice(i, 1);
  };
}

