import type { components, operations } from "./generated";
import type { ApiClient, ApiSuccess } from "./client";

export type CollectionPermission =
  components["schemas"]["Collection"]["effectivePermissions"][number];
export type LessonSummary =
  components["schemas"]["PaginatedLessons"]["items"][number];
export type LessonRecord = components["schemas"]["Lesson"];
export type RoleCreateInput =
  operations["createCollectionRole"]["requestBody"]["content"]["application/json"];
export type RoleUpdateInput =
  operations["updateCollectionRole"]["requestBody"]["content"]["application/json"];
export type CollectionProfileUpdateInput =
  operations["updateCollectionProfile"]["requestBody"]["content"]["application/json"];
export type InviteCreateInput =
  operations["createCollectionInvite"]["requestBody"]["content"]["application/json"];

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CollectionMember {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarAssetId: string | null;
  bio: string | null;
  profileRevision: number;
  joinedAt: string;
  isOwner: boolean;
  roleIds: string[];
  collectionProfile?: {
    displayName: string | null;
    avatarAssetId: string | null;
    bio: string | null;
    revision: number;
  } | null;
}

export interface CollectionProfile {
  collectionId: string;
  userId: string;
  displayName: string | null;
  avatarAssetId: string | null;
  bio: string | null;
  revision: number;
  updatedAt: string;
}

