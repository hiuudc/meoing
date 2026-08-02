import { z } from "@hono/zod-openapi";
import { ALLOWED_FILE_TYPES, MAX_FILE_SIZE_BYTES } from "../storage/r2";

export const UuidSchema = z.uuid().openapi({ example: "3e3e6b09-d1f8-4d4f-81f6-2ca16457e714" });
export const TimestampSchema = z.iso.datetime({ offset: true }).openapi({
  example: "2026-07-30T10:00:00.000Z",
});
export const CursorSchema = z.string().min(1).max(2048);
export const LanguageCodeSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
export const UsernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9._]+$/)
  .refine((value) => !value.includes(".."), "Username may not contain consecutive periods");

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: JsonObjectSchema.optional(),
      requestId: z.string(),
    }),
  })
  .openapi("ApiError");

export function successSchema<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    meta: z
      .object({
        requestId: z.string(),
      }),
  });
}

export const LiveHealthSchema = z
  .object({
    environment: z.string().min(1),
    supabaseProjectRef: z.string().min(1),
    status: z.literal("ok"),
  })
  .openapi("LiveHealth");

export const ReadyHealthSchema = z
  .object({
    databaseEnvironment: z.string().min(1),
    databaseProjectRef: z.string().min(1),
    status: z.literal("ready"),
  })
  .openapi("ReadyHealth");

export const PaginationQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const IdParamSchema = z.object({ id: UuidSchema });
export const CollectionParamSchema = z.object({ collectionId: UuidSchema });
export const CollectionMemberParamSchema = z.object({
  collectionId: UuidSchema,
  userId: UuidSchema,
});
export const CollectionRoleParamSchema = z.object({
  collectionId: UuidSchema,
  roleId: UuidSchema,
});
export const CollectionInviteParamSchema = z.object({
  collectionId: UuidSchema,
  inviteId: UuidSchema,
});
export const CollectionUnitParamSchema = z.object({
  collectionId: UuidSchema,
  unitId: UuidSchema,
});
export const UnitRevisionParamSchema = z.object({
  unitId: UuidSchema,
  revision: z.coerce.number().int().positive(),
});
export const LessonParamSchema = z.object({ lessonId: UuidSchema });
export const ProgressParamSchema = z.object({ progressId: UuidSchema });
export const AssetParamSchema = z.object({ assetId: UuidSchema });

export const ProfileSchema = z
  .object({
    username: UsernameSchema.nullable(),
    displayName: z.string().min(1).max(64),
    avatarAssetId: UuidSchema.nullable(),
    bio: z.string().max(500).nullable(),
    revision: z.number().int().positive(),
  })
  .openapi("Profile");

export const MeSchema = z
  .object({
    userId: UuidSchema,
    email: z.email().nullable(),
    emailVerified: z.boolean(),
    onboardingComplete: z.boolean(),
    deletion: z.object({
      status: z.enum(["none", "pending"]),
      requestedAt: TimestampSchema.optional(),
      scheduledFor: TimestampSchema.optional(),
    }),
    profile: ProfileSchema,
  })
  .openapi("Me");

export const ProfileUpdateSchema = z
  .object({
    username: UsernameSchema.optional(),
    displayName: z.string().min(1).max(64).optional(),
    avatarAssetId: UuidSchema.nullable().optional(),
    bio: z.string().max(500).nullable().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .refine(
    (value) =>
      value.username !== undefined ||
      value.displayName !== undefined ||
      value.avatarAssetId !== undefined ||
      value.bio !== undefined,
    "At least one profile field is required",
  );

export const UsernameChangeResponseSchema = z.object({
  username: UsernameSchema,
  revision: z.number().int().positive(),
  usernameChangedAt: TimestampSchema.nullable(),
});

export const UsernameAvailabilityResponseSchema = z
  .object({
    username: UsernameSchema,
    available: z.boolean(),
  })
  .openapi("UsernameAvailability");

export const AccountDeletionPendingSchema = z
  .object({
    status: z.literal("pending"),
    requestedAt: TimestampSchema,
    scheduledFor: TimestampSchema,
  })
  .openapi("AccountDeletionPending");

export const AccountDeletionCancelledSchema = z
  .object({
    status: z.literal("none"),
  })
  .openapi("AccountDeletionCancelled");

export const PermissionSchema = z.enum([
  "manage_collection",
  "manage_roles",
  "manage_members",
  "manage_invites",
  "view_audit_log",
  "create_content",
  "edit_content",
  "delete_content",
  "create_lessons",
  "publish_lessons",
  "view_member_progress",
  "view_member_answers",
  "manage_collection_profiles",
]);

export const CollectionSchema = z
  .object({
    id: UuidSchema,
    name: z.string().min(1).max(100),
    description: z.string().max(1000).nullable(),
    ownerId: UuidSchema.nullable(),
    deletedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    revision: z.number().int().positive(),
    effectivePermissions: z.array(PermissionSchema),
  })
  .openapi("Collection");

export const CollectionCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).nullable().optional(),
});

export const CollectionUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  expectedRevision: z.number().int().nonnegative(),
});

export const PaginatedCollectionsSchema = z
  .object({
    items: z.array(CollectionSchema),
    nextCursor: CursorSchema.nullable(),
  })
  .openapi("PaginatedCollections");

export const CollectionLeaveResultSchema = z
  .object({
    collectionId: UuidSchema,
    left: z.literal(true),
  })
  .openapi("CollectionLeaveResult");

export const CollectionMemberRemovalSchema = z
  .object({
    userId: UuidSchema,
    removed: z.literal(true),
  })
  .openapi("CollectionMemberRemoval");

export const RoleInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  permissions: z.array(PermissionSchema).max(PermissionSchema.options.length),
  securityRank: z.number().int().min(0).max(10_000),
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const InviteCreateSchema = z.object({
  expiresAt: TimestampSchema.nullable().optional(),
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  roleIds: z.array(UuidSchema).max(100).default([]),
});

export const InviteAcceptSchema = z.object({
  token: z.string().min(32).max(512),
});

export const CollectionProfileUpdateSchema = z.object({
  userId: UuidSchema.optional(),
  displayName: z.string().min(1).max(64).nullable().optional(),
  avatarAssetId: UuidSchema.nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
  expectedRevision: z.number().int().nonnegative(),
});

export const CollectionProfileSchema = z
  .object({
    collectionId: UuidSchema,
    userId: UuidSchema,
    displayName: z.string().min(1).max(64).nullable(),
    avatarAssetId: UuidSchema.nullable(),
    bio: z.string().max(500).nullable(),
    revision: z.number().int().positive(),
    updatedAt: TimestampSchema,
  })
  .openapi("CollectionProfile");

export const CollectionProfileOverrideSchema = z
  .object({
    displayName: z.string().min(1).max(64).nullable(),
    avatarAssetId: UuidSchema.nullable(),
    bio: z.string().max(500).nullable(),
    revision: z.number().int().positive(),
  })
  .openapi("CollectionProfileOverride");

export const CollectionMemberSchema = z
  .object({
    userId: UuidSchema,
    username: UsernameSchema,
    displayName: z.string().min(1).max(64),
    avatarAssetId: UuidSchema.nullable(),
    bio: z.string().max(500).nullable(),
    profileRevision: z.number().int().nonnegative(),
    collectionProfile: CollectionProfileOverrideSchema.nullable(),
    joinedAt: TimestampSchema,
    isOwner: z.boolean(),
    roleIds: z.array(UuidSchema),
  })
  .openapi("CollectionMember");

export const PaginatedCollectionMembersSchema = z
  .object({
    items: z.array(CollectionMemberSchema),
    nextCursor: CursorSchema.nullable(),
  })
  .openapi("PaginatedCollectionMembers");

