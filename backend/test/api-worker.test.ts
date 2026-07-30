import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApiApp, rateLimitKey } from "../src/app";
import type { DomainRepository, RpcOperation } from "../src/db/repository";
import { ApiError } from "../src/http/errors";
import { MeSchema } from "../src/http/schemas";
import type { Actor, JsonObject, JsonValue } from "../src/types";

const USER_ID = "101ed68b-c50b-4b35-b44c-45a0ef227f6e";
const ACTOR: Actor = {
  userId: USER_ID,
  email: "cat@example.com",
  sessionId: "session-id",
  tokenId: "token-id",
};

const ME: JsonValue = {
  userId: USER_ID,
  email: "cat@example.com",
  emailVerified: true,
  onboardingComplete: true,
  deletion: { status: "none" },
  profile: {
    username: "meo.ing",
    displayName: "Meoing",
    avatarAssetId: null,
    bio: null,
    revision: 1,
  },
};

interface OpenApiSchema {
  readonly $ref?: string;
  readonly type?: string;
  readonly properties?: Record<string, OpenApiSchema>;
  readonly oneOf?: OpenApiSchema[];
  readonly anyOf?: OpenApiSchema[];
  readonly allOf?: OpenApiSchema[];
  readonly additionalProperties?: boolean | OpenApiSchema;
}

interface OpenApiResponse {
  readonly content?: {
    readonly "application/json"?: {
      readonly schema?: OpenApiSchema;
    };
  };
}

interface OpenApiOperation {
  readonly operationId?: string;
  readonly responses?: Record<string, OpenApiResponse>;
}

class RecordingRepository implements DomainRepository {
  readonly calls: Array<{ operation: RpcOperation; actorId: string; input: JsonObject }> = [];
  readonly #responses: Partial<Record<RpcOperation, JsonValue>>;

  constructor(responses: Partial<Record<RpcOperation, JsonValue>>) {
    this.#responses = responses;
  }

  async call(
    operation: RpcOperation,
    actorId: string,
    input: JsonObject = {},
  ): Promise<JsonValue> {
    this.calls.push({ operation, actorId, input });
    const response = this.#responses[operation];
    if (response === undefined) {
      throw new Error(`No fake response for ${operation}`);
    }
    return response;
  }

  async checkHealth(): Promise<void> {}
}

function appWith(repository: DomainRepository) {
  return createApiApp({
    jwtVerifier: async () => ACTOR,
    rateLimiter: async () => true,
    repositoryFactory: () => repository,
    turnstileVerifier: async () => undefined,
  });
}

