import { z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppBindings } from "../app-types";
import type { RpcOperation } from "../db/repository";
import { normalizeStudyList } from "../domain/normalize";
import { ApiError } from "../http/errors";
import {
  AccountDeletionCancelledSchema,
  AccountDeletionPendingSchema,
  AccountDeletionRequestSchema,
  AssetParamSchema,
  CharacterProgressUpdateSchema,
  CharacterProgressSchema,
  CollectionCreateSchema,
  CollectionInviteParamSchema,
  CollectionInviteSchema,
  CollectionLeaveResultSchema,
  CollectionMemberParamSchema,
  CollectionMemberRemovalSchema,
  CollectionParamSchema,
  CollectionProfileSchema,
  CollectionProfileUpdateSchema,
  CollectionRoleAssignmentSchema,
  CollectionRoleDeletionSchema,
  CollectionRoleParamSchema,
  CollectionRoleSchema,
  CollectionSchema,
  CreatedCollectionInviteSchema,
  ErrorSchema,
  ExpectedRevisionSchema,
  FileAssetMetadataSchema,
  FileDeletionSchema,
  FileDownloadAuthorizationSchema,
  FileInitializeSchema,
  FileUploadInitializeResponseSchema,
  IdempotencyHeaderSchema,
  InviteAcceptSchema,
  InviteCreateSchema,
  InvitePreviewSchema,
  LanguageCodeSchema,
  LanguageStatsSchema,
  LessonCreateSchema,
  LessonCreateDocumentSchema,
  LessonDocumentSchema,
  LessonParamSchema,
  LessonSchema,
  MeSchema,
  PaginatedCollectionAuditSchema,
  PaginatedCollectionInvitesSchema,
  PaginatedCollectionMembersSchema,
  PaginatedCollectionRolesSchema,
  PaginatedCollectionsSchema,
  PaginatedLessonsSchema,
  PaginatedProgressSchema,
  PaginatedUnitRevisionsSchema,
  PaginatedUnitsSchema,
  PaginationQuerySchema,
  ProfileSchema,
  ProfileUpdateSchema,
  ProgressBatchSchema,
  ProgressBatchResultSchema,
  ProgressDetailSchema,
  ProgressParamSchema,
  ProgressSessionSchema,
  RoleInputSchema,
  SettingsQuerySchema,
  SettingRecordSchema,
  SettingsListSchema,
  SettingsUpsertSchema,
  SettingDeletionSchema,
  ThemeSettingSchema,
  TurnstileHeaderSchema,
  UnitCreateSchema,
  UnitRevisionParamSchema,
  UnitSchema,
  UnitUpdateSchema,
  UsernameAvailabilityQuerySchema,
  UsernameAvailabilityResponseSchema,
  UsernameChangeResponseSchema,
  UsernameSchema,
  UserSettingsSchema,
  UuidSchema,
  successSchema,
} from "../http/schemas";
import { FileService } from "../storage/r2";
import { asJsonObject, type Actor, type JsonObject, type JsonValue } from "../types";

type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
type Schema = z.ZodType;
type ObjectSchema = z.ZodObject;

interface EndpointInput {
  readonly actor: Actor;
  readonly context: Context<AppBindings>;
  readonly input: JsonObject;
}

interface PreparedEndpointInput {
  readonly rpcInput: JsonObject;
  readonly responseContext?: JsonObject;
}

interface RpcEndpoint {
  readonly method: HttpMethod;
  readonly path: string;
  readonly documentPath?: string;
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly operation: RpcOperation;
  readonly params?: ObjectSchema;
  readonly query?: ObjectSchema;
  readonly body?: ObjectSchema;
  readonly documentBody?: ObjectSchema;
  readonly headers?: ObjectSchema;
  readonly response: Schema;
  readonly documentResponse?: Schema;
  readonly prepare?: (
    input: EndpointInput,
  ) => PreparedEndpointInput | Promise<PreparedEndpointInput>;
  readonly decorate?: (result: JsonValue, context: JsonObject) => JsonValue;
}

const CollectionTransferSchema = z.object({
  newOwnerId: UuidSchema,
  expectedRevision: z.number().int().nonnegative(),
});
const RoleAssignmentSchema = z.object({ userId: UuidSchema });
const RoleUpdateSchema = RoleInputSchema.partial()
  .extend({ expectedRevision: z.number().int().nonnegative() })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.color !== undefined ||
      value.permissions !== undefined ||
      value.securityRank !== undefined,
    "At least one role field is required",
  );
const LessonListQuerySchema = PaginationQuerySchema.extend({
  collectionId: UuidSchema.optional(),
  unitId: UuidSchema.optional(),
  status: z.enum(["draft", "published"]).optional(),
});
const QueryBooleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());
const CollectionListQuerySchema = PaginationQuerySchema.extend({
  includeDeleted: QueryBooleanSchema.optional(),
});
const UnitListQuerySchema = PaginationQuerySchema.extend({
  includeDeleted: QueryBooleanSchema.default(false),
});
const ProgressHistoryQuerySchema = PaginationQuerySchema.extend({
  lessonId: UuidSchema.optional(),
  collectionId: UuidSchema.optional(),
  userId: UuidSchema.optional(),
});
const LanguageQuerySchema = z.object({ languageCode: LanguageCodeSchema });
const InviteTokenSchema = InviteAcceptSchema;
const InviteAcceptHeaderSchema = IdempotencyHeaderSchema.extend(TurnstileHeaderSchema.shape);
const SettingsDeleteSchema = SettingsQuerySchema.extend({
  key: z.string().min(1).max(100),
  expectedRevision: z.coerce.number().int().nonnegative(),
});