export const CollectionRoleSchema = z
  .object({
    id: UuidSchema,
    collectionId: UuidSchema,
    name: z.string().min(1).max(100),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
    permissions: z.array(PermissionSchema),
    securityRank: z.number().int().min(0),
    isManaged: z.boolean(),
    revision: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("CollectionRole");

export const PaginatedCollectionRolesSchema = z
  .object({
    items: z.array(CollectionRoleSchema),
    nextCursor: CursorSchema.nullable(),
  })
  .openapi("PaginatedCollectionRoles");

export const CollectionRoleDeletionSchema = z
  .object({
    roleId: UuidSchema,
    deleted: z.literal(true),
  })
  .openapi("CollectionRoleDeletion");

export const CollectionRoleAssignmentSchema = z
  .object({
    roleId: UuidSchema,
    userId: UuidSchema,
    assigned: z.boolean(),
  })
  .openapi("CollectionRoleAssignment");

export const CollectionInviteSchema = z
  .object({
    id: UuidSchema,
    collectionId: UuidSchema,
    tokenHint: z.string().nullable(),
    expiresAt: TimestampSchema.nullable(),
    maxUses: z.number().int().positive().nullable(),
    usesCount: z.number().int().nonnegative(),
    revokedAt: TimestampSchema.nullable(),
    revision: z.number().int().positive(),
    roleIds: z.array(UuidSchema),
    createdAt: TimestampSchema,
  })
  .openapi("CollectionInvite");

export const PaginatedCollectionInvitesSchema = z
  .object({
    items: z.array(CollectionInviteSchema),
    nextCursor: CursorSchema.nullable(),
  })
  .openapi("PaginatedCollectionInvites");

export const CreatedCollectionInviteSchema = CollectionInviteSchema.extend({
  token: z.string().min(32).max(512),
}).openapi("CreatedCollectionInvite");

export const InvitePreviewSchema = z
  .object({
    inviteId: UuidSchema,
    collection: z.object({
      id: UuidSchema,
      name: z.string().min(1).max(100),
      description: z.string().max(1000).nullable(),
    }),
    expiresAt: TimestampSchema.nullable(),
    remainingUses: z.number().int().nonnegative().nullable(),
  })
  .openapi("InvitePreview");

export const CollectionAuditEventSchema = z
  .object({
    id: z.number().int().positive(),
    collectionId: UuidSchema,
    actorUserId: UuidSchema.nullable(),
    action: z.string().min(1),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    metadata: JsonObjectSchema,
    createdAt: TimestampSchema,
  })
  .openapi("CollectionAuditEvent");

export const PaginatedCollectionAuditSchema = z
  .object({
    items: z.array(CollectionAuditEventSchema),
    nextCursor: CursorSchema.nullable(),
  })
  .openapi("PaginatedCollectionAudit");

export const SettingsScopeSchema = z.enum(["user", "collection", "collection_user"]);
export const SettingsQuerySchema = z.object({
  scope: SettingsScopeSchema,
  collectionId: UuidSchema.optional(),
  key: z.string().min(1).max(100).optional(),
});
export const SettingsUpsertSchema = z.object({
  scope: SettingsScopeSchema,
  collectionId: UuidSchema.optional(),
  key: z.string().min(1).max(100),
  value: z.unknown(),
  expectedRevision: z.number().int().nonnegative(),
});

export const SettingRecordSchema = z
  .object({
    key: z.string().min(1).max(100),
    value: z.unknown(),
    revision: z.number().int().positive(),
    updatedAt: TimestampSchema,
  })
  .openapi("Setting");

export const SettingsListSchema = z
  .object({
    items: z.array(SettingRecordSchema),
  })
  .openapi("SettingsList");

export const ThemeSettingSchema = z
  .object({
    selection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("base"), id: z.enum(["light", "dusk", "midnight", "black"]) }),
      z.object({
        kind: z.literal("palette"),
        id: z.enum([
          "orchid",
          "spring",
          "sunset",
          "lagoon",
          "lavender",
          "meadow",
          "ember",
          "cobalt",
          "forest",
          "berry",
          "ocean",
          "golden",
        ]),
      }),
      z.object({ kind: z.literal("custom") }),
    ]),
    base: z.enum(["light", "dusk", "midnight", "black"]),
    colorStops: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(2).max(8),
    gradientDirection: z.number().min(0).max(360),
    intensity: z.number().min(0).max(100),
    syncAcrossDevices: z.boolean(),
    useCollectionAccents: z.boolean(),
  })
  .openapi("ThemeSetting");

export const UserSettingsSchema = z
  .object({
    theme: ThemeSettingSchema.optional(),
    sidebarWidth: z.number().int().min(248).max(420).optional(),
  })
  .openapi("UserSettings");

export const SettingDeletionSchema = z
  .object({
    key: z.string().min(1).max(100),
    deleted: z.literal(true),
  })
  .openapi("SettingDeletion");

const ContentTextSchema = z.string().min(1).max(5_000);
export const UnitStudyItemSchema = z.union([
  ContentTextSchema,
  z
    .object({
      text: ContentTextSchema,
      translation: z.string().max(5_000).optional(),
      notes: z.string().max(5_000).optional(),
    })
    .catchall(z.unknown())
    .refine((value) => !Object.hasOwn(value, "id"), "Unit study items may not contain ids"),
]);

interface PersistedImageIssue {
  message: string;
  path: Array<string | number>;
}

function findPersistedImageIssue(value: unknown): PersistedImageIssue | null {
  const pending: Array<{ path: Array<string | number>; value: unknown }> = [{
    path: [],
    value,
  }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => {
        pending.push({ path: [...current.path, index], value: child });
      });
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const record = current.value as Record<string, unknown>;
    if (record.type === "meoi-image") {
      if (typeof record.assetId !== "string" || !UuidSchema.safeParse(record.assetId).success) {
        return {
          message: "Persisted image nodes require a valid assetId",
          path: [...current.path, "assetId"],
        };
      }
      if (record.src !== undefined && record.src !== "") {
        return {
          message: "Persisted image nodes may not contain a source URL",
          path: [...current.path, "src"],
        };
      }
    }
    for (const [key, child] of Object.entries(record)) {
      pending.push({ path: [...current.path, key], value: child });
    }
  }
  return null;
}

export const UnitDocumentSchema = z
  .object({
    title: z.string().max(200).default(""),
    content: JsonObjectSchema,
    sourceAssetId: UuidSchema.nullable().optional(),
  })
  .catchall(z.unknown())
  .refine((value) => !Object.hasOwn(value, "id"), "Unit documents may not contain ids")
  .superRefine((value, context) => {
    const issue = findPersistedImageIssue(value.content);
    if (!issue) return;
    context.addIssue({
      code: "custom",
      message: issue.message,
      path: ["content", ...issue.path],
    });
  });

export const UnitContentSchema = z.object({
  words: z.array(UnitStudyItemSchema).max(20_000),
  phrases: z.array(UnitStudyItemSchema).max(20_000),
  sentences: z.array(UnitStudyItemSchema).max(20_000),
  documents: z.array(UnitDocumentSchema).max(1_000),
});

export const UnitCreateSchema = UnitContentSchema.extend({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).nullable().optional(),
  instructionOverride: z.string().trim().max(20_000).nullable().optional(),
  languageCode: LanguageCodeSchema,
});

export const UnitUpdateSchema = UnitContentSchema.extend({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).nullable().optional(),
  instructionOverride: z.string().trim().max(20_000).nullable().optional(),
  languageCode: LanguageCodeSchema,
  expectedRevision: z.number().int().positive(),
});

export const UnitSchema = UnitContentSchema.extend({
  id: UuidSchema,
  collectionId: UuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  instructionOverride: z.string().nullable(),
  languageCode: LanguageCodeSchema,
  revision: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
}).openapi("Unit");

export const PaginatedUnitsSchema = z
  .object({
    items: z.array(
      UnitSchema.pick({
        id: true,
        collectionId: true,
        name: true,
        description: true,
        instructionOverride: true,
        languageCode: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      }),
    ),
    nextCursor: CursorSchema.nullable(),
  })
  .openapi("PaginatedUnits");

export const UnitRevisionSummarySchema = z
  .object({
    id: UuidSchema,
    unitId: UuidSchema,
    revision: z.number().int().positive(),
    createdBy: UuidSchema.nullable(),
    action: z.enum(["created", "updated", "restored", "deleted", "undeleted"]),
    createdAt: TimestampSchema,
  })
  .openapi("UnitRevisionSummary");

export const PaginatedUnitRevisionsSchema = z
  .object({
    items: z.array(UnitRevisionSummarySchema),
    nextCursor: CursorSchema.nullable(),
  })
  .openapi("PaginatedUnitRevisions");

const LessonIdSchema = z.string().min(1).max(120);
const LessonTextSchema = z.string().min(1).max(16_000);
const LessonOptionSchema = z
  .object({
    id: LessonIdSchema,
    label: LessonTextSchema.max(500),
  })
  .strict();