async function request(
  app: ReturnType<typeof createApiApp>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://api.meoing.test${path}`, init),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("Meoing API Worker", () => {
  it("uses actor-wide rate-limit buckets instead of resource-specific keys", () => {
    expect(rateLimitKey(USER_ID, "GET", "/v1/units/first")).toBe(`${USER_ID}:read`);
    expect(rateLimitKey(USER_ID, "GET", "/v1/units/second")).toBe(`${USER_ID}:read`);
    expect(rateLimitKey(USER_ID, "PATCH", "/v1/units/first")).toBe(`${USER_ID}:write`);
    expect(rateLimitKey(USER_ID, "POST", "/v1/progress/first/batches")).toBe(
      `${USER_ID}:progress`,
    );
  });

  it("returns the stable /v1/me envelope and forwards only the verified actor id", async () => {
    const repository = new RecordingRepository({ meGet: ME });
    const response = await request(appWith(repository), "/v1/me", {
      headers: { authorization: "Bearer test" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const payload = await response.json() as {
      data: unknown;
      meta: { requestId: string };
    };
    const parsed = MeSchema.parse(payload.data);
    expect(parsed.profile.username).toBe("meo.ing");
    expect(payload.meta.requestId).toBe(response.headers.get("x-request-id"));
    expect(repository.calls).toEqual([{ operation: "meGet", actorId: USER_ID, input: {} }]);
  });

  it("rejects invalid profile payloads before calling PostgreSQL", async () => {
    const repository = new RecordingRepository({});
    const response = await request(appWith(repository), "/v1/me/profile", {
      method: "PATCH",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: "ab" }),
    });

    expect(response.status).toBe(400);
    expect(repository.calls).toHaveLength(0);
    const payload = (await response.json()) as { error: { code: string; requestId: string } };
    expect(payload.error.code).toBe("INVALID_REQUEST");
    expect(payload.error.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("emits an OpenAPI document covering core v1 clients", async () => {
    const app = appWith(new RecordingRepository({}));
    const response = await request(app, "/openapi.json");
    const document = (await response.json()) as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
        securitySchemes: Record<string, unknown>;
      };
      paths: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(document.components.securitySchemes).toHaveProperty("BearerAuth");
    expect(document.paths).toHaveProperty("/v1/me");
    expect(document.paths).toHaveProperty("/v1/collections");
    expect(document.paths).toHaveProperty("/v1/units/{unitId}");
    expect(document.paths).toHaveProperty("/v1/lessons/{lessonId}/progress");
    expect(document.paths).toHaveProperty("/v1/progress/{progressId}");
    expect(document.paths).toHaveProperty("/v1/progress/{progressId}/batches");
    expect(document.paths).toHaveProperty("/v1/files/uploads");
    expect(document.components.schemas.CollectionMember?.properties).toHaveProperty(
      "profileRevision",
    );
    expect(document.components.schemas.CollectionMember?.properties).toHaveProperty(
      "collectionProfile",
    );
    expect(document.components.schemas.LanguageStats?.properties).toHaveProperty("aggregate");
  });

  it("documents a concrete data schema for every successful REST response", async () => {
    const response = await request(appWith(new RecordingRepository({})), "/openapi.json");
    const document = (await response.json()) as {
      components: { schemas: Record<string, OpenApiSchema> };
      paths: Record<string, Record<string, OpenApiOperation>>;
    };
    const methods = new Set(["delete", "get", "patch", "post", "put"]);
    const resolve = (schema: OpenApiSchema): OpenApiSchema => {
      if (!schema.$ref) return schema;
      const name = schema.$ref.split("/").at(-1);
      return name ? document.components.schemas[name] ?? {} : {};
    };
    const isConcrete = (schema: OpenApiSchema): boolean => {
      const resolved = resolve(schema);
      const alternatives = resolved.oneOf ?? resolved.anyOf ?? resolved.allOf;
      if (alternatives) return alternatives.length > 0 && alternatives.every(isConcrete);
      if (resolved.type === "object") {
        if (Object.keys(resolved.properties ?? {}).length > 0) return true;
        return typeof resolved.additionalProperties === "object" &&
          Object.keys(resolve(resolved.additionalProperties)).length > 0;
      }
      return typeof resolved.type === "string";
    };

    expect(document.components.schemas).not.toHaveProperty("GenericSuccess");
    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!methods.has(method)) continue;
        for (const [status, operationResponse] of Object.entries(operation.responses ?? {})) {
          if (!status.startsWith("2")) continue;
          const envelopeSchema = operationResponse.content?.["application/json"]?.schema;
          expect(
            envelopeSchema,
            `${method.toUpperCase()} ${path} ${status} must document a JSON envelope`,
          ).toBeDefined();
          const envelope = resolve(envelopeSchema ?? {});
          const dataSchema = envelope.properties?.data;
          expect(
            dataSchema,
            `${method.toUpperCase()} ${path} ${status} must document data`,
          ).toBeDefined();
          expect(
            isConcrete(dataSchema ?? {}),
            `${operation.operationId ?? `${method} ${path}`} must not expose data as unknown`,
          ).toBe(true);
        }
      }
    }
  });

  it("returns raw collection-profile overrides with their optimistic revision", async () => {
    const collectionId = "25112aab-e87b-4cb6-8bd2-74ee8274fb83";
    const memberId = "7a0df6c9-1184-4292-a659-583223be53ee";
    const repository = new RecordingRepository({
      collectionMemberList: {
        items: [{
          userId: memberId,
          username: "member.one",
          displayName: "Classroom name",
          avatarAssetId: null,
          bio: "Effective biography",
          profileRevision: 3,
          collectionProfile: {
            displayName: "Classroom name",
            avatarAssetId: null,
            bio: null,
            revision: 3,
          },
          joinedAt: "2026-07-30T10:00:00.000Z",
          isOwner: false,
          roleIds: [],
        }],
        nextCursor: null,
      },
    });
    const response = await request(
      appWith(repository),
      `/v1/collections/${collectionId}/members`,
      { headers: { authorization: "Bearer test" } },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      data: { items: Array<{ profileRevision: number; collectionProfile: { bio: string | null } }> };
    };
    expect(payload.data.items[0]).toMatchObject({
      profileRevision: 3,
      collectionProfile: { bio: null, revision: 3 },
    });
  });

  it("requires and forwards collection-profile optimistic revisions", async () => {
    const collectionId = "25112aab-e87b-4cb6-8bd2-74ee8274fb83";
    const memberId = "7a0df6c9-1184-4292-a659-583223be53ee";
    const repository = new RecordingRepository({
      collectionProfileUpdate: {
        collectionId,
        userId: memberId,
        displayName: "Classroom name",
        avatarAssetId: null,
        bio: null,
        revision: 1,
        updatedAt: "2026-07-30T10:00:00.000Z",
      },
    });
    const path = `/v1/collections/${collectionId}/profile`;
    const app = appWith(repository);

    const missing = await request(app, path, {
      method: "PUT",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: memberId, displayName: "Classroom name" }),
    });
    expect(missing.status).toBe(400);
    expect(repository.calls).toHaveLength(0);

    const created = await request(app, path, {
      method: "PUT",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: memberId,
        displayName: "Classroom name",
        expectedRevision: 0,
      }),
    });
    expect(created.status).toBe(200);
    expect(repository.calls).toEqual([{
      operation: "collectionProfileUpdate",
      actorId: USER_ID,
      input: {
        collectionId,
        userId: memberId,
        displayName: "Classroom name",
        expectedRevision: 0,
      },
    }]);

    const staleCalls: Array<{ operation: RpcOperation; input: JsonObject }> = [];
    const staleRepository: DomainRepository = {
      checkHealth: async () => undefined,
      call: async (operation, _actorId, input = {}) => {
        staleCalls.push({ operation, input });
        throw new ApiError(
          409,
          "REVISION_CONFLICT",
          "The resource changed; reload it and try again",
        );
      },
    };
    const stale = await request(appWith(staleRepository), path, {
      method: "PUT",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: memberId,
        bio: "Stale writer",
        expectedRevision: 1,
      }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "REVISION_CONFLICT" },
    });
    expect(staleCalls).toEqual([{
      operation: "collectionProfileUpdate",
      input: {
        collectionId,
        userId: memberId,
        bio: "Stale writer",
        expectedRevision: 1,
      },
    }]);
  });

  it("parses includeDeleted query values without treating false as truthy", async () => {
    const collectionId = "25112aab-e87b-4cb6-8bd2-74ee8274fb83";
    const repository = new RecordingRepository({
      collectionList: { items: [], nextCursor: null },
      unitList: { items: [], nextCursor: null },
    });
    const app = appWith(repository);

    const hiddenCollections = await request(app, "/v1/collections?includeDeleted=false", {
      headers: { authorization: "Bearer test" },
    });
    const deletedCollections = await request(app, "/v1/collections?includeDeleted=true", {
      headers: { authorization: "Bearer test" },
    });
    const hiddenUnits = await request(
      app,
      `/v1/collections/${collectionId}/units?includeDeleted=false`,
      { headers: { authorization: "Bearer test" } },
    );

    expect([
      hiddenCollections.status,
      deletedCollections.status,
      hiddenUnits.status,
    ]).toEqual([200, 200, 200]);
    expect(repository.calls).toEqual([
      {
        operation: "collectionList",
        actorId: USER_ID,
        input: { includeDeleted: false, limit: 50 },
      },
      {
        operation: "collectionList",
        actorId: USER_ID,
        input: { includeDeleted: true, limit: 50 },
      },
      {
        operation: "unitList",
        actorId: USER_ID,
        input: { collectionId, includeDeleted: false, limit: 50 },
      },
    ]);
  });

  it("returns a structured authentication failure", async () => {
    const app = createApiApp({
      jwtVerifier: async () => {
        throw new ApiError(401, "AUTH_REQUIRED", "A bearer access token is required");
      },
      rateLimiter: async () => true,
      repositoryFactory: () => new RecordingRepository({}),
    });
    const response = await request(app, "/v1/me");
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("AUTH_REQUIRED");
  });

  it("returns 503 when the readiness database check is unavailable", async () => {
    const repository: DomainRepository = {
      call: async () => ME,
      checkHealth: async () => {
        throw new ApiError(503, "INTERNAL_ERROR", "The database is unavailable");
      },
    };
    const response = await request(createApiApp({
      repositoryFactory: () => repository,
    }), "/health/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "The database is unavailable",
      },
    });
  });

  it("uses the exact progress session and batch RPC contracts", async () => {
    const progressId = "d4167f30-4326-4727-a5c0-830369e4fb34";
    const lessonId = "e7a54fe6-9126-4299-9977-44cda07c4dfd";
    const repository = new RecordingRepository({
      progressStart: {
        id: progressId,
        lessonId,
        collectionId: "25112aab-e87b-4cb6-8bd2-74ee8274fb83",
        userId: USER_ID,
        languageCode: "en",
        startedAt: "2026-07-30T10:00:00.000Z",
        status: "in_progress",
        revision: 1,
      },
      progressBatchSubmit: {
        progressId,
        batchId: "b7589f4c-8219-4054-8b3c-20ba54aaec1f",
        status: "completed",
        summary: { attemptCount: 1 },
        revision: 2,
        completedAt: "2026-07-30T10:01:00.000Z",
        acceptedEvents: 1,
      },
    });
    const app = appWith(repository);
    const start = await request(app, `/v1/lessons/${lessonId}/progress`, {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "idempotency-key": "progress-start-0001",
      },
    });
    expect(start.status).toBe(200);

    const batchId = "b7589f4c-8219-4054-8b3c-20ba54aaec1f";
    const batch = await request(app, `/v1/progress/${progressId}/batches`, {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        batchId,
        events: [
          {
            eventId: "a777cc91-fd06-49bb-8b57-0d22887d2c91",
            attemptId: "dd3f15d4-41f8-4ab8-b00a-c183e614bd5d",
            questionId: "q1",
            attemptNumber: 1,
            answer: "went",
            status: "partial",
            score: 0.5,
            firstTry: true,
            evaluationSource: "server_rule",
            answeredAt: "2026-07-30T10:01:00.000Z",
          },
        ],
        snapshot: {
          lessonId,
          completedQuestionIds: ["q1"],
          attemptsByQuestion: { q1: 1 },
          firstTryCorrect: 0,
          totalQuestions: 1,
          masteryPercent: 50,
          updatedAt: "2026-07-30T10:01:00.000Z",
        },
      }),
    });
    expect(batch.status).toBe(200);
    expect(repository.calls[0]).toMatchObject({
      operation: "progressStart",
      actorId: USER_ID,
      input: { lessonId, idempotencyKey: "progress-start-0001" },
    });
    expect(repository.calls[1]).toMatchObject({
      operation: "progressBatchSubmit",
      actorId: USER_ID,
      input: {
        progressId,
        batchId,
        complete: true,
        events: [{ status: "incorrect", evaluationSource: "deterministic" }],
      },
    });
    expect(repository.calls[1]?.input).not.toHaveProperty("snapshot");
    expect(repository.calls[1]?.input).not.toHaveProperty("completedAt");
  });

  it("uses a bounded detail endpoint for authorized raw progress answers", async () => {
    const progressId = "d4167f30-4326-4727-a5c0-830369e4fb34";
    const repository = new RecordingRepository({
      progressGet: {
        id: progressId,
        lessonId: "e7a54fe6-9126-4299-9977-44cda07c4dfd",
        collectionId: "25112aab-e87b-4cb6-8bd2-74ee8274fb83",
        userId: USER_ID,
        languageCode: "en",
        status: "completed",
        summary: { attemptCount: 1 },
        attempts: [{
          eventId: "a777cc91-fd06-49bb-8b57-0d22887d2c91",
          answeredAt: "2026-07-30T10:01:00.000Z",
        }],
        revision: 2,
        startedAt: "2026-07-30T10:00:00.000Z",
        completedAt: "2026-07-30T10:01:00.000Z",
        updatedAt: "2026-07-30T10:01:00.000Z",
      },
    });
    const response = await request(appWith(repository), `/v1/progress/${progressId}`, {
      headers: { authorization: "Bearer test" },
    });

    expect(response.status).toBe(200);
    expect(repository.calls).toEqual([{
      operation: "progressGet",
      actorId: USER_ID,
      input: { progressId },
    }]);
  });

  it("adapts user settings and frontend file upload wire shapes", async () => {
    const assetId = "1b26fe98-1f4d-4306-a620-454059304cf5";
    const repository = new RecordingRepository({
      settingsGet: {
        items: [
          {
            key: "sidebarWidth",
            value: 288,
            revision: 2,
            updatedAt: "2026-07-30T10:00:00.000Z",
          },
          {
            key: "theme",
            value: {
              selection: { kind: "base", id: "dusk" },
              base: "dusk",
              colorStops: ["#111111", "#222222"],
              gradientDirection: 135,
              intensity: 60,
              syncAcrossDevices: true,
              useCollectionAccents: true,
            },
            revision: 4,
            updatedAt: "2026-07-30T10:00:00.000Z",
          },
        ],
      },
      fileInitialize: {
        id: assetId,
        collectionId: null,
        key: `users/${USER_ID}/${assetId}`,
        fileName: "embedded-image.png",
        contentType: "image/png",
        sizeBytes: 8,
        sha256: "a".repeat(64),
        status: "pending",
      },
    });
    const app = appWith(repository);

    const settings = await request(app, "/v1/settings/user", {
      headers: { authorization: "Bearer test" },
    });
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({
      data: { sidebarWidth: 288, theme: { base: "dusk" } },
    });

    const upload = await request(app, "/v1/files/uploads", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        "idempotency-key": "frontend-upload-0001",
      },
      body: JSON.stringify({
        filename: "embedded-image.png",
        mimeType: "image/png",
        size: 8,
        sha256: "a".repeat(64),
      }),
    });
    expect(upload.status).toBe(200);
    const uploadBody = (await upload.json()) as {
      data: { assetId: string; uploadUrl: string; headers: Record<string, string> };
    };
    expect(uploadBody.data.assetId).toBe(assetId);
    expect(uploadBody.data.uploadUrl).toContain("X-Amz-Signature=");
    expect(uploadBody.data.headers).toHaveProperty("content-length", "8");
    expect(uploadBody.data.headers).toHaveProperty("x-amz-checksum-sha256");
    expect(
      new URL(uploadBody.data.uploadUrl).searchParams.get("X-Amz-SignedHeaders"),
    ).toContain("content-length");
    expect(repository.calls[1]).toMatchObject({
      operation: "fileInitialize",
      input: {
        assetId: expect.any(String),
        key: expect.stringMatching(new RegExp(`^users/${USER_ID}/[0-9a-f-]{36}$`, "i")),
        fileName: "embedded-image.png",
        contentType: "image/png",
        sizeBytes: 8,
      },
    });
  });

  it("normalizes object study items and preserves unit generation metadata", async () => {
    const collectionId = "ca233220-2f22-4af5-834d-b7bfa03c9ef5";
    const unitId = "973d58a4-7202-45aa-b87e-b6513bba632b";
    const repository = new RecordingRepository({
      unitCreate: {
        id: unitId,
        collectionId,
        name: "Travel",
        description: "Airport vocabulary",
        instructionOverride: "Prefer polite Japanese.",
        languageCode: "ja",
        words: [{ text: "caf\u00e9", translation: "coffee", notes: "noun" }],
        phrases: [],
        sentences: [],
        documents: [],
        revision: 1,
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
        deletedAt: null,
      },
    });

    const response = await request(appWith(repository), `/v1/collections/${collectionId}/units`, {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        "idempotency-key": "unit-create-object-0001",
      },
      body: JSON.stringify({
        name: "Travel",
        description: "  Airport vocabulary  ",
        instructionOverride: "  Prefer polite Japanese.  ",
        languageCode: "ja",
        words: [{
          text: " cafe\u0301 ",
          translation: " coffee ",
          notes: " noun ",
        }],
        phrases: [],
        sentences: [],
        documents: [],
      }),
    });

    expect(response.status).toBe(200);
    expect(repository.calls[0]).toMatchObject({
      operation: "unitCreate",
      input: {
        collectionId,
        description: "Airport vocabulary",
        instructionOverride: "Prefer polite Japanese.",
        words: [{ text: "caf\u00e9", translation: "coffee", notes: "noun" }],
      },
    });
  });

  it("validates each settings key and forwards its optimistic revision", async () => {
    const repository = new RecordingRepository({
      settingsUpsert: {
        key: "sidebarWidth",
        value: 320,
        revision: 3,
        updatedAt: "2026-07-30T10:00:00.000Z",
      },
    });
    const app = appWith(repository);
    const invalid = await request(app, "/v1/settings", {
      method: "PUT",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: "user",
        key: "unknownSetting",
        value: true,
        expectedRevision: 0,
      }),
    });
    expect(invalid.status).toBe(400);
    expect(repository.calls).toHaveLength(0);

    const valid = await request(app, "/v1/settings", {
      method: "PUT",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: "user",
        key: "sidebarWidth",
        value: 320,
        expectedRevision: 2,
      }),
    });
    expect(valid.status).toBe(200);
    expect(repository.calls).toEqual([{
      operation: "settingsUpsert",
      actorId: USER_ID,
      input: {
        scope: "user",
        key: "sidebarWidth",
        value: 320,
        expectedRevision: 2,
      },
    }]);
  });

  it("forwards teacher collection and member filters to progress history authorization", async () => {
    const collectionId = "25112aab-e87b-4cb6-8bd2-74ee8274fb83";
    const memberId = "7a0df6c9-1184-4292-a659-583223be53ee";
    const repository = new RecordingRepository({
      progressHistory: { items: [], nextCursor: null },
    });
    const response = await request(
      appWith(repository),
      `/v1/progress?collectionId=${collectionId}&userId=${memberId}&limit=25`,
      { headers: { authorization: "Bearer test" } },
    );

    expect(response.status).toBe(200);
    expect(repository.calls).toEqual([{
      operation: "progressHistory",
      actorId: USER_ID,
      input: { collectionId, userId: memberId, limit: 25 },
    }]);
  });

  it("returns typed global and collection language statistics", async () => {
    const collectionId = "25112aab-e87b-4cb6-8bd2-74ee8274fb83";
    const baseStats = {
      userId: USER_ID,
      languageCode: "en",
      words: { go: { encounterCount: 2 } },
      phrases: {},
      sentences: {},
      aggregate: { attemptCount: 2 },
      revision: 3,
      updatedAt: "2026-07-30T10:00:00.000Z",
    };
    const repository = new RecordingRepository({
      statsGlobalGet: baseStats,
      statsCollectionGet: { collectionId, ...baseStats },
    });
    const app = appWith(repository);

    const globalResponse = await request(app, "/v1/stats?languageCode=en", {
      headers: { authorization: "Bearer test" },
    });
    const collectionResponse = await request(
      app,
      `/v1/collections/${collectionId}/stats?languageCode=en`,
      { headers: { authorization: "Bearer test" } },
    );

    expect(globalResponse.status).toBe(200);
    expect(collectionResponse.status).toBe(200);
    await expect(globalResponse.json()).resolves.toMatchObject({
      data: { languageCode: "en", revision: 3 },
    });
    await expect(collectionResponse.json()).resolves.toMatchObject({
      data: { collectionId, languageCode: "en", revision: 3 },
    });
  });

  it("requires optimistic revision while allowing partial role updates", async () => {
    const collectionId = "25112aab-e87b-4cb6-8bd2-74ee8274fb83";
    const roleId = "69278914-609c-4c06-88aa-87de68fad41a";
    const repository = new RecordingRepository({
      collectionRoleUpdate: {
        id: roleId,
        collectionId,
        name: "Teacher",
        color: null,
        permissions: ["create_content"],
        securityRank: 10,
        isManaged: false,
        revision: 3,
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:01:00.000Z",
      },
    });
    const app = appWith(repository);
    const path = `/v1/collections/${collectionId}/roles/${roleId}`;
    const invalid = await request(app, path, {
      method: "PATCH",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Teacher" }),
    });
    expect(invalid.status).toBe(400);
    expect(repository.calls).toHaveLength(0);

    const valid = await request(app, path, {
      method: "PATCH",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Teacher", expectedRevision: 2 }),
    });
    expect(valid.status).toBe(200);
    expect(repository.calls[0]).toMatchObject({
      operation: "collectionRoleUpdate",
      input: { collectionId, roleId, name: "Teacher", expectedRevision: 2 },
    });
  });

  it("returns a deterministic invite token without sending the raw token to PostgreSQL", async () => {
    const collectionId = "25112aab-e87b-4cb6-8bd2-74ee8274fb83";
    const repository = new RecordingRepository({
      collectionInviteCreate: {
        id: "6b051596-08ae-457b-89f2-438e2a7e8de2",
        collectionId,
        tokenHint: null,
        expiresAt: null,
        maxUses: null,
        usesCount: 0,
        revokedAt: null,
        revision: 1,
        roleIds: [],
        createdAt: "2026-07-30T10:00:00.000Z",
      },
    });
    const app = appWith(repository);
    const init: RequestInit = {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        "idempotency-key": "invite-create-0001",
      },
      body: JSON.stringify({ roleIds: [] }),
    };
    const first = await request(app, `/v1/collections/${collectionId}/invites`, init);
    const second = await request(app, `/v1/collections/${collectionId}/invites`, init);
    const firstData = (await first.json()) as { data: { token: string } };
    const secondData = (await second.json()) as { data: { token: string } };

    expect(first.status).toBe(200);
    expect(firstData.data.token).toBe(secondData.data.token);
    expect(firstData.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.calls[0]?.input).not.toHaveProperty("token");
    expect(repository.calls[0]?.input.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(repository.calls[0]?.input.tokenHash).toBe(repository.calls[1]?.input.tokenHash);
  });

  it("passes pseudonymous durable quota keys for username lookup and invite acceptance", async () => {
    const repository = new RecordingRepository({
      abuseConsume: { remaining: 29 },
      usernameAvailability: { username: "meoing", available: true },
      collectionInviteAccept: {
        id: "25112aab-e87b-4cb6-8bd2-74ee8274fb83",
        name: "Accepted collection",
        description: null,
        ownerId: "7a0df6c9-1184-4292-a659-583223be53ee",
        deletedAt: null,
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
        revision: 1,
        effectivePermissions: [],
      },
    });
    const app = appWith(repository);

    const username = await request(app, "/v1/me/username-availability?username=meoing", {
      headers: { authorization: "Bearer test" },
    });
    const invite = await request(app, "/v1/invites/accept", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "cf-connecting-ip": "203.0.113.7",
        "content-type": "application/json",
        "idempotency-key": "invite-accept-0001",
        "x-turnstile-token": "turnstile-test",
      },
      body: JSON.stringify({ token: "t".repeat(43) }),
    });

    expect(username.status).toBe(200);
    expect(invite.status).toBe(200);
    expect(repository.calls[0]).toMatchObject({
      operation: "abuseConsume",
      input: {
        abuseKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        scope: "username_lookup",
      },
    });
    expect(repository.calls[1]).toMatchObject({
      operation: "usernameAvailability",
      input: { username: "meoing" },
    });
    expect(repository.calls[2]).toMatchObject({
      operation: "abuseConsume",
      input: {
        abuseKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        scope: "invite_accept",
      },
    });
    expect(repository.calls[3]).toMatchObject({
      operation: "collectionInviteAccept",
      input: {
        idempotencyKey: "invite-accept-0001",
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(repository.calls[0]?.input.abuseKey).not.toBe(repository.calls[2]?.input.abuseKey);
  });
});