const SettingFormatSchema = z.enum([
  "singleChoice",
  "multipleChoice",
  "trueFalse",
  "fillBlank",
  "selectBlank",
  "multiCloze",
  "wordBank",
  "matching",
  "reorderTokens",
  "reorderDialogue",
  "categorize",
  "translation",
  "shortAnswer",
  "errorCorrection",
  "sentenceTransformation",
  "dictation",
  "freeWriting",
  "speakingRepeat",
  "speakingRoleplay",
  "listenSelect",
  "audioMatching",
  "soundDiscrimination",
  "flashcardRecall",
  "characterTracing",
]);
const LearningProfileSchema = z.object({
  targetLanguage: z.string().trim().min(1).max(100),
  sourceLanguage: z.string().trim().min(1).max(100),
  interfaceLanguage: z.enum(["vi", "en"]),
  level: z.enum(["beginner", "elementary", "intermediate", "upperIntermediate", "advanced"]),
  dailyQuestionGoal: z.number().int().min(1).max(100),
  lessonQuestionCount: z.number().int().min(8).max(15),
  speakingEnabled: z.boolean(),
  preferredFormats: z.array(SettingFormatSchema).min(1).max(100)
    .refine((items) => new Set(items).size === items.length, "Formats must be unique"),
  coachingStyle: z.enum(["gentle", "direct", "socratic"]),
});
const SETTING_VALUE_SCHEMAS: Readonly<Record<string, Readonly<Record<string, z.ZodType>>>> = {
  user: {
    theme: ThemeSettingSchema,
    sidebarWidth: z.number().int().min(248).max(420),
  },
  collection: {
    appearance: z.object({
      icon: z.string().trim().min(1).max(8),
      accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    }),
    learningProfile: LearningProfileSchema,
    questionSettings: z.object({
      enabledFormats: z.array(SettingFormatSchema).min(1).max(100)
        .refine((items) => new Set(items).size === items.length, "Formats must be unique"),
      characterTracing: z.object({ requireStrokeOrder: z.boolean() }),
    }),
  },
  collection_user: {
    unitOrder: z.array(UuidSchema).max(20_000)
      .refine((items) => new Set(items).size === items.length, "Unit order must be unique"),
  },
};

function collectionInput(input: EndpointInput): PreparedEndpointInput {
  return { rpcInput: input.input };
}

function validateSettingsTarget(value: JsonObject): z.ZodType | undefined {
  const scope = typeof value.scope === "string" ? value.scope : "";
  const key = typeof value.key === "string" ? value.key : undefined;
  const collectionScoped = scope === "collection" || scope === "collection_user";
  if (collectionScoped !== (typeof value.collectionId === "string")) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      collectionScoped
        ? "collectionId is required for collection settings"
        : "collectionId is not allowed for user settings",
    );
  }
  const schema = key ? SETTING_VALUE_SCHEMAS[scope]?.[key] : undefined;
  if (key && !schema) {
    throw new ApiError(400, "INVALID_REQUEST", `Unknown ${scope} settings key`);
  }
  return schema;
}

function prepareSettingsLookup(input: EndpointInput): PreparedEndpointInput {
  validateSettingsTarget(input.input);
  return { rpcInput: input.input };
}

function prepareSettingsUpsert(input: EndpointInput): PreparedEndpointInput {
  const schema = validateSettingsTarget(input.input);
  const parsed = schema?.safeParse(input.input.value);
  if (!parsed?.success) {
    throw new ApiError(400, "INVALID_REQUEST", "Invalid value for settings key", {
      issues: parsed?.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.join("."),
      })) ?? [],
    });
  }
  return { rpcInput: { ...input.input, value: parsed.data as JsonValue } };
}

function normalizeUnit(input: EndpointInput): PreparedEndpointInput {
  const value = input.input;
  const words = value.words;
  const phrases = value.phrases;
  const sentences = value.sentences;
  if (
    !Array.isArray(words) ||
    !Array.isArray(phrases) ||
    !Array.isArray(sentences)
  ) {
    throw new ApiError(400, "INVALID_REQUEST", "Unit study lists must be arrays");
  }
  const rpcInput: JsonObject = {
    ...value,
    words: normalizeStudyList(words, "words"),
    phrases: normalizeStudyList(phrases, "phrases"),
    sentences: normalizeStudyList(sentences, "sentences"),
  };
  const contentBytes = new TextEncoder().encode(JSON.stringify({
    words: rpcInput.words,
    phrases: rpcInput.phrases,
    sentences: rpcInput.sentences,
    documents: rpcInput.documents,
  })).byteLength;
  if (contentBytes > 1024 * 1024) {
    throw new ApiError(413, "BODY_TOO_LARGE", "Unit JSON content may not exceed 1 MiB");
  }
  return {
    rpcInput,
  };
}