const LessonAnswerBankSchema = z
  .object({
    tokens: z.array(LessonOptionSchema).min(2).max(30),
    separator: z.enum(["space", "none"]),
    defaultMode: z.enum(["keyboard", "bank"]),
  })
  .strict();
const LessonTextMatchSchema = z
  .object({
    caseSensitive: z.boolean().optional(),
    ignoreDiacritics: z.boolean().optional(),
    ignorePunctuation: z.boolean().optional(),
  })
  .strict();
const LessonPresentationSchema = z
  .object({
    readQuestion: z.boolean(),
    readAnswers: z.boolean(),
    wordTooltips: z.boolean(),
  })
  .strict();

export const TrackingTargetsSchema = z
  .object({
    words: z.array(LessonTextSchema.max(2_000)).max(80),
    phrases: z.array(LessonTextSchema.max(2_000)).max(80),
    sentences: z.array(LessonTextSchema.max(2_000)).max(80),
  })
  .strict()
  .superRefine((targets, context) => {
    (["words", "phrases", "sentences"] as const).forEach((kind) => {
      if (new Set(targets[kind]).size !== targets[kind].length) {
        context.addIssue({
          code: "custom",
          path: [kind],
          message: `${kind} tracking values must be unique`,
        });
      }
    });
  });

const QuestionTrackingSchema = z
  .object({
    encountered: TrackingTargetsSchema,
    assessed: TrackingTargetsSchema,
  })
  .strict()
  .superRefine((tracking, context) => {
    (["words", "phrases", "sentences"] as const).forEach((kind) => {
      const encountered = new Set(tracking.encountered[kind]);
      tracking.assessed[kind].forEach((term, index) => {
        if (!encountered.has(term)) {
          context.addIssue({
            code: "custom",
            path: ["assessed", kind, index],
            message: "An assessed target must also be encountered",
          });
        }
      });
    });
  });

const LessonPronunciationSchema = z
  .object({
    native: LessonTextSchema.max(300).optional(),
    romanized: LessonTextSchema.max(300).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.native || value.romanized),
    "Pronunciation needs a native or romanized value",
  );

const LessonGlossaryEntrySchema = z
  .object({
    term: LessonTextSchema.max(300),
    meaning: LessonTextSchema.max(1_000),
    otherMeanings: z.array(LessonTextSchema.max(1_000)).max(8).optional(),
    forms: z.array(LessonTextSchema.max(300)).max(20).optional(),
    aliases: z.array(LessonTextSchema.max(300)).max(20).optional(),
    pronunciation: LessonPronunciationSchema.optional(),
    example: LessonTextSchema.optional(),
  })
  .strict();

const LessonQuestionBaseFields = {
  id: LessonIdSchema,
  prompt: LessonTextSchema,
  targetPrompt: LessonTextSchema.optional(),
  explanation: LessonTextSchema,
  hint: LessonTextSchema.optional(),
  supplementalHint: LessonTextSchema.optional(),
  sourceReferenceIds: z.array(LessonIdSchema).max(20).optional(),
  evaluationMode: z.enum(["local", "ai"]),
  presentation: LessonPresentationSchema.optional(),
  glossaryTargets: z.array(LessonTextSchema.max(2_000)).max(80).optional(),
  tracking: QuestionTrackingSchema,
  answerBank: LessonAnswerBankSchema.optional(),
};

const LessonQuestionUnionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("singleChoice"),
      options: z.array(LessonOptionSchema).min(2).max(10),
      correctOptionId: LessonIdSchema,
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("multipleChoice"),
      options: z.array(LessonOptionSchema).min(2).max(12),
      correctOptionIds: z.array(LessonIdSchema).min(1).max(12),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("trueFalse"),
      statement: LessonTextSchema,
      correct: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("fillBlank"),
      template: LessonTextSchema,
      acceptedAnswers: z.array(LessonTextSchema.max(500)).min(1).max(20),
      match: LessonTextMatchSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("selectBlank"),
      template: LessonTextSchema,
      options: z.array(LessonOptionSchema).min(2).max(8),
      correctOptionId: LessonIdSchema,
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("multiCloze"),
      template: LessonTextSchema,
      blanks: z
        .array(
          z
            .object({
              id: LessonIdSchema,
              acceptedAnswers: z.array(LessonTextSchema.max(500)).min(1).max(20),
            })
            .strict(),
        )
        .min(2)
        .max(12),
      match: LessonTextMatchSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("wordBank"),
      tokens: z.array(LessonOptionSchema).min(2).max(30),
      correctOrderIds: z.array(LessonIdSchema).min(1).max(30),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("matching"),
      pairs: z
        .array(
          z
            .object({
              leftId: LessonIdSchema,
              left: LessonTextSchema.max(500),
              rightId: LessonIdSchema,
              right: LessonTextSchema.max(500),
            })
            .strict(),
        )
        .min(2)
        .max(12),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("reorderTokens"),
      tokens: z.array(LessonOptionSchema).min(2).max(30),
      correctOrderIds: z.array(LessonIdSchema).min(2).max(30),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("reorderDialogue"),
      turns: z
        .array(
          LessonOptionSchema.extend({
            speaker: LessonTextSchema.max(120),
          }).strict(),
        )
        .min(2)
        .max(20),
      correctOrderIds: z.array(LessonIdSchema).min(2).max(20),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("categorize"),
      categories: z.array(LessonOptionSchema).min(2).max(10),
      items: z
        .array(
          LessonOptionSchema.extend({
            categoryId: LessonIdSchema,
          }).strict(),
        )
        .min(2)
        .max(30),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("translation"),
      sourceText: LessonTextSchema,
      targetLanguage: LessonTextSchema.max(100),
      referenceAnswer: LessonTextSchema,
      rubric: z.array(LessonTextSchema.max(500)).min(1).max(10),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("shortAnswer"),
      referenceAnswer: LessonTextSchema,
      requiredIdeas: z.array(LessonTextSchema.max(500)).min(1).max(12),
      rubric: z.array(LessonTextSchema.max(500)).min(1).max(10),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("errorCorrection"),
      incorrectText: LessonTextSchema,
      acceptedAnswers: z.array(LessonTextSchema).min(1).max(20),
      match: LessonTextMatchSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("sentenceTransformation"),
      sourceText: LessonTextSchema,
      constraint: LessonTextSchema,
      acceptedAnswers: z.array(LessonTextSchema).min(1).max(20),
      match: LessonTextMatchSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("dictation"),
      transcript: LessonTextSchema,
      acceptedAnswers: z.array(LessonTextSchema).min(1).max(20),
      match: LessonTextMatchSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("freeWriting"),
      minWords: z.number().int().min(1).max(1_000),
      maxWords: z.number().int().min(1).max(2_000),
      rubric: z.array(LessonTextSchema.max(500)).min(1).max(12),
      supportBank: z.array(LessonOptionSchema).min(8).max(30).optional(),
      supportBankSeparator: z.enum(["space", "none"]).optional(),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("speakingRepeat"),
      modelText: LessonTextSchema,
      rubric: z.array(LessonTextSchema.max(500)).min(1).max(12),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("speakingRoleplay"),
      role: LessonTextSchema.max(500),
      scenario: LessonTextSchema,
      goal: LessonTextSchema,
      rubric: z.array(LessonTextSchema.max(500)).min(1).max(12),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("listenSelect"),
      audioText: LessonTextSchema,
      options: z.array(LessonOptionSchema).min(2).max(8),
      correctOptionId: LessonIdSchema,
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("audioMatching"),
      pairs: z
        .array(
          z
            .object({
              audioId: LessonIdSchema,
              audioText: LessonTextSchema.max(500),
              matchId: LessonIdSchema,
              label: LessonTextSchema.max(500),
            })
            .strict(),
        )
        .min(2)
        .max(8),
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("soundDiscrimination"),
      audioText: LessonTextSchema,
      options: z.array(LessonOptionSchema).min(2).max(8),
      correctOptionId: LessonIdSchema,
    })
    .strict(),
  z
    .object({
      ...LessonQuestionBaseFields,
      type: z.literal("flashcardRecall"),
      cue: LessonTextSchema,
      acceptedAnswers: z.array(LessonTextSchema.max(500)).min(1).max(20),
      match: LessonTextMatchSchema.optional(),
    })
    .strict(),
]);