export interface CollectionRole {
  id: string;
  collectionId: string;
  name: string;
  color: string | null;
  permissions: CollectionPermission[];
  securityRank: number;
  isManaged: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionInvite {
  id: string;
  collectionId: string;
  tokenHint: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  usesCount: number;
  revokedAt: string | null;
  revision: number;
  roleIds: string[];
  createdAt: string;
}

export interface CreatedCollectionInvite extends CollectionInvite {
  token: string | null;
}

export interface InvitePreview {
  inviteId: string;
  collection: {
    id: string;
    name: string;
    description: string | null;
  };
  expiresAt: string | null;
  remainingUses: number | null;
}

export type InviteAcceptance = components["schemas"]["Collection"];

export interface CollectionAuditEvent {
  id: number;
  collectionId: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ProgressAttempt {
  eventId?: string;
  attemptId?: string;
  questionId?: string;
  attemptNumber?: number;
  answer?: unknown;
  outcome?: "correct" | "incorrect" | "skipped";
  status?: "correct" | "partial" | "incorrect";
  score?: number | null;
  firstTry?: boolean;
  transcript?: string | null;
  evaluationSource?: "client_extension" | "server_rule";
  answeredAt?: string;
}

export interface MemberProgress {
  id: string;
  lessonId: string;
  collectionId: string;
  userId: string;
  languageCode: string;
  status: "in_progress" | "completed";
  summary: Record<string, unknown>;
  attempts?: ProgressAttempt[];
  revision: number;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface LanguageStats {
  collectionId?: string;
  userId: string;
  languageCode: string;
  words: Record<string, unknown>;
  phrases: Record<string, unknown>;
  sentences: Record<string, unknown>;
  aggregate: Record<string, unknown>;
  revision: number;
  updatedAt: string | null;
}

function pagePath(
  path: string,
  cursor: string | null = null,
  extra: Readonly<Record<string, string | undefined>> = {},
): string {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) query.set(key, value);
  }
  return `${path}?${query.toString()}`;
}

export function listCollectionMembers(
  api: ApiClient,
  collectionId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<ApiSuccess<CursorPage<CollectionMember>>> {
  return api.get(
    pagePath(`/v1/collections/${encodeURIComponent(collectionId)}/members`, cursor),
    signal,
  );
}

export function removeCollectionMember(
  api: ApiClient,
  collectionId: string,
  userId: string,
): Promise<ApiSuccess<{ removed: boolean; userId: string }>> {
  return api.delete(
    `/v1/collections/${encodeURIComponent(collectionId)}/members/${encodeURIComponent(userId)}`,
  );
}

export function transferCollectionOwnership(
  api: ApiClient,
  collectionId: string,
  newOwnerId: string,
  expectedRevision: number,
): Promise<ApiSuccess<components["schemas"]["Collection"]>> {
  return api.post(
    `/v1/collections/${encodeURIComponent(collectionId)}/transfer`,
    { newOwnerId, expectedRevision },
  );
}

export function leaveCollection(
  api: ApiClient,
  collectionId: string,
): Promise<ApiSuccess<{ left: boolean }>> {
  return api.post(
    `/v1/collections/${encodeURIComponent(collectionId)}/leave`,
  );
}

export function updateCollectionProfile(
  api: ApiClient,
  collectionId: string,
  input: CollectionProfileUpdateInput,
): Promise<ApiSuccess<CollectionProfile>> {
  return api.put(
    `/v1/collections/${encodeURIComponent(collectionId)}/profile`,
    input,
  );
}

export function listCollectionRoles(
  api: ApiClient,
  collectionId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<ApiSuccess<CursorPage<CollectionRole>>> {
  return api.get(
    pagePath(`/v1/collections/${encodeURIComponent(collectionId)}/roles`, cursor),
    signal,
  );
}

export function createCollectionRole(
  api: ApiClient,
  collectionId: string,
  input: RoleCreateInput,
): Promise<ApiSuccess<CollectionRole>> {
  return api.post(
    `/v1/collections/${encodeURIComponent(collectionId)}/roles`,
    input,
    crypto.randomUUID(),
  );
}

export function updateCollectionRole(
  api: ApiClient,
  collectionId: string,
  roleId: string,
  input: RoleUpdateInput,
): Promise<ApiSuccess<CollectionRole>> {
  return api.patch(
    `/v1/collections/${encodeURIComponent(collectionId)}/roles/${encodeURIComponent(roleId)}`,
    input,
  );
}

export function deleteCollectionRole(
  api: ApiClient,
  collectionId: string,
  roleId: string,
): Promise<ApiSuccess<{ deleted: boolean; roleId: string }>> {
  return api.delete(
    `/v1/collections/${encodeURIComponent(collectionId)}/roles/${encodeURIComponent(roleId)}`,
  );
}

export function assignCollectionRole(
  api: ApiClient,
  collectionId: string,
  roleId: string,
  userId: string,
): Promise<ApiSuccess<{ assigned: true; roleId: string; userId: string }>> {
  return api.post(
    `/v1/collections/${encodeURIComponent(collectionId)}/roles/${encodeURIComponent(roleId)}/members`,
    { userId },
  );
}

export function unassignCollectionRole(
  api: ApiClient,
  collectionId: string,
  roleId: string,
  userId: string,
): Promise<ApiSuccess<{ assigned: false; roleId: string; userId: string }>> {
  return api.delete(
    `/v1/collections/${encodeURIComponent(collectionId)}/roles/${encodeURIComponent(roleId)}/members/${encodeURIComponent(userId)}`,
  );
}

export function listCollectionInvites(
  api: ApiClient,
  collectionId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<ApiSuccess<CursorPage<CollectionInvite>>> {
  return api.get(
    pagePath(`/v1/collections/${encodeURIComponent(collectionId)}/invites`, cursor),
    signal,
  );
}

export function createCollectionInvite(
  api: ApiClient,
  collectionId: string,
  input: InviteCreateInput,
): Promise<ApiSuccess<CreatedCollectionInvite>> {
  return api.post(
    `/v1/collections/${encodeURIComponent(collectionId)}/invites`,
    input,
    crypto.randomUUID(),
  );
}

export function revokeCollectionInvite(
  api: ApiClient,
  collectionId: string,
  inviteId: string,
): Promise<ApiSuccess<CollectionInvite>> {
  return api.delete(
    `/v1/collections/${encodeURIComponent(collectionId)}/invites/${encodeURIComponent(inviteId)}`,
  );
}

export function previewCollectionInvite(
  api: ApiClient,
  token: string,
  turnstileToken: string,
): Promise<ApiSuccess<InvitePreview>> {
  return api.request("/v1/invites/preview", {
    method: "POST",
    headers: { "x-turnstile-token": turnstileToken },
    body: { token },
  });
}

export function acceptCollectionInvite(
  api: ApiClient,
  token: string,
  turnstileToken: string,
): Promise<ApiSuccess<InviteAcceptance>> {
  return api.request("/v1/invites/accept", {
    method: "POST",
    headers: { "x-turnstile-token": turnstileToken },
    idempotencyKey: crypto.randomUUID(),
    body: { token },
  });
}

export function listCollectionAudit(
  api: ApiClient,
  collectionId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<ApiSuccess<CursorPage<CollectionAuditEvent>>> {
  return api.get(
    pagePath(`/v1/collections/${encodeURIComponent(collectionId)}/audit`, cursor),
    signal,
  );
}

export function listCollectionLessons(
  api: ApiClient,
  collectionId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<ApiSuccess<CursorPage<LessonSummary>>> {
  return api.get(
    pagePath("/v1/lessons", cursor, { collectionId }),
    signal,
  );
}

export function publishLesson(
  api: ApiClient,
  lessonId: string,
  expectedRevision: number,
): Promise<ApiSuccess<LessonRecord>> {
  return api.post(
    `/v1/lessons/${encodeURIComponent(lessonId)}/publish`,
    { expectedRevision },
  );
}

export function unpublishLesson(
  api: ApiClient,
  lessonId: string,
  expectedRevision: number,
): Promise<ApiSuccess<LessonRecord>> {
  return api.post(
    `/v1/lessons/${encodeURIComponent(lessonId)}/unpublish`,
    { expectedRevision },
  );
}

export function listMemberProgress(
  api: ApiClient,
  collectionId: string,
  userId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<ApiSuccess<CursorPage<MemberProgress>>> {
  return api.get(
    pagePath("/v1/progress", cursor, { collectionId, userId }),
    signal,
  );
}

export function getProgressDetail(
  api: ApiClient,
  progressId: string,
  signal?: AbortSignal,
): Promise<ApiSuccess<MemberProgress>> {
  return api.get(
    `/v1/progress/${encodeURIComponent(progressId)}`,
    signal,
  );
}

export function getCollectionMemberLanguageStats(
  api: ApiClient,
  collectionId: string,
  userId: string,
  languageCode: string,
  signal?: AbortSignal,
): Promise<ApiSuccess<LanguageStats>> {
  const query = new URLSearchParams({ languageCode, userId });
  return api.get(
    `/v1/collections/${encodeURIComponent(collectionId)}/stats?${query.toString()}`,
    signal,
  );
}