function normalizeProgressBatch(input: EndpointInput): PreparedEndpointInput {
  const events = Array.isArray(input.input.events)
    ? input.input.events.map((rawEvent) => {
        const event = asJsonObject(rawEvent);
        const rawStatus = event.status ?? event.outcome;
        const status = rawStatus === "partial"
          ? "incorrect"
          : typeof rawStatus === "string"
            ? rawStatus
            : "incorrect";
        return {
          ...event,
          status,
          evaluationSource:
            event.evaluationSource === "server_rule" ? "deterministic" : "client_extension",
        };
      })
    : [];
  const snapshot = asJsonObject(input.input.snapshot ?? {});
  const completedQuestionIds = Array.isArray(snapshot.completedQuestionIds)
    ? snapshot.completedQuestionIds
    : [];
  const completed =
    typeof snapshot.totalQuestions === "number" &&
    snapshot.totalQuestions > 0 &&
    completedQuestionIds.length >= snapshot.totalQuestions;
  const rpcInput: JsonObject = { ...input.input, events };
  delete rpcInput.snapshot;
  if (completed || input.input.completedAt !== undefined) {
    rpcInput.complete = true;
  }
  delete rpcInput.completedAt;
  return { rpcInput };
}

function flattenSettings(result: JsonValue): JsonValue {
  const object = asJsonObject(result);
  if (!Array.isArray(object.items)) {
    return {};
  }
  return Object.fromEntries(
    object.items.flatMap((item) => {
      const setting = asJsonObject(item);
      return typeof setting.key === "string" ? [[setting.key, setting.value ?? null]] : [];
    }),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function inviteToken(
  secret: string,
  actorId: string,
  collectionId: string,
  idempotencyKey: string,
): Promise<string> {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new ApiError(500, "INTERNAL_ERROR", "Invite token signing is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${actorId}:${collectionId}:${idempotencyKey}`),
  );
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function abuseKey(secret: string, scope: string, subject: string): Promise<string> {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new ApiError(500, "INTERNAL_ERROR", "Abuse protection is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${scope}:${subject}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const endpoints: readonly RpcEndpoint[] = [
  {
    method: "GET",
    path: "/v1/me",
    operationId: "getMe",
    summary: "Get the authenticated account and profile",
    tags: ["Profile"],
    operation: "meGet",
    response: MeSchema,
  },
  {
    method: "PATCH",
    path: "/v1/me/profile",
    operationId: "updateProfile",
    summary: "Update the main profile",
    tags: ["Profile"],
    operation: "profileUpdate",
    body: ProfileUpdateSchema,
    response: ProfileSchema,
  },
  {
    method: "GET",
    path: "/v1/me/username-availability",
    operationId: "checkUsernameAvailability",
    summary: "Check whether a username can be claimed",
    tags: ["Profile"],
    operation: "usernameAvailability",
    query: UsernameAvailabilityQuerySchema,
    response: UsernameAvailabilityResponseSchema,
    prepare: async ({ actor, context, input }) => {
      const key = await abuseKey(
        context.env.INVITE_TOKEN_SECRET,
        "username_lookup",
        `user:${actor.userId}`,
      );
      await context.get("repository").call("abuseConsume", actor.userId, {
        abuseKey: key,
        scope: "username_lookup",
      });
      return { rpcInput: input };
    },
  },
  {
    method: "POST",
    path: "/v1/me/username",
    operationId: "changeUsername",
    summary: "Claim or change the main username",
    tags: ["Profile"],
    operation: "usernameChange",
    body: z.object({ username: UsernameSchema }),
    response: UsernameChangeResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/me/deletion",
    operationId: "requestAccountDeletion",
    summary: "Schedule account deletion",
    tags: ["Profile"],
    operation: "accountDeletionRequest",
    body: AccountDeletionRequestSchema,
    response: AccountDeletionPendingSchema,
  },
  {
    method: "DELETE",
    path: "/v1/me/deletion",
    operationId: "cancelAccountDeletion",
    summary: "Cancel scheduled account deletion",
    tags: ["Profile"],
    operation: "accountDeletionCancel",
    response: AccountDeletionCancelledSchema,
  },
  {
    method: "GET",
    path: "/v1/collections",
    operationId: "listCollections",
    summary: "List collections visible to the account",
    tags: ["Collections"],
    operation: "collectionList",
    query: CollectionListQuerySchema,
    response: PaginatedCollectionsSchema,
  },
  {
    method: "POST",
    path: "/v1/collections",
    operationId: "createCollection",
    summary: "Create a collection",
    tags: ["Collections"],
    operation: "collectionCreate",
    body: CollectionCreateSchema,
    headers: IdempotencyHeaderSchema,
    response: CollectionSchema,
  },
  {
    method: "GET",
    path: "/v1/collections/:collectionId",
    documentPath: "/v1/collections/{collectionId}",
    operationId: "getCollection",
    summary: "Get a collection",
    tags: ["Collections"],
    operation: "collectionGet",
    params: CollectionParamSchema,
    response: CollectionSchema,
  },
  {
    method: "PATCH",
    path: "/v1/collections/:collectionId",
    documentPath: "/v1/collections/{collectionId}",
    operationId: "updateCollection",
    summary: "Update a collection",
    tags: ["Collections"],
    operation: "collectionUpdate",
    params: CollectionParamSchema,
    body: CollectionCreateSchema.partial().extend({ expectedRevision: z.number().int().nonnegative() }),
    response: CollectionSchema,
  },
  {
    method: "DELETE",
    path: "/v1/collections/:collectionId",
    documentPath: "/v1/collections/{collectionId}",
    operationId: "deleteCollection",
    summary: "Soft-delete a collection",
    tags: ["Collections"],
    operation: "collectionDelete",
    params: CollectionParamSchema,
    body: ExpectedRevisionSchema,
    response: CollectionSchema,
  },
  {
    method: "POST",
    path: "/v1/collections/:collectionId/restore",
    documentPath: "/v1/collections/{collectionId}/restore",
    operationId: "restoreCollection",
    summary: "Restore a soft-deleted collection",
    tags: ["Collections"],
    operation: "collectionRestore",
    params: CollectionParamSchema,
    body: ExpectedRevisionSchema,
    response: CollectionSchema,
  },
  {
    method: "POST",
    path: "/v1/collections/:collectionId/transfer",
    documentPath: "/v1/collections/{collectionId}/transfer",
    operationId: "transferCollection",
    summary: "Transfer collection ownership",
    tags: ["Collections"],
    operation: "collectionTransfer",
    params: CollectionParamSchema,
    body: CollectionTransferSchema,
    response: CollectionSchema,
  },
  {
    method: "POST",
    path: "/v1/collections/:collectionId/leave",
    documentPath: "/v1/collections/{collectionId}/leave",
    operationId: "leaveCollection",
    summary: "Leave a collection",
    tags: ["Collections"],
    operation: "collectionLeave",
    params: CollectionParamSchema,
    response: CollectionLeaveResultSchema,
  },
  {
    method: "GET",
    path: "/v1/collections/:collectionId/members",
    documentPath: "/v1/collections/{collectionId}/members",
    operationId: "listCollectionMembers",
    summary: "List collection members",
    tags: ["Members"],
    operation: "collectionMemberList",
    params: CollectionParamSchema,
    query: PaginationQuerySchema,
    response: PaginatedCollectionMembersSchema,
  },
  {
    method: "DELETE",
    path: "/v1/collections/:collectionId/members/:userId",
    documentPath: "/v1/collections/{collectionId}/members/{userId}",
    operationId: "removeCollectionMember",
    summary: "Remove a collection member",
    tags: ["Members"],
    operation: "collectionMemberRemove",
    params: CollectionMemberParamSchema,
    response: CollectionMemberRemovalSchema,
  },
  {
    method: "PUT",
    path: "/v1/collections/:collectionId/profile",
    documentPath: "/v1/collections/{collectionId}/profile",
    operationId: "updateCollectionProfile",
    summary: "Update a collection profile override",
    tags: ["Members"],
    operation: "collectionProfileUpdate",
    params: CollectionParamSchema,
    body: CollectionProfileUpdateSchema,
    response: CollectionProfileSchema,
  },
  {
    method: "GET",
    path: "/v1/collections/:collectionId/roles",
    documentPath: "/v1/collections/{collectionId}/roles",
    operationId: "listCollectionRoles",
    summary: "List collection roles",
    tags: ["Roles"],
    operation: "collectionRoleList",
    params: CollectionParamSchema,
    query: PaginationQuerySchema,
    response: PaginatedCollectionRolesSchema,
  },
  {
    method: "POST",
    path: "/v1/collections/:collectionId/roles",
    documentPath: "/v1/collections/{collectionId}/roles",
    operationId: "createCollectionRole",
    summary: "Create a collection role",
    tags: ["Roles"],
    operation: "collectionRoleCreate",
    params: CollectionParamSchema,
    body: RoleInputSchema,
    headers: IdempotencyHeaderSchema,
    response: CollectionRoleSchema,
  },
  {
    method: "PATCH",
    path: "/v1/collections/:collectionId/roles/:roleId",
    documentPath: "/v1/collections/{collectionId}/roles/{roleId}",
    operationId: "updateCollectionRole",
    summary: "Update a collection role",
    tags: ["Roles"],
    operation: "collectionRoleUpdate",
    params: CollectionRoleParamSchema,
    body: RoleUpdateSchema,
    response: CollectionRoleSchema,
  },
  {
    method: "DELETE",
    path: "/v1/collections/:collectionId/roles/:roleId",
    documentPath: "/v1/collections/{collectionId}/roles/{roleId}",
    operationId: "deleteCollectionRole",
    summary: "Delete a collection role",
    tags: ["Roles"],
    operation: "collectionRoleDelete",
    params: CollectionRoleParamSchema,
    response: CollectionRoleDeletionSchema,
  },
  {
    method: "POST",
    path: "/v1/collections/:collectionId/roles/:roleId/members",
    documentPath: "/v1/collections/{collectionId}/roles/{roleId}/members",
    operationId: "assignCollectionRole",
    summary: "Assign a role to a collection member",
    tags: ["Roles"],
    operation: "collectionRoleAssign",
    params: CollectionRoleParamSchema,
    body: RoleAssignmentSchema,
    response: CollectionRoleAssignmentSchema,
  },
  {
    method: "DELETE",
    path: "/v1/collections/:collectionId/roles/:roleId/members/:userId",
    documentPath: "/v1/collections/{collectionId}/roles/{roleId}/members/{userId}",
    operationId: "unassignCollectionRole",
    summary: "Unassign a role from a collection member",
    tags: ["Roles"],
    operation: "collectionRoleUnassign",
    params: CollectionRoleParamSchema.extend({ userId: UuidSchema }),
    response: CollectionRoleAssignmentSchema,
  },
  {
    method: "GET",
    path: "/v1/collections/:collectionId/invites",
    documentPath: "/v1/collections/{collectionId}/invites",
    operationId: "listCollectionInvites",
    summary: "List collection invites",
    tags: ["Invites"],
    operation: "collectionInviteList",
    params: CollectionParamSchema,
    query: PaginationQuerySchema,
    response: PaginatedCollectionInvitesSchema,
  },
  {
    method: "POST",
    path: "/v1/collections/:collectionId/invites",
    documentPath: "/v1/collections/{collectionId}/invites",
    operationId: "createCollectionInvite",
    summary: "Create a reusable collection invite",
    tags: ["Invites"],
    operation: "collectionInviteCreate",
    params: CollectionParamSchema,
    body: InviteCreateSchema,
    headers: IdempotencyHeaderSchema,
    response: CreatedCollectionInviteSchema,
    prepare: async ({ actor, context, input }) => {
      if (
        typeof input.collectionId !== "string" ||
        typeof input.idempotencyKey !== "string"
      ) {
        throw new ApiError(400, "INVALID_REQUEST", "Collection and idempotency key are required");
      }
      const token = await inviteToken(
        context.env.INVITE_TOKEN_SECRET,
        actor.userId,
        input.collectionId,
        input.idempotencyKey,
      );
      return {
        rpcInput: { ...input, tokenHash: await sha256Hex(token) },
        responseContext: { token },
      };
    },
    decorate: (result, context) => ({ ...asJsonObject(result), token: context.token ?? null }),
  },
  {
    method: "DELETE",
    path: "/v1/collections/:collectionId/invites/:inviteId",
    documentPath: "/v1/collections/{collectionId}/invites/{inviteId}",
    operationId: "revokeCollectionInvite",
    summary: "Revoke a collection invite",
    tags: ["Invites"],
    operation: "collectionInviteRevoke",
    params: CollectionInviteParamSchema,
    response: CollectionInviteSchema,
  },
  {
    method: "POST",
    path: "/v1/invites/preview",
    operationId: "previewCollectionInvite",
    summary: "Preview a collection invite",
    tags: ["Invites"],
    operation: "collectionInvitePreview",
    body: InviteTokenSchema,
    headers: TurnstileHeaderSchema,
    response: InvitePreviewSchema,
    prepare: async ({ input }) => ({
      rpcInput: { tokenHash: await sha256Hex(String(input.token)) },
    }),
  },
  {
    method: "POST",
    path: "/v1/invites/accept",
    operationId: "acceptCollectionInvite",
    summary: "Accept a collection invite",
    tags: ["Invites"],
    operation: "collectionInviteAccept",
    body: InviteTokenSchema,
    headers: InviteAcceptHeaderSchema,
    response: CollectionSchema,
    prepare: async ({ actor, context, input }) => {
      if (typeof input.idempotencyKey !== "string") {
        throw new ApiError(400, "INVALID_REQUEST", "Idempotency-Key is required");
      }
      const remoteIp = context.req.header("cf-connecting-ip")?.trim();
      const key = await abuseKey(
        context.env.INVITE_TOKEN_SECRET,
        "invite_accept",
        remoteIp ? `ip:${remoteIp}` : `user:${actor.userId}`,
      );
      await context.get("repository").call("abuseConsume", actor.userId, {
        abuseKey: key,
        scope: "invite_accept",
      });
      return {
        rpcInput: {
          idempotencyKey: input.idempotencyKey,
          tokenHash: await sha256Hex(String(input.token)),
        },
      };
    },
  },
  {
    method: "GET",
    path: "/v1/collections/:collectionId/audit",
    documentPath: "/v1/collections/{collectionId}/audit",
    operationId: "listCollectionAudit",
    summary: "List collection audit events",
    tags: ["Audit"],
    operation: "collectionAuditList",
    params: CollectionParamSchema,
    query: PaginationQuerySchema,
    response: PaginatedCollectionAuditSchema,
  },
  {
    method: "GET",
    path: "/v1/settings/user",
    operationId: "getUserSettings",
    summary: "Get all user settings",
    tags: ["Settings"],
    operation: "settingsGet",
    response: UserSettingsSchema,
    prepare: () => ({ rpcInput: { scope: "user" } }),
    decorate: flattenSettings,
  },
  {
    method: "GET",
    path: "/v1/settings",
    operationId: "getSettings",
    summary: "Get settings for a scope",
    tags: ["Settings"],
    operation: "settingsGet",
    query: SettingsQuerySchema,
    response: SettingsListSchema,
    prepare: prepareSettingsLookup,
  },
  {
    method: "PUT",
    path: "/v1/settings",
    operationId: "upsertSettings",
    summary: "Create or update a settings value",
    tags: ["Settings"],
    operation: "settingsUpsert",
    body: SettingsUpsertSchema,
    response: SettingRecordSchema,
    prepare: prepareSettingsUpsert,
  },
  {
    method: "DELETE",
    path: "/v1/settings",
    operationId: "deleteSettings",
    summary: "Delete a settings value",
    tags: ["Settings"],
    operation: "settingsDelete",
    query: SettingsDeleteSchema,
    response: SettingDeletionSchema,
    prepare: prepareSettingsLookup,
  },
  {
    method: "GET",
    path: "/v1/collections/:collectionId/units",
    documentPath: "/v1/collections/{collectionId}/units",
    operationId: "listUnits",
    summary: "List collection units",
    tags: ["Units"],
    operation: "unitList",
    params: CollectionParamSchema,
    query: UnitListQuerySchema,
    response: PaginatedUnitsSchema,
  },
  {
    method: "POST",
    path: "/v1/collections/:collectionId/units",
    documentPath: "/v1/collections/{collectionId}/units",
    operationId: "createUnit",
    summary: "Create a unit",
    tags: ["Units"],
    operation: "unitCreate",
    params: CollectionParamSchema,
    body: UnitCreateSchema,
    headers: IdempotencyHeaderSchema,
    response: UnitSchema,
    prepare: normalizeUnit,
  },
  {
    method: "GET",
    path: "/v1/units/:unitId",
    documentPath: "/v1/units/{unitId}",
    operationId: "getUnit",
    summary: "Get a unit",
    tags: ["Units"],
    operation: "unitGet",
    params: z.object({ unitId: UuidSchema }),
    response: UnitSchema,
  },
  {
    method: "PATCH",
    path: "/v1/units/:unitId",
    documentPath: "/v1/units/{unitId}",
    operationId: "updateUnit",
    summary: "Replace unit content at an expected revision",
    tags: ["Units"],
    operation: "unitUpdate",
    params: z.object({ unitId: UuidSchema }),
    body: UnitUpdateSchema,
    response: UnitSchema,
    prepare: normalizeUnit,
  },
  {
    method: "DELETE",
    path: "/v1/units/:unitId",
    documentPath: "/v1/units/{unitId}",
    operationId: "deleteUnit",
    summary: "Soft-delete a unit",
    tags: ["Units"],
    operation: "unitDelete",
    params: z.object({ unitId: UuidSchema }),
    body: ExpectedRevisionSchema,
    response: UnitSchema,
  },
  {
    method: "POST",
    path: "/v1/units/:unitId/restore",
    documentPath: "/v1/units/{unitId}/restore",
    operationId: "restoreUnit",
    summary: "Restore a soft-deleted unit",
    tags: ["Units"],
    operation: "unitRestore",
    params: z.object({ unitId: UuidSchema }),
    body: ExpectedRevisionSchema,
    response: UnitSchema,
  },
  {
    method: "GET",
    path: "/v1/units/:unitId/revisions",
    documentPath: "/v1/units/{unitId}/revisions",
    operationId: "listUnitRevisions",
    summary: "List retained unit revisions",
    tags: ["Units"],
    operation: "unitRevisionList",
    params: z.object({ unitId: UuidSchema }),
    query: PaginationQuerySchema,
    response: PaginatedUnitRevisionsSchema,
  },
  {
    method: "POST",
    path: "/v1/units/:unitId/revisions/:revision/restore",
    documentPath: "/v1/units/{unitId}/revisions/{revision}/restore",
    operationId: "restoreUnitRevision",
    summary: "Restore a retained unit revision",
    tags: ["Units"],
    operation: "unitRevisionRestore",
    params: UnitRevisionParamSchema,
    body: ExpectedRevisionSchema,
    response: UnitSchema,
  },
  {
    method: "GET",
    path: "/v1/lessons",
    operationId: "listLessons",
    summary: "List lessons",
    tags: ["Lessons"],
    operation: "lessonList",
    query: LessonListQuerySchema,
    response: PaginatedLessonsSchema,
  },
  {
    method: "POST",
    path: "/v1/lessons",
    operationId: "createLesson",
    summary: "Create an immutable lesson v8 draft",
    tags: ["Lessons"],
    operation: "lessonCreate",
    body: LessonCreateSchema,
    documentBody: LessonCreateDocumentSchema,
    headers: IdempotencyHeaderSchema,
    response: LessonSchema,
    documentResponse: LessonDocumentSchema,
  },
  {
    method: "GET",
    path: "/v1/lessons/:lessonId",
    documentPath: "/v1/lessons/{lessonId}",
    operationId: "getLesson",
    summary: "Get a lesson",
    tags: ["Lessons"],
    operation: "lessonGet",
    params: LessonParamSchema,
    response: LessonSchema,
    documentResponse: LessonDocumentSchema,
  },
  {
    method: "DELETE",
    path: "/v1/lessons/:lessonId",
    documentPath: "/v1/lessons/{lessonId}",
    operationId: "deleteLesson",
    summary: "Delete a lesson",
    tags: ["Lessons"],
    operation: "lessonDelete",
    params: LessonParamSchema,
    body: ExpectedRevisionSchema,
    response: LessonSchema,
    documentResponse: LessonDocumentSchema,
  },
  {
    method: "POST",
    path: "/v1/lessons/:lessonId/publish",
    documentPath: "/v1/lessons/{lessonId}/publish",
    operationId: "publishLesson",
    summary: "Publish a lesson",
    tags: ["Lessons"],
    operation: "lessonPublish",
    params: LessonParamSchema,
    body: ExpectedRevisionSchema,
    response: LessonSchema,
    documentResponse: LessonDocumentSchema,
  },
  {
    method: "POST",
    path: "/v1/lessons/:lessonId/unpublish",
    documentPath: "/v1/lessons/{lessonId}/unpublish",
    operationId: "unpublishLesson",
    summary: "Return a lesson to draft",
    tags: ["Lessons"],
    operation: "lessonUnpublish",
    params: LessonParamSchema,
    body: ExpectedRevisionSchema,
    response: LessonSchema,
    documentResponse: LessonDocumentSchema,
  },
  {
    method: "POST",
    path: "/v1/lessons/:lessonId/progress",
    documentPath: "/v1/lessons/{lessonId}/progress",
    operationId: "startProgress",
    summary: "Start a new lesson progress session",
    tags: ["Learning"],
    operation: "progressStart",
    params: LessonParamSchema,
    headers: IdempotencyHeaderSchema,
    response: ProgressSessionSchema,
  },
  {
    method: "POST",
    path: "/v1/progress/:progressId/batches",
    documentPath: "/v1/progress/{progressId}/batches",
    operationId: "submitProgressBatch",
    summary: "Submit an exact-once answer batch",
    tags: ["Learning"],
    operation: "progressBatchSubmit",
    params: ProgressParamSchema,
    body: ProgressBatchSchema,
    response: ProgressBatchResultSchema,
    prepare: normalizeProgressBatch,
  },
  {
    method: "GET",
    path: "/v1/progress/:progressId",
    documentPath: "/v1/progress/{progressId}",
    operationId: "getProgress",
    summary: "Get one progress session and authorized raw answers",
    tags: ["Learning"],
    operation: "progressGet",
    params: ProgressParamSchema,
    response: ProgressDetailSchema,
  },
  {
    method: "GET",
    path: "/v1/progress",
    operationId: "listProgress",
    summary: "List the account's progress sessions",
    tags: ["Learning"],
    operation: "progressHistory",
    query: ProgressHistoryQuerySchema,
    response: PaginatedProgressSchema,
  },
  {
    method: "GET",
    path: "/v1/stats",
    operationId: "getGlobalLanguageStats",
    summary: "Get private global language statistics",
    tags: ["Learning"],
    operation: "statsGlobalGet",
    query: LanguageQuerySchema,
    response: LanguageStatsSchema,
  },
  {
    method: "GET",
    path: "/v1/collections/:collectionId/stats",
    documentPath: "/v1/collections/{collectionId}/stats",
    operationId: "getCollectionLanguageStats",
    summary: "Get authorized collection language statistics",
    tags: ["Learning"],
    operation: "statsCollectionGet",
    params: CollectionParamSchema,
    query: LanguageQuerySchema.extend({ userId: UuidSchema.optional() }),
    response: LanguageStatsSchema,
  },
  {
    method: "GET",
    path: "/v1/characters",
    operationId: "getCharacterProgress",
    summary: "Get global character progress",
    tags: ["Learning"],
    operation: "characterProgressGet",
    query: LanguageQuerySchema,
    response: CharacterProgressSchema,
  },
  {
    method: "PUT",
    path: "/v1/characters",
    operationId: "updateCharacterProgress",
    summary: "Update global character progress",
    tags: ["Learning"],
    operation: "characterProgressUpdate",
    body: CharacterProgressUpdateSchema,
    response: CharacterProgressSchema,
  },
] as const;

function parseObject(schema: ObjectSchema | undefined, value: unknown): JsonObject {
  if (!schema) {
    return {};
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_REQUEST", "Request validation failed", {
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.join("."),
      })),
    });
  }
  return asJsonObject(parsed.data);
}