const LESSON_LISTENING_FORMATS = new Set([
  "dictation",
  "listenSelect",
  "audioMatching",
  "soundDiscrimination",
]);
const LESSON_WRITTEN_FORMATS = new Set([
  "fillBlank",
  "multiCloze",
  "translation",
  "shortAnswer",
  "errorCorrection",
  "sentenceTransformation",
  "dictation",
  "freeWriting",
]);
const LESSON_AI_EVALUATED_FORMATS = new Set([
  "translation",
  "shortAnswer",
  "freeWriting",
  "speakingRepeat",
  "speakingRoleplay",
]);
const LESSON_SENTENCE_ENDING_PUNCTUATION = /[.!?。！？…]+$/u;

function normalizeLessonBankText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

const LESSON_BANK_COMPOSITION_STATE_LIMIT = 2_048;
const LESSON_PAYLOAD_COMPOSITION_STATE_LIMIT = 512;

type LessonBankCompositionStatus = "composable" | "not-composable" | "budget-exceeded";
interface LessonBankCompositionBudget {
  remaining: number;
}

function lessonBankCompositionStatus(
  referenceAnswer: string,
  tokens: ReadonlyArray<{ id: string; label: string }>,
  minimumTokenCount = 1,
  budget: LessonBankCompositionBudget = { remaining: LESSON_BANK_COMPOSITION_STATE_LIMIT },
): LessonBankCompositionStatus {
  const target = normalizeLessonBankText(referenceAnswer);
  if (!target) return "not-composable";
  const inventory = new Map<string, number>();
  tokens.forEach((token) => {
    const text = normalizeLessonBankText(token.label);
    if (text) inventory.set(text, (inventory.get(text) ?? 0) + 1);
  });
  const parts = [...inventory].map(([text, available]) => ({ text, available }));
  const totalAvailableLength = parts.reduce(
    (total, part) => total + part.text.length * part.available,
    0,
  );
  if (target.length > totalAvailableLength) return "not-composable";

  const failed = new Set<string>();
  const usedCounts = Array.from({ length: parts.length }, () => 0);
  let budgetExceeded = false;

  function visit(offset: number, count: number): boolean {
    if (offset === target.length) return count >= minimumTokenCount;
    const key = `${offset}|${usedCounts.join(",")}`;
    if (failed.has(key)) return false;
    if (budget.remaining <= 0) {
      budgetExceeded = true;
      return false;
    }
    budget.remaining -= 1;

    for (let index = 0; index < parts.length; index += 1) {
      const token = parts[index];
      if (!token) continue;
      const used = usedCounts[index] ?? 0;
      if (used >= token.available || !target.startsWith(token.text, offset)) continue;
      usedCounts[index] = used + 1;
      const composed = visit(offset + token.text.length, count + 1);
      usedCounts[index] = used;
      if (composed) return true;
      if (budgetExceeded) return false;
    }
    failed.add(key);
    return false;
  }

  const composed = visit(0, 0);
  if (composed) return "composable";
  return budgetExceeded ? "budget-exceeded" : "not-composable";
}

function lessonBankCompositionStatusForAny(
  referenceAnswers: readonly string[],
  tokens: ReadonlyArray<{ id: string; label: string }>,
  minimumTokenCount = 1,
  budget: LessonBankCompositionBudget = { remaining: LESSON_BANK_COMPOSITION_STATE_LIMIT },
): LessonBankCompositionStatus {
  let budgetExceeded = false;
  for (const answer of referenceAnswers) {
    const status = lessonBankCompositionStatus(answer, tokens, minimumTokenCount, budget);
    if (status === "composable") return status;
    if (status === "budget-exceeded") budgetExceeded = true;
  }
  return budgetExceeded ? "budget-exceeded" : "not-composable";
}

function lessonBankHasWholeReference(
  referenceAnswer: string,
  tokens: ReadonlyArray<{ label: string }>,
): boolean {
  const reference = normalizeLessonBankText(referenceAnswer);
  return tokens.some((token) => normalizeLessonBankText(token.label) === reference);
}

function lessonLexicalUnitCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function lessonNeedsSentenceBank(
  value: string,
  lexicalUnitCount = lessonLexicalUnitCount(value),
): boolean {
  return LESSON_SENTENCE_ENDING_PUNCTUATION.test(value.trim()) || lexicalUnitCount > 2;
}

type LessonQuestionPayload = z.infer<typeof LessonQuestionUnionSchema>;

function lessonExpectedBankAnswers(question: LessonQuestionPayload): string[] {
  if (question.type === "translation" || question.type === "shortAnswer") {
    return [question.referenceAnswer];
  }
  if (
    question.type === "errorCorrection" ||
    question.type === "sentenceTransformation" ||
    question.type === "dictation"
  ) {
    return question.acceptedAnswers;
  }
  return [];
}

function lessonIsDeclaredBlankToken(
  question: LessonQuestionPayload,
  label: string,
): boolean {
  const normalizedLabel = normalizeLessonBankText(label);
  if (!normalizedLabel) return false;
  if (question.type === "fillBlank") {
    return question.acceptedAnswers.some(
      (answer) => normalizeLessonBankText(answer) === normalizedLabel,
    );
  }
  if (question.type === "multiCloze") {
    return question.blanks.some((blank) =>
      blank.acceptedAnswers.some(
        (answer) => normalizeLessonBankText(answer) === normalizedLabel,
      ),
    );
  }
  return false;
}

export const QuestionSchema = LessonQuestionUnionSchema.superRefine((question, context) => {
  if (question.answerBank) {
    const tokenIds = new Set(question.answerBank.tokens.map((token) => token.id));
    if (tokenIds.size !== question.answerBank.tokens.length) {
      context.addIssue({
        code: "custom",
        path: ["answerBank", "tokens"],
        message: "Answer-bank token IDs must be unique",
      });
    }
    if (!LESSON_WRITTEN_FORMATS.has(question.type)) {
      context.addIssue({
        code: "custom",
        path: ["answerBank"],
        message: `${question.type} cannot define an answer bank`,
      });
    } else {
      const expectedMode =
        question.type === "shortAnswer" || question.type === "freeWriting"
          ? "keyboard"
          : "bank";
      if (question.answerBank.defaultMode !== expectedMode) {
        context.addIssue({
          code: "custom",
          path: ["answerBank", "defaultMode"],
          message: `${question.type} answerBank.defaultMode must be ${expectedMode}`,
        });
      }
    }
    question.answerBank.tokens.forEach((token, index) => {
      if (LESSON_SENTENCE_ENDING_PUNCTUATION.test(token.label.trim())) {
        context.addIssue({
          code: "custom",
          path: ["answerBank", "tokens", index, "label"],
          message: "Answer-bank tokens must not include sentence-ending punctuation",
        });
      }
      if (
        lessonLexicalUnitCount(token.label) > 2 &&
        !lessonIsDeclaredBlankToken(question, token.label)
      ) {
        context.addIssue({
          code: "custom",
          path: ["answerBank", "tokens", index, "label"],
          message: "Answer-bank tokens must contain at most two lexical units",
        });
      }
    });
    const sentenceAnswers = lessonExpectedBankAnswers(question).filter((answer) =>
      lessonNeedsSentenceBank(answer),
    );
    if (
      sentenceAnswers.some((answer) =>
        lessonBankHasWholeReference(answer, question.answerBank!.tokens),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["answerBank", "tokens"],
        message: `${question.type} answer banks cannot contain a complete sentence answer in one token`,
      });
    }
    if (sentenceAnswers.length > 0) {
      const compositionStatus = lessonBankCompositionStatusForAny(
        sentenceAnswers,
        question.answerBank.tokens,
        2,
      );
      if (compositionStatus !== "composable") {
        context.addIssue({
          code: "custom",
          path: ["answerBank", "tokens"],
          message: compositionStatus === "budget-exceeded"
            ? `${question.type} answer-bank composition exceeds the validation complexity limit`
            : `${question.type} answer-bank tokens must compose an answer exactly`,
        });
      }
    }
  }

  if (question.type === "selectBlank") {
    const blankCount = question.template.split("{{blank}}").length - 1;
    if (blankCount !== 1) {
      context.addIssue({
        code: "custom",
        path: ["template"],
        message: "selectBlank requires exactly one {{blank}} marker",
      });
    }
  }
  if (question.type === "fillBlank") {
    const markers = question.template.match(/\{\{blank(?::[^{}]+)?\}\}/g) ?? [];
    if (markers.length !== 1 || question.template.includes("___")) {
      context.addIssue({
        code: "custom",
        path: ["template"],
        message: "fillBlank requires exactly one blank marker",
      });
    }
  }
  if (
    question.type === "selectBlank" ||
    question.type === "listenSelect" ||
    question.type === "soundDiscrimination"
  ) {
    const optionIds = new Set(question.options.map((option) => option.id));
    if (optionIds.size !== question.options.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: `${question.type} option IDs must be unique`,
      });
    }
    if (!optionIds.has(question.correctOptionId)) {
      context.addIssue({
        code: "custom",
        path: ["correctOptionId"],
        message: `${question.type} correctOptionId must reference an option`,
      });
    }
  }
  if (question.type === "audioMatching") {
    const audioIds = new Set(question.pairs.map((pair) => pair.audioId));
    const matchIds = new Set(question.pairs.map((pair) => pair.matchId));
    if (
      audioIds.size !== question.pairs.length ||
      matchIds.size !== question.pairs.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["pairs"],
        message: "Audio-matching IDs must be unique",
      });
    }
  }
});