async function parseRequest(c: Context<AppBindings>, endpoint: RpcEndpoint): Promise<JsonObject> {
  const params = parseObject(endpoint.params, c.req.param());
  const query = parseObject(endpoint.query, c.req.query());
  let body: JsonObject = {};
  if (endpoint.body) {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError(400, "INVALID_REQUEST", "Content-Type must be application/json");
    }
    try {
      body = parseObject(endpoint.body, await c.req.json());
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(400, "INVALID_REQUEST", "The request body is not valid JSON");
    }
  }

  const rawHeaders = endpoint.headers
    ? {
        "idempotency-key": c.req.header("idempotency-key"),
        "x-turnstile-token": c.req.header("x-turnstile-token"),
      }
    : {};
  const headers = parseObject(endpoint.headers, rawHeaders);
  const idempotencyKey = headers["idempotency-key"];
  return {
    ...params,
    ...query,
    ...body,
    ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
  };
}

function actor(c: Context<AppBindings>): Actor {
  const current = c.get("requestState").actor;
  if (!current) {
    throw new ApiError(401, "AUTH_REQUIRED", "Authentication is required");
  }
  return current;
}

function success<T>(c: Context<AppBindings>, data: T) {
  return c.json({
    data,
    meta: { requestId: c.get("requestState").requestId },
  });
}