function parseLessonMultiClozeMarkers(
  template: string,
  blankIds: string[],
): string[] {
  const markerPattern = /\{\{blank(?::([^{}]+))?\}\}/g;
  const markerIds: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(template))) {
    const markerId =
      match[1] ||
      (blankIds.length === 1
        ? blankIds[0] ?? ""
        : blankIds[markerIds.length] ?? "");
    markerIds.push(markerId);
  }

  const errors: string[] = [];
  if (markerIds.length === 0 || markerIds.some((markerId) => !markerId)) {
    return ["Blank templates need {{blank}} or {{blank:<id>}} markers"];
  }
  const expected = new Set(blankIds);
  const seen = new Set<string>();
  if (expected.size !== blankIds.length) errors.push("Multi-blank IDs must be unique");
  markerIds.forEach((markerId) => {
    if (!expected.has(markerId)) errors.push(`Unknown multi-blank marker ${markerId}`);
    if (seen.has(markerId)) errors.push(`Multi-blank marker ${markerId} appears more than once`);
    seen.add(markerId);
  });
  blankIds.forEach((blankId) => {
    if (!seen.has(blankId)) errors.push(`Multi-blank marker ${blankId} is missing`);
  });
  return errors;
}

function stripLessonBlankMarkers(text: string): string {
  return text
    .replace(/\{\{blank(?::[^{}]+)?\}\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type LessonGlossaryEntry = z.infer<typeof LessonGlossaryEntrySchema>;
interface LessonGlossarySegment {
  text: string;
  entry?: LessonGlossaryEntry;
}
interface LessonGlossaryCandidate {
  entry: LessonGlossaryEntry;
  term: string;
}

function lessonIsWordCharacter(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}\p{M}]/u.test(value));
}

function lessonHasGlossaryBoundaries(
  text: string,
  index: number,
  term: string,
): boolean {
  const usesWhitespaceBoundaries =
    /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{N}\p{M}\s'’-]+$/u.test(
      term,
    );
  if (!usesWhitespaceBoundaries) return true;
  const before = text[index - 1];
  const first = term[0];
  const last = term[term.length - 1];
  const after = text[index + term.length];
  if (lessonIsWordCharacter(before) && lessonIsWordCharacter(first)) return false;
  if (lessonIsWordCharacter(last) && lessonIsWordCharacter(after)) return false;
  return true;
}

function lessonGlossaryCandidates(
  glossary: LessonGlossaryEntry[],
): LessonGlossaryCandidate[] {
  const seenTerms = new Set<string>();
  return glossary
    .flatMap((entry) =>
      [entry.term, ...(entry.forms ?? []), ...(entry.aliases ?? [])].map((term) => ({
        entry,
        term: term.trim(),
      })),
    )
    .filter(({ term }) => {
      const normalized = term.toLocaleLowerCase();
      if (!normalized || seenTerms.has(normalized)) return false;
      seenTerms.add(normalized);
      return true;
    })
    .sort((left, right) => right.term.length - left.term.length);
}

function segmentLessonGlossaryWithCandidates(
  text: string,
  entries: LessonGlossaryCandidate[],
): LessonGlossarySegment[] {
  const segments: LessonGlossarySegment[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const match = entries.find((candidate) => {
      const slice = text.slice(index, index + candidate.term.length);
      return (
        slice.toLocaleLowerCase() === candidate.term.toLocaleLowerCase() &&
        lessonHasGlossaryBoundaries(text, index, candidate.term)
      );
    });
    if (!match) {
      index += 1;
      continue;
    }
    if (plainStart < index) segments.push({ text: text.slice(plainStart, index) });
    segments.push({
      text: text.slice(index, index + match.term.length),
      entry: match.entry,
    });
    index += match.term.length;
    plainStart = index;
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart) });
  return segments.length > 0 ? segments : [{ text }];
}

function lessonHasCompleteLexicalCoverage(
  segments: LessonGlossarySegment[],
): boolean {
  return (
    segments.filter((segment) => segment.entry).length >= 2 &&
    segments.every(
      (segment) => Boolean(segment.entry) || !/[\p{L}\p{N}\p{M}]/u.test(segment.text),
    )
  );
}

function segmentLessonGlossary(
  text: string,
  glossary: LessonGlossaryEntry[],
  lexicalCjk = false,
): LessonGlossarySegment[] {
  if (!text || glossary.length === 0) return text ? [{ text }] : [];

  const entries = lessonGlossaryCandidates(glossary);
  if (lexicalCjk) {
    const normalizedText = text.trim().toLocaleLowerCase();
    const normalizedWithoutPunctuation = normalizedText.replace(
      LESSON_SENTENCE_ENDING_PUNCTUATION,
      "",
    );
    const wholeSentenceEntries = new Set(
      glossary.filter((entry) =>
        [entry.term, ...(entry.forms ?? []), ...(entry.aliases ?? [])].some(
          (candidate) => {
            const normalizedCandidate = candidate.trim().toLocaleLowerCase();
            return (
              normalizedCandidate === normalizedText ||
              normalizedCandidate === normalizedWithoutPunctuation
            );
          },
        ),
      ),
    );
    const componentEntries = lessonGlossaryCandidates(
      glossary.filter((entry) => !wholeSentenceEntries.has(entry)),
    );
    const lexicalSegments = segmentLessonGlossaryWithCandidates(text, componentEntries);
    if (lessonHasCompleteLexicalCoverage(lexicalSegments)) return lexicalSegments;
  }
  return segmentLessonGlossaryWithCandidates(text, entries);
}

function lessonQuestionVisibleTexts(question: LessonQuestionPayload): string[] {
  const parts = [question.prompt];
  if (question.targetPrompt) parts.push(question.targetPrompt);
  switch (question.type) {
    case "singleChoice":
    case "multipleChoice":
    case "selectBlank":
      parts.push(...question.options.map((option) => option.label));
      if (question.type === "selectBlank") {
        parts.push(question.template.replace("{{blank}}", ""));
      }
      break;
    case "trueFalse":
      parts.push(question.statement);
      break;
    case "fillBlank":
    case "multiCloze":
      parts.push(question.template);
      break;
    case "wordBank":
    case "reorderTokens":
      parts.push(...question.tokens.map((token) => token.label));
      break;
    case "matching":
      parts.push(...question.pairs.flatMap((pair) => [pair.left, pair.right]));
      break;
    case "reorderDialogue":
      parts.push(...question.turns.flatMap((turn) => [turn.speaker, turn.label]));
      break;
    case "categorize":
      parts.push(
        ...question.categories.map((category) => category.label),
        ...question.items.map((item) => item.label),
      );
      break;
    case "translation":
      parts.push(question.sourceText);
      break;
    case "errorCorrection":
      parts.push(question.incorrectText);
      break;
    case "sentenceTransformation":
      parts.push(question.sourceText, question.constraint);
      break;
    case "dictation":
      parts.push(question.transcript);
      break;
    case "freeWriting":
      parts.push(...(question.supportBank ?? []).map((token) => token.label));
      break;
    case "speakingRepeat":
      parts.push(question.modelText);
      break;
    case "speakingRoleplay":
      parts.push(question.role, question.scenario, question.goal);
      break;
    case "listenSelect":
    case "soundDiscrimination":
      parts.push(question.audioText, ...question.options.map((option) => option.label));
      break;
    case "audioMatching":
      parts.push(...question.pairs.flatMap((pair) => [pair.audioText, pair.label]));
      break;
    case "flashcardRecall":
      parts.push(question.cue);
      break;
    case "shortAnswer":
      break;
  }
  parts.push(...(question.answerBank?.tokens ?? []).map((token) => token.label));
  return parts.filter((part) => part.trim().length > 0);
}

function lessonTargetHasGlossaryCoverage(
  target: string,
  glossary: LessonGlossaryEntry[],
): boolean {
  return segmentLessonGlossary(stripLessonBlankMarkers(target), glossary).every(
    (segment) => Boolean(segment.entry) || !/[\p{L}\p{N}\p{M}]/u.test(segment.text),
  );
}

function lessonCjkLexicalUnitCount(
  value: string,
  glossary: LessonGlossaryEntry[],
): number | undefined {
  const segments = segmentLessonGlossary(value, glossary, true);
  if (
    segments.some(
      (segment) => !segment.entry && /[\p{L}\p{N}\p{M}]/u.test(segment.text),
    )
  ) {
    return undefined;
  }
  const count = segments.filter(
    (segment) => segment.entry && /[\p{L}\p{N}\p{M}]/u.test(segment.text),
  ).length;
  return count || undefined;
}

function validateLessonQuestionForLanguage(
  question: LessonQuestionPayload,
  lesson: { targetLanguage: string; glossary: LessonGlossaryEntry[] },
): string[] {
  const errors: string[] = [];
  if (
    question.targetPrompt &&
    !lessonTargetHasGlossaryCoverage(question.targetPrompt, lesson.glossary)
  ) {
    errors.push(`Question ${question.id} targetPrompt is not covered by the glossary`);
  }
  if (!["Japanese", "Chinese", "Korean"].includes(lesson.targetLanguage)) {
    return errors;
  }

  const missingPronunciation = new Set<string>();
  question.answerBank?.tokens.forEach((token) => {
    const lexicalUnits = lessonCjkLexicalUnitCount(token.label, lesson.glossary);
    if (
      lexicalUnits !== undefined &&
      lexicalUnits > 2 &&
      !lessonIsDeclaredBlankToken(question, token.label)
    ) {
      errors.push(`Answer-bank token ${token.label} has too many CJK lexical units`);
    }
  });
  const sentenceAnswers = lessonExpectedBankAnswers(question).filter((answer) => {
    const lexicalUnits = lessonCjkLexicalUnitCount(answer, lesson.glossary);
    return lessonNeedsSentenceBank(answer, lexicalUnits);
  });
  if (
    question.answerBank &&
    sentenceAnswers.some((answer) =>
      lessonBankHasWholeReference(answer, question.answerBank!.tokens),
    )
  ) {
    errors.push(`Question ${question.id} answer bank contains a complete sentence`);
  }
  if (question.answerBank && sentenceAnswers.length > 0) {
    const compositionStatus = lessonBankCompositionStatusForAny(
      sentenceAnswers,
      question.answerBank.tokens,
      2,
    );
    if (compositionStatus === "budget-exceeded") {
      errors.push(`Question ${question.id} answer-bank composition exceeds the validation complexity limit`);
    } else if (compositionStatus === "not-composable") {
      errors.push(`Question ${question.id} answer bank cannot compose an answer`);
    }
  }
  (question.glossaryTargets ?? []).forEach((target) => {
    const visibleTarget = stripLessonBlankMarkers(target);
    const lexicalSegments = segmentLessonGlossary(
      visibleTarget,
      lesson.glossary,
      true,
    );
    if (
      LESSON_SENTENCE_ENDING_PUNCTUATION.test(visibleTarget.trim()) &&
      (lexicalSegments.filter((segment) => segment.entry).length < 2 ||
        lexicalSegments.some(
          (segment) =>
            !segment.entry && /[\p{L}\p{N}\p{M}]/u.test(segment.text),
        ))
    ) {
      errors.push(`CJK glossary target ${target} needs lexical entries`);
    }
    lexicalSegments.forEach((segment) => {
      if (
        !segment.entry ||
        !/[\p{L}\p{N}\p{M}]/u.test(segment.text)
      ) {
        return;
      }
      if (
        !segment.entry.pronunciation?.native &&
        !segment.entry.pronunciation?.romanized
      ) {
        missingPronunciation.add(segment.entry.term);
      }
    });
  });
  missingPronunciation.forEach((term) => {
    errors.push(`Target-language glossary term ${term} needs pronunciation metadata`);
  });
  return errors;
}

function validateLessonQuestionGlossary(
  question: LessonQuestionPayload,
  glossary: LessonGlossaryEntry[],
): string[] {
  if (question.glossaryTargets === undefined) {
    return [`Question ${question.id} needs glossaryTargets`];
  }
  if (question.glossaryTargets.length === 0) {
    return question.type === "translation" || question.type === "flashcardRecall"
      ? []
      : [`Question ${question.id} needs at least one glossary target`];
  }

  const visibleTexts = lessonQuestionVisibleTexts(question);
  const errors: string[] = [];
  question.glossaryTargets.forEach((target) => {
    if (!visibleTexts.some((text) => text.includes(target))) {
      errors.push(`Question ${question.id} glossary target is not visible: ${target}`);
    } else if (!lessonTargetHasGlossaryCoverage(target, glossary)) {
      errors.push(`Question ${question.id} glossary target is not covered: ${target}`);
    }
  });
  return errors;
}

function lessonTrackingMatches(
  primary: z.infer<typeof QuestionTrackingSchema>,
  alternate: z.infer<typeof QuestionTrackingSchema>,
): boolean {
  return (["encountered", "assessed"] as const).every((mode) =>
    (["words", "phrases", "sentences"] as const).every((kind) => {
      const left = new Set(primary[mode][kind]);
      const right = new Set(alternate[mode][kind]);
      return left.size === right.size && [...left].every((term) => right.has(term));
    }),
  );
}

function isUnknownLessonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rawLessonCompositionCandidate(
  value: unknown,
): { answers: string[]; tokens: Array<{ id: string; label: string }> } | "invalid" | null {
  if (!isUnknownLessonRecord(value)) return null;
  const relevantType = value.type === "translation"
    || value.type === "shortAnswer"
    || value.type === "errorCorrection"
    || value.type === "sentenceTransformation"
    || value.type === "dictation";
  if (!relevantType || value.answerBank === undefined) return null;
  if (!isUnknownLessonRecord(value.answerBank)) return "invalid";
  const rawTokens = value.answerBank.tokens;
  if (!Array.isArray(rawTokens) || rawTokens.length < 2 || rawTokens.length > 30) return "invalid";
  const tokens: Array<{ id: string; label: string }> = [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index];
    if (!isUnknownLessonRecord(token) || typeof token.label !== "string" || token.label.length > 500) {
      return "invalid";
    }
    tokens.push({ id: String(index), label: token.label });
  }

  let answers: unknown[] = [];
  if (value.type === "translation" || value.type === "shortAnswer") {
    answers = [value.referenceAnswer];
  } else if (
    value.type === "errorCorrection"
    || value.type === "sentenceTransformation"
    || value.type === "dictation"
  ) {
    answers = Array.isArray(value.acceptedAnswers) ? value.acceptedAnswers : [];
  }
  if (
    answers.length > 20
    || answers.some((answer) => typeof answer !== "string" || answer.length > 16_000)
  ) {
    return "invalid";
  }
  return { answers: answers as string[], tokens };
}

function lessonCompositionStaysWithinBudget(value: unknown): boolean {
  if (!isUnknownLessonRecord(value)) return true;
  const primary = Array.isArray(value.questions) ? value.questions : [];
  const alternates = Array.isArray(value.questionAlternates)
    ? value.questionAlternates.map((alternate) => (
      isUnknownLessonRecord(alternate) ? alternate.question : undefined
    ))
    : [];
  if (primary.length > 23 || alternates.length > 23) return false;

  const budget = { remaining: LESSON_PAYLOAD_COMPOSITION_STATE_LIMIT };
  const isCjk = value.targetLanguage === "Japanese"
    || value.targetLanguage === "Chinese"
    || value.targetLanguage === "Korean";
  for (const rawQuestion of [...primary, ...alternates]) {
    const candidate = rawLessonCompositionCandidate(rawQuestion);
    if (candidate === "invalid") return false;
    if (!candidate) continue;
    const answers = isCjk
      ? candidate.answers
      : candidate.answers.filter((answer) => lessonNeedsSentenceBank(answer));
    if (
      answers.length > 0
      && lessonBankCompositionStatusForAny(answers, candidate.tokens, 2, budget) === "budget-exceeded"
    ) {
      return false;
    }
  }
  return true;
}