function documentEndpoint(app: OpenAPIHono<AppBindings>, endpoint: RpcEndpoint): void {
  const documentBody = endpoint.documentBody ?? endpoint.body;
  const documentResponse = endpoint.documentResponse ?? endpoint.response;
  app.openAPIRegistry.registerPath({
    method: endpoint.method.toLowerCase() as Lowercase<HttpMethod>,
    path: endpoint.documentPath ?? endpoint.path,
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    tags: [...endpoint.tags],
    security: [{ BearerAuth: [] }],
    request: {
      ...(endpoint.params ? { params: endpoint.params } : {}),
      ...(endpoint.query ? { query: endpoint.query } : {}),
      ...(endpoint.headers ? { headers: endpoint.headers } : {}),
      ...(documentBody
        ? {
            body: {
              required: true,
              content: {
                "application/json": {
                  schema: documentBody,
                },
              },
            },
          }
        : {}),
    },
    responses: {
      200: {
        description: "Successful response",
        content: {
          "application/json": {
            schema: successSchema(documentResponse),
          },
        },
      },
      400: {
        description: "Invalid request",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Authentication required",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description: "Permission denied",
        content: { "application/json": { schema: ErrorSchema } },
      },
      409: {
        description: "Conflict",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: {
        description: "Rate limit exceeded",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });
}

export function registerRpcRoutes(app: OpenAPIHono<AppBindings>): void {
  for (const endpoint of endpoints) {
    documentEndpoint(app, endpoint);
    app.on(endpoint.method, endpoint.path, async (c) => {
      const currentActor = actor(c);
      const rawInput = await parseRequest(c, endpoint);
      const prepared = endpoint.prepare
        ? await endpoint.prepare({ actor: currentActor, context: c, input: rawInput })
        : collectionInput({ actor: currentActor, context: c, input: rawInput });
      const repositoryResult = await c
        .get("repository")
        .call(endpoint.operation, currentActor.userId, prepared.rpcInput);
      const result = endpoint.decorate
        ? endpoint.decorate(repositoryResult, prepared.responseContext ?? {})
        : repositoryResult;
      const parsed = endpoint.response.safeParse(result);
      if (!parsed.success) {
        throw new ApiError(500, "INTERNAL_ERROR", "The service returned an invalid response");
      }
      return success(c, parsed.data);
    });
  }
}

export function registerFileRoutes(app: OpenAPIHono<AppBindings>): void {
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/files/uploads",
    operationId: "initializeFileUpload",
    summary: "Create a pending asset and short-lived direct R2 upload URL",
    tags: ["Files"],
    security: [{ BearerAuth: [] }],
    request: {
      headers: IdempotencyHeaderSchema,
      body: {
        required: true,
        content: { "application/json": { schema: FileInitializeSchema } },
      },
    },
    responses: {
      200: {
        description: "Pending asset and signed upload request",
        content: {
          "application/json": {
            schema: successSchema(FileUploadInitializeResponseSchema),
          },
        },
      },
      429: {
        description: "Upload or storage budget exhausted",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.post("/v1/files/uploads", async (c) => {
    const currentActor = actor(c);
    const input = await parseRequest(c, {
      method: "POST",
      path: "/v1/files/uploads",
      operationId: "initializeFileUpload",
      summary: "",
      tags: ["Files"],
      operation: "fileInitialize",
      body: FileInitializeSchema,
      headers: IdempotencyHeaderSchema,
      response: FileUploadInitializeResponseSchema,
    });
    const service = new FileService(c.get("repository"), c.env);
    const fileName = input.fileName ?? input.filename;
    const contentType = input.contentType ?? input.mimeType;
    const sizeBytes = input.sizeBytes ?? input.size;
    const data = await service.initialize(currentActor, {
      ...(typeof input.collectionId === "string" ? { collectionId: input.collectionId } : {}),
      contentType: contentType as NonNullable<z.infer<typeof FileInitializeSchema>["contentType"]>,
      fileName: String(fileName),
      idempotencyKey: String(input.idempotencyKey),
      sha256: String(input.sha256),
      sizeBytes: Number(sizeBytes),
    });
    return success(c, FileUploadInitializeResponseSchema.parse(data));
  });

  for (const definition of [
    {
      method: "post",
      path: "/v1/files/{assetId}/finalize",
      honoPath: "/v1/files/:assetId/finalize",
      operationId: "finalizeFileUpload",
      summary: "Verify R2 metadata, checksum and magic bytes, then finalize an asset",
      response: FileAssetMetadataSchema,
    },
    {
      method: "get",
      path: "/v1/files/{assetId}/download",
      honoPath: "/v1/files/:assetId/download",
      operationId: "authorizeFileDownload",
      summary: "Create a short-lived authorized R2 download URL",
      response: FileDownloadAuthorizationSchema,
    },
    {
      method: "post",
      path: "/v1/files/{assetId}/download",
      honoPath: "/v1/files/:assetId/download",
      operationId: "authorizeFileDownloadPost",
      summary: "Create a short-lived authorized R2 download URL",
      response: FileDownloadAuthorizationSchema,
    },
    {
      method: "delete",
      path: "/v1/files/{assetId}",
      honoPath: "/v1/files/:assetId",
      operationId: "deleteFile",
      summary: "Delete an unreferenced asset",
      response: FileDeletionSchema,
    },
  ] as const) {
    app.openAPIRegistry.registerPath({
      method: definition.method,
      path: definition.path,
      operationId: definition.operationId,
      summary: definition.summary,
      tags: ["Files"],
      security: [{ BearerAuth: [] }],
      request: { params: AssetParamSchema },
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: successSchema(definition.response),
            },
          },
        },
      },
    });
  }

  app.post("/v1/files/:assetId/finalize", async (c) => {
    const currentActor = actor(c);
    const { assetId } = AssetParamSchema.parse(c.req.param());
    const data = await new FileService(c.get("repository"), c.env).finalize(currentActor, assetId);
    return success(c, FileAssetMetadataSchema.parse(data));
  });
  app.get("/v1/files/:assetId/download", async (c) => {
    const currentActor = actor(c);
    const { assetId } = AssetParamSchema.parse(c.req.param());
    const data = await new FileService(c.get("repository"), c.env).download(currentActor, assetId);
    return success(c, FileDownloadAuthorizationSchema.parse(data));
  });
  app.post("/v1/files/:assetId/download", async (c) => {
    const currentActor = actor(c);
    const { assetId } = AssetParamSchema.parse(c.req.param());
    const data = await new FileService(c.get("repository"), c.env).download(currentActor, assetId);
    return success(c, FileDownloadAuthorizationSchema.parse(data));
  });
  app.delete("/v1/files/:assetId", async (c) => {
    const currentActor = actor(c);
    const { assetId } = AssetParamSchema.parse(c.req.param());
    const data = await new FileService(c.get("repository"), c.env).delete(currentActor, assetId);
    return success(c, FileDeletionSchema.parse(data));
  });
}