const LessonPayloadStructureSchema = z
  .object({
    schemaVersion: z.literal(8),
    id: LessonIdSchema,
    unitId: LessonIdSchema,
    title: LessonTextSchema.max(300),
    summary: LessonTextSchema.max(2_000),
    targetLanguage: LessonTextSchema.max(100),
    sourceLanguage: LessonTextSchema.max(100),
    level: z.enum([
      "beginner",
      "elementary",
      "intermediate",
      "upperIntermediate",
      "advanced",
    ]),
    objectives: z.array(LessonTextSchema.max(500)).min(1).max(12),
    theory: z
      .array(
        z
          .object({
            id: LessonIdSchema,
            kind: z.enum(["concept", "grammar", "pronunciation", "culture", "tip"]),
            title: LessonTextSchema.max(300),
            body: LessonTextSchema,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    examples: z
      .array(
        z
          .object({
            id: LessonIdSchema,
            source: LessonTextSchema,
            translation: LessonTextSchema.optional(),
            note: LessonTextSchema.optional(),
          })
          .strict(),
      )
      .max(30),
    glossary: z.array(LessonGlossaryEntrySchema).max(160),
    sourceReferences: z
      .array(
        z
          .object({
            id: LessonIdSchema,
            kind: z.enum(["unit", "document", "youtube", "transcript", "note"]),
            title: LessonTextSchema.max(500),
            url: z.url().max(2_000).optional(),
            excerpt: LessonTextSchema.max(2_000).optional(),
          })
          .strict(),
      )
      .max(50),
    questions: z.array(QuestionSchema).min(8).max(23),
    questionAlternates: z
      .array(
        z
          .object({
            questionId: LessonIdSchema,
            question: QuestionSchema,
          })
          .strict(),
      )
      .min(8)
      .max(23),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((lesson, context) => {
    const formats = new Set(lesson.questions.map((question) => question.type));
    if (formats.size < 5) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "A lesson must contain at least five question formats",
      });
    }

    const questionIds = new Set<string>();
    lesson.questions.forEach((question, index) => {
      if (questionIds.has(question.id)) {
        context.addIssue({
          code: "custom",
          path: ["questions", index, "id"],
          message: "Question IDs must be unique",
        });
      }
      questionIds.add(question.id);
      if (question.type === "multiCloze") {
        parseLessonMultiClozeMarkers(
          question.template,
          question.blanks.map((blank) => blank.id),
        ).forEach((message) => {
          context.addIssue({
            code: "custom",
            path: ["questions", index, "template"],
            message,
          });
        });
      }
      validateLessonQuestionForLanguage(question, lesson).forEach((message) => {
        context.addIssue({
          code: "custom",
          path: ["questions", index],
          message,
        });
      });
    });

    const alternateSlotIds = new Set<string>();
    const allQuestionIds = new Set(questionIds);
    lesson.questionAlternates.forEach((alternate, index) => {
      if (!questionIds.has(alternate.questionId)) {
        context.addIssue({
          code: "custom",
          path: ["questionAlternates", index, "questionId"],
          message: "Alternate must reference a primary question",
        });
      }
      if (alternateSlotIds.has(alternate.questionId)) {
        context.addIssue({
          code: "custom",
          path: ["questionAlternates", index, "questionId"],
          message: "Each primary question can have only one alternate",
        });
      }
      alternateSlotIds.add(alternate.questionId);
      if (allQuestionIds.has(alternate.question.id)) {
        context.addIssue({
          code: "custom",
          path: ["questionAlternates", index, "question", "id"],
          message: "Primary and alternate question IDs must be unique",
        });
      }
      allQuestionIds.add(alternate.question.id);

      const primary = lesson.questions.find(
        (question) => question.id === alternate.questionId,
      );
      if (primary?.type === alternate.question.type) {
        context.addIssue({
          code: "custom",
          path: ["questionAlternates", index, "question", "type"],
          message: "Alternate must use a different format",
        });
      }
      if (
        primary &&
        LESSON_LISTENING_FORMATS.has(primary.type) &&
        LESSON_LISTENING_FORMATS.has(alternate.question.type)
      ) {
        context.addIssue({
          code: "custom",
          path: ["questionAlternates", index, "question", "type"],
          message: "Listening alternates cannot require listening",
        });
      }
      if (
        primary &&
        !lessonTrackingMatches(primary.tracking, alternate.question.tracking)
      ) {
        context.addIssue({
          code: "custom",
          path: ["questionAlternates", index, "question", "tracking"],
          message: "Alternate tracking must match its primary question",
        });
      }
      if (alternate.question.type === "multiCloze") {
        parseLessonMultiClozeMarkers(
          alternate.question.template,
          alternate.question.blanks.map((blank) => blank.id),
        ).forEach((message) => {
          context.addIssue({
            code: "custom",
            path: ["questionAlternates", index, "question", "template"],
            message,
          });
        });
      }
      validateLessonQuestionForLanguage(alternate.question, lesson).forEach(
        (message) => {
          context.addIssue({
            code: "custom",
            path: ["questionAlternates", index, "question"],
            message,
          });
        },
      );
    });

    if (lesson.questionAlternates.length !== lesson.questions.length) {
      context.addIssue({
        code: "custom",
        path: ["questionAlternates"],
        message: "Schema-v8 lessons need exactly one alternate per primary question",
      });
    }

    [
      ...lesson.questions,
      ...lesson.questionAlternates.map((alternate) => alternate.question),
    ].forEach((question) => {
      validateLessonQuestionGlossary(question, lesson.glossary).forEach((message) => {
        context.addIssue({
          code: "custom",
          path: ["glossary"],
          message,
        });
      });
      const expectedMode = LESSON_AI_EVALUATED_FORMATS.has(question.type)
        ? "ai"
        : "local";
      if (question.evaluationMode !== expectedMode) {
        context.addIssue({
          code: "custom",
          path: ["questions"],
          message: `${question.type} must use ${expectedMode} evaluation`,
        });
      }
      if (LESSON_WRITTEN_FORMATS.has(question.type) && !question.answerBank) {
        context.addIssue({
          code: "custom",
          path: ["questions"],
          message: `${question.type} question ${question.id} needs an answer bank`,
        });
      }
    });
  });

export const LessonPayloadSchema = z
  .unknown()
  .refine(
    lessonCompositionStaysWithinBudget,
    "Lesson answer-bank composition exceeds the validation complexity limit",
  )
  .pipe(LessonPayloadStructureSchema);

function addLessonCreateConsistencyIssues(
  lesson: {
    unitId: string;
    title: string;
    payload: { unitId: string; title: string };
  },
  addIssue: (issue: { code: "custom"; path: string[]; message: string }) => void,
): void {
  if (lesson.payload.unitId !== lesson.unitId) {
    addIssue({
      code: "custom",
      path: ["payload", "unitId"],
      message: "Lesson payload unitId must match the API unitId",
    });
  }
  if (lesson.payload.title !== lesson.title) {
    addIssue({
      code: "custom",
      path: ["payload", "title"],
      message: "Lesson payload title must match the API title",
    });
  }
}

const LessonCreateBaseFields = {
  collectionId: UuidSchema,
  unitId: UuidSchema,
  unitRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  languageCode: LanguageCodeSchema,
};

export const LessonCreateSchema = z
  .object({
    ...LessonCreateBaseFields,
    payload: LessonPayloadSchema,
  })
  .superRefine((lesson, context) => {
    addLessonCreateConsistencyIssues(lesson, (issue) => context.addIssue(issue));
  });

// Keep the OpenAPI contract structural while runtime validation performs the
// raw-input complexity preflight before parsing the deeply nested lesson.
export const LessonCreateDocumentSchema = z
  .object({
    ...LessonCreateBaseFields,
    payload: LessonPayloadStructureSchema,
  })
  .superRefine((lesson, context) => {
    addLessonCreateConsistencyIssues(lesson, (issue) => context.addIssue(issue));
  });

const LessonResponsePrefixFields = {
  id: UuidSchema,
  collectionId: UuidSchema,
  unitId: UuidSchema,
  unitRevision: z.number().int().positive(),
  ownerId: UuidSchema,
  status: z.enum(["draft", "published"]),
  schemaVersion: z.literal(8),
  title: z.string(),
  languageCode: LanguageCodeSchema,
};

const LessonResponseSuffixFields = {
  revision: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
  publishedAt: TimestampSchema.nullable(),
  publishedBy: UuidSchema.nullable(),
};

export const LessonSchema = z
  .object({
    ...LessonResponsePrefixFields,
    payload: LessonPayloadSchema,
    ...LessonResponseSuffixFields,
  });

export const LessonDocumentSchema = z
  .object({
    ...LessonResponsePrefixFields,
    payload: LessonPayloadStructureSchema,
    ...LessonResponseSuffixFields,
  })
  .openapi("Lesson");

export const PaginatedLessonsSchema = z
  .object({
    items: z.array(LessonSchema.omit({ payload: true })),
    nextCursor: CursorSchema.nullable(),
  })
  .openapi("PaginatedLessons");

export const ProgressSessionSchema = z
  .object({
    id: UuidSchema,
    lessonId: UuidSchema,
    collectionId: UuidSchema,
    userId: UuidSchema,
    languageCode: LanguageCodeSchema,
    startedAt: TimestampSchema,
    status: z.enum(["in_progress", "completed"]),
    revision: z.number().int().positive(),
  })
  .openapi("ProgressSession");

export const ProgressHistoryItemSchema = z
  .object({
    id: UuidSchema,
    lessonId: UuidSchema,
    collectionId: UuidSchema,
    userId: UuidSchema,
    languageCode: LanguageCodeSchema,
    status: z.enum(["in_progress", "completed"]),
    summary: JsonObjectSchema,
    revision: z.number().int().positive(),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .openapi("ProgressHistoryItem");

export const ProgressDetailSchema = ProgressHistoryItemSchema.extend({
  attempts: z.array(JsonObjectSchema),
}).openapi("ProgressDetail");

export const PaginatedProgressSchema = z
  .object({
    items: z.array(ProgressHistoryItemSchema),
    nextCursor: CursorSchema.nullable(),
  })
  .openapi("PaginatedProgress");

export const ProgressBatchResultSchema = z
  .object({
    progressId: UuidSchema,
    batchId: UuidSchema,
    status: z.enum(["in_progress", "completed"]),
    summary: JsonObjectSchema,
    revision: z.number().int().positive(),
    completedAt: TimestampSchema.nullable(),
    acceptedEvents: z.number().int().nonnegative(),
  })
  .openapi("ProgressBatchResult");

export const LanguageStatsSchema = z
  .object({
    collectionId: UuidSchema.optional(),
    userId: UuidSchema,
    languageCode: LanguageCodeSchema,
    words: JsonObjectSchema,
    phrases: JsonObjectSchema,
    sentences: JsonObjectSchema,
    aggregate: JsonObjectSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: TimestampSchema.nullable(),
  })
  .openapi("LanguageStats");

export const AnswerAttemptSchema = z.object({
  eventId: UuidSchema,
  attemptId: UuidSchema,
  questionId: z.string().min(1).max(128),
  attemptNumber: z.number().int().positive(),
  answer: z.unknown(),
  outcome: z.enum(["correct", "incorrect", "skipped"]).optional(),
  status: z.enum(["correct", "partial", "incorrect"]).optional(),
  score: z.number().min(0).max(1).nullable().optional(),
  firstTry: z.boolean().optional(),
  transcript: z.string().max(20_000).nullable().optional(),
  evaluationSource: z.enum(["client_extension", "server_rule"]),
  answeredAt: TimestampSchema,
}).refine(
  (value) => value.outcome !== undefined || value.status !== undefined,
  "Either outcome or status is required",
);

export const ProgressBatchSchema = z.object({
  batchId: UuidSchema,
  events: z.array(AnswerAttemptSchema).min(1).max(100),
  completedAt: TimestampSchema.nullable().optional(),
  snapshot: z.object({
    lessonId: UuidSchema,
    completedQuestionIds: z.array(z.string().min(1).max(128)).max(1_000),
    attemptsByQuestion: z.record(z.string(), z.number().int().nonnegative()),
    firstTryCorrect: z.number().int().nonnegative(),
    totalQuestions: z.number().int().positive().max(1_000),
    masteryPercent: z.number().min(0).max(100),
    updatedAt: TimestampSchema,
  }).optional(),
});

export const CharacterProgressUpdateSchema = z.object({
  languageCode: LanguageCodeSchema,
  characters: JsonObjectSchema,
  expectedRevision: z.number().int().nonnegative(),
});

export const CharacterProgressSchema = z
  .object({
    userId: UuidSchema,
    languageCode: LanguageCodeSchema,
    characters: JsonObjectSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: TimestampSchema.nullable(),
  })
  .openapi("CharacterProgress");

export const FileInitializeSchema = z.object({
  collectionId: UuidSchema.nullable().optional(),
  fileName: z.string().trim().min(1).max(255).optional(),
  filename: z.string().trim().min(1).max(255).optional(),
  contentType: z.enum(ALLOWED_FILE_TYPES).optional(),
  mimeType: z.enum(ALLOWED_FILE_TYPES).optional(),
  sizeBytes: z.number().int().min(1).max(MAX_FILE_SIZE_BYTES).optional(),
  size: z.number().int().min(1).max(MAX_FILE_SIZE_BYTES).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
}).superRefine((value, context) => {
  if (!value.fileName && !value.filename) {
    context.addIssue({ code: "custom", message: "fileName is required", path: ["fileName"] });
  }
  if (!value.contentType && !value.mimeType) {
    context.addIssue({ code: "custom", message: "contentType is required", path: ["contentType"] });
  }
  if (value.sizeBytes === undefined && value.size === undefined) {
    context.addIssue({ code: "custom", message: "sizeBytes is required", path: ["sizeBytes"] });
  }
});

export const FileAssetMetadataSchema = z
  .object({
    id: UuidSchema,
    collectionId: UuidSchema.nullable(),
    ownerId: UuidSchema.optional(),
    key: z.string().min(1),
    fileName: z.string().min(1).max(255),
    contentType: z.enum(ALLOWED_FILE_TYPES),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    etag: z.string().nullable().optional(),
    status: z.enum(["pending", "ready"]),
    pendingExpiresAt: TimestampSchema.nullable().optional(),
    uploadedAt: TimestampSchema.nullable().optional(),
    readyAt: TimestampSchema.nullable().optional(),
    createdAt: TimestampSchema.optional(),
  })
  .openapi("FileAssetMetadata");

export const FileUploadHeadersSchema = z
  .object({
    "content-length": z.string().regex(/^[1-9][0-9]*$/),
    "content-type": z.enum(ALLOWED_FILE_TYPES),
    "x-amz-checksum-sha256": z.string().min(1),
  })
  .openapi("FileUploadHeaders");

export const FileUploadInitializeResponseSchema = z
  .object({
    assetId: UuidSchema,
    uploadUrl: z.url(),
    headers: FileUploadHeadersSchema,
    method: z.literal("PUT"),
    expiresIn: z.number().int().positive(),
    asset: FileAssetMetadataSchema,
    upload: z.object({
      expiresIn: z.number().int().positive(),
      headers: FileUploadHeadersSchema,
      method: z.literal("PUT"),
      url: z.url(),
    }),
  })
  .openapi("FileUploadInitializeResponse");

export const FileDownloadAuthorizationSchema = z
  .object({
    assetId: UuidSchema,
    contentType: z.enum(ALLOWED_FILE_TYPES),
    expiresIn: z.number().int().positive(),
    fileName: z.string().min(1).max(255).nullable(),
    url: z.url(),
  })
  .openapi("FileDownloadAuthorization");

export const FileDeletionSchema = z
  .object({
    id: UuidSchema,
    key: z.string().min(1),
    deleted: z.literal(true),
  })
  .openapi("FileDeletion");

export const IdempotencyHeaderSchema = z.object({
  "idempotency-key": z.string().min(16).max(255),
});

export const TurnstileHeaderSchema = z.object({
  "x-turnstile-token": z.string().min(1).max(2048),
});

export const ExpectedRevisionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
});

export const AccountDeletionRequestSchema = z.object({
  confirmation: z.literal("DELETE"),
});

export const UsernameAvailabilityQuerySchema = z.object({
  username: UsernameSchema,
});
