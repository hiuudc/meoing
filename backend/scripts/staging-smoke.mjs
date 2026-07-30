import { createHash, randomUUID } from "node:crypto";
import {
  assert,
  booleanEnvironment,
  normalizedBaseUrl,
  optionalEnvironment,
  parseResponseBody,
  passwordAccessToken,
  requiredEnvironment,
  resolveUrl,
  writeJsonSummary,
} from "./acceptance-helpers.mjs";

const HELP = `
Meoing staging smoke acceptance

Required:
  MEOING_ACCEPTANCE_API_URL
  MEOING_ACCEPTANCE_SUPABASE_URL
  MEOING_ACCEPTANCE_SUPABASE_PUBLISHABLE_KEY
  MEOING_ACCEPTANCE_ALLOWED_ORIGIN
  MEOING_ACCEPTANCE_ACCESS_TOKEN
    or both MEOING_ACCEPTANCE_EMAIL and MEOING_ACCEPTANCE_PASSWORD

Optional:
  MEOING_ACCEPTANCE_OUTPUT   JSON summary path
  MEOING_ACCEPTANCE_EXTENDED=true
    additionally requires MEMBER_EMAIL/MEMBER_PASSWORD (or MEMBER_ACCESS_TOKEN)
    and MEOING_ACCEPTANCE_TURNSTILE_TOKEN
`;

if (process.argv.includes("--help")) {
  console.log(HELP.trim());
  process.exit(0);
}

const startedAt = Date.now();
const apiUrl = normalizedBaseUrl(
  requiredEnvironment("MEOING_ACCEPTANCE_API_URL"),
  "MEOING_ACCEPTANCE_API_URL",
);
const supabaseUrl = normalizedBaseUrl(
  requiredEnvironment("MEOING_ACCEPTANCE_SUPABASE_URL"),
  "MEOING_ACCEPTANCE_SUPABASE_URL",
);
const publishableKey = requiredEnvironment("MEOING_ACCEPTANCE_SUPABASE_PUBLISHABLE_KEY");
const allowedOrigin = requiredEnvironment("MEOING_ACCEPTANCE_ALLOWED_ORIGIN");
const outputPath = optionalEnvironment("MEOING_ACCEPTANCE_OUTPUT");
const extended = booleanEnvironment("MEOING_ACCEPTANCE_EXTENDED", false);
const checks = [];
let collection = null;
let unit = null;
let lesson = null;
let observerRole = null;
let assetId = null;
let ownerUserId = null;

async function resolveToken() {
  const provided = optionalEnvironment("MEOING_ACCEPTANCE_ACCESS_TOKEN");
  if (provided) return provided;
  return passwordAccessToken({
    email: requiredEnvironment("MEOING_ACCEPTANCE_EMAIL"),
    password: requiredEnvironment("MEOING_ACCEPTANCE_PASSWORD"),
    publishableKey,
    supabaseUrl,
  });
}

const accessToken = await resolveToken();
const memberAccessToken = !extended
  ? null
  : optionalEnvironment("MEOING_ACCEPTANCE_MEMBER_ACCESS_TOKEN") ??
    await passwordAccessToken({
      email: requiredEnvironment("MEOING_ACCEPTANCE_MEMBER_EMAIL"),
      password: requiredEnvironment("MEOING_ACCEPTANCE_MEMBER_PASSWORD"),
      publishableKey,
      supabaseUrl,
    });
const turnstileToken = extended
  ? requiredEnvironment("MEOING_ACCEPTANCE_TURNSTILE_TOKEN")
  : null;

function tracking() {
  return {
    encountered: { words: ["acceptance"], phrases: [], sentences: [] },
    assessed: { words: ["acceptance"], phrases: [], sentences: [] },
  };
}

function question(type, id) {
  const core = {
    id,
    prompt: "Practice acceptance.",
    explanation: "This exercise tracks the acceptance term.",
    evaluationMode: "local",
    glossaryTargets: ["acceptance"],
    tracking: tracking(),
  };
  switch (type) {
    case "singleChoice":
      return {
        ...core,
        type,
        options: [
          { id: "acceptance", label: "acceptance" },
          { id: "rejection", label: "rejection" },
        ],
        correctOptionId: "acceptance",
      };
    case "multipleChoice":
      return {
        ...core,
        type,
        options: [
          { id: "acceptance", label: "acceptance" },
          { id: "approval", label: "approval" },
        ],
        correctOptionIds: ["acceptance", "approval"],
      };
    case "trueFalse":
      return {
        ...core,
        type,
        statement: "Acceptance can mean approval.",
        correct: true,
      };
    case "wordBank":
      return {
        ...core,
        type,
        tokens: [
          { id: "an", label: "An" },
          { id: "acceptance", label: "acceptance" },
        ],
        correctOrderIds: ["an", "acceptance"],
      };
    case "matching":
      return {
        ...core,
        type,
        pairs: [
          {
            leftId: "acceptance",
            left: "acceptance",
            rightId: "approval",
            right: "approval",
          },
          {
            leftId: "rejection",
            left: "rejection",
            rightId: "refusal",
            right: "refusal",
          },
        ],
      };
    case "reorderTokens":
      return {
        ...core,
        type,
        tokens: [
          { id: "we", label: "We" },
          { id: "accept", label: "accept" },
        ],
        correctOrderIds: ["we", "accept"],
      };
    case "reorderDialogue":
      return {
        ...core,
        type,
        turns: [
          { id: "ask", label: "Do you accept?", speaker: "A" },
          { id: "answer", label: "Yes.", speaker: "B" },
        ],
        correctOrderIds: ["ask", "answer"],
      };
    case "categorize":
      return {
        ...core,
        type,
        categories: [
          { id: "positive", label: "Positive" },
          { id: "negative", label: "Negative" },
        ],
        items: [
          { id: "acceptance", label: "acceptance", categoryId: "positive" },
          { id: "rejection", label: "rejection", categoryId: "negative" },
        ],
      };
    default:
      throw new Error(`Unsupported acceptance question type ${type}`);
  }
}

function lessonPayload(runId, unitId) {
  const primaryTypes = [
    "singleChoice",
    "multipleChoice",
    "trueFalse",
    "wordBank",
    "matching",
    "reorderTokens",
    "reorderDialogue",
    "categorize",
  ];
  const alternateTypes = [
    "trueFalse",
    "wordBank",
    "matching",
    "reorderTokens",
    "reorderDialogue",
    "categorize",
    "singleChoice",
    "multipleChoice",
  ];
  return {
    schemaVersion: 8,
    id: `acceptance-lesson-${runId}`,
    unitId,
    title: "Acceptance lesson",
    summary: "A disposable schema-v8 staging lesson.",
    targetLanguage: "English",
    sourceLanguage: "Vietnamese",
    level: "beginner",
    objectives: ["Recognize the acceptance term."],
    theory: [{
      id: "theory-acceptance",
      kind: "concept",
      title: "Acceptance",
      body: "Acceptance can mean approval.",
    }],
    examples: [{
      id: "example-acceptance",
      source: "acceptance",
      translation: "sự chấp nhận",
    }],
    glossary: [{ term: "acceptance", meaning: "approval" }],
    sourceReferences: [{
      id: "source-acceptance",
      kind: "unit",
      title: "Acceptance unit",
    }],
    questions: primaryTypes.map((type, index) =>
      question(type, `question-${index + 1}`)
    ),
    questionAlternates: alternateTypes.map((type, index) => ({
      questionId: `question-${index + 1}`,
      question: question(type, `alternate-${index + 1}`),
    })),
    createdAt: new Date().toISOString(),
  };
}

async function request(path, {
  body,
  expectedStatus = 200,
  headers = {},
  method = "GET",
  token = accessToken,
} = {}) {
  const response = await fetch(resolveUrl(apiUrl, path), {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await parseResponseBody(response);
  if (response.status !== expectedStatus) {
    const code = payload?.error?.code;
    throw new Error(
      `${method} ${path} returned HTTP ${response.status}${code ? ` (${code})` : ""}; expected ${expectedStatus}`,
    );
  }
  return { payload, response };
}

async function check(name, callback) {
  const checkStartedAt = performance.now();
  await callback();
  checks.push({
    name,
    durationMs: Math.round((performance.now() - checkStartedAt) * 100) / 100,
    status: "passed",
  });
  console.log(`PASS ${name}`);
}

let primaryError;
try {
  await check("Worker liveness and PostgreSQL readiness", async () => {
    const live = await request("/health/live", { token: null });
    const ready = await request("/health/ready", { token: null });
    assert(live.payload?.data?.status === "ok", "Liveness envelope is invalid");
    assert(ready.payload?.data?.status === "ready", "Readiness envelope is invalid");
    assert(
      live.response.headers.get("x-request-id") === live.payload?.meta?.requestId,
      "Liveness request ID header and envelope differ",
    );
  });

  await check("Strict CORS allowlist", async () => {
    const allowed = await request("/health/live", {
      headers: { origin: allowedOrigin },
      token: null,
    });
    assert(
      allowed.response.headers.get("access-control-allow-origin") === allowedOrigin,
      "Configured staging origin was not allowed",
    );

    const denied = await request("/health/live", {
      headers: { origin: "https://not-meoing.invalid" },
      token: null,
    });
    assert(
      denied.response.headers.get("access-control-allow-origin") === null,
      "An origin outside the allowlist received CORS permission",
    );
  });

  await check("OpenAPI publication", async () => {
    const result = await request("/openapi.json", { token: null });
    assert(result.payload?.openapi === "3.1.0", "OpenAPI 3.1 document was not returned");
    for (const path of ["/v1/me", "/v1/collections", "/v1/files/uploads"]) {
      assert(result.payload?.paths?.[path], `OpenAPI document is missing ${path}`);
    }
  });

  await check("Forged JWT rejection", async () => {
    const result = await request("/v1/me", {
      expectedStatus: 401,
      token: "not-a-valid-jwt",
    });
    assert(result.payload?.error?.code === "AUTH_REQUIRED", "Forged JWT did not return AUTH_REQUIRED");
  });

  await check("Verified account and username onboarding", async () => {
    const result = await request("/v1/me");
    assert(result.payload?.data?.onboardingComplete === true, "Acceptance account is not fully onboarded");
    assert(
      typeof result.payload?.data?.profile?.username === "string",
      "Acceptance account has no username",
    );
    ownerUserId = result.payload?.data?.userId;
    assert(typeof ownerUserId === "string", "Acceptance account has no user ID");
  });

  await check("Supabase Data API cannot expose app schema", async () => {
    const response = await fetch(resolveUrl(supabaseUrl, "/rest/v1/profiles?select=*"), {
      headers: {
        accept: "application/json",
        "accept-profile": "app",
        apikey: publishableKey,
        authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    assert(!response.ok, "Direct PostgREST request unexpectedly exposed the app schema");
  });

  const runId = randomUUID();
  await check("Collection and unit vertical slice with revision conflict", async () => {
    const createdCollection = await request("/v1/collections", {
      method: "POST",
      headers: { "idempotency-key": `acceptance-collection-${runId}` },
      body: {
        name: `Acceptance ${runId.slice(0, 8)}`,
        description: "Disposable staging acceptance collection",
      },
    });
    collection = createdCollection.payload?.data;
    assert(typeof collection?.id === "string", "Collection create returned no ID");
    assert(Number.isInteger(collection?.revision), "Collection create returned no revision");

    const unitBody = {
      name: "Acceptance unit",
      description: "Disposable staging acceptance unit",
      instructionOverride: null,
      languageCode: "en",
      words: ["acceptance"],
      phrases: [],
      sentences: [],
      documents: [],
    };
    const createdUnit = await request(`/v1/collections/${encodeURIComponent(collection.id)}/units`, {
      method: "POST",
      headers: { "idempotency-key": `acceptance-unit-${runId}` },
      body: unitBody,
    });
    unit = createdUnit.payload?.data;
    assert(typeof unit?.id === "string", "Unit create returned no ID");
    assert(unit?.revision === 1, "New unit did not start at revision 1");

    const updatedUnit = await request(`/v1/units/${encodeURIComponent(unit.id)}`, {
      method: "PATCH",
      body: {
        ...unitBody,
        name: "Acceptance unit updated",
        words: ["acceptance", "accepted"],
        expectedRevision: unit.revision,
      },
    });
    unit = updatedUnit.payload?.data;
    assert(unit?.revision === 2, "Unit update did not advance its revision");

    const conflict = await request(`/v1/units/${encodeURIComponent(unit.id)}`, {
      method: "PATCH",
      expectedStatus: 409,
      body: {
        ...unitBody,
        name: "Stale acceptance update",
        expectedRevision: 1,
      },
    });
    assert(
      conflict.payload?.error?.code === "REVISION_CONFLICT",
      "Stale unit update did not return REVISION_CONFLICT",
    );
  });

  if (extended) {
    await check("Custom role and single-use invite acceptance", async () => {
      const memberMe = await request("/v1/me", { token: memberAccessToken });
      assert(
        memberMe.payload?.data?.onboardingComplete === true,
        "Acceptance member account is not fully onboarded",
      );

      const roleResult = await request(
        `/v1/collections/${encodeURIComponent(collection.id)}/roles`,
        {
          method: "POST",
          headers: { "idempotency-key": `acceptance-role-${runId}` },
          body: {
            name: "Progress observer",
            color: "#5470c6",
            permissions: ["view_member_progress"],
            securityRank: 1,
          },
        },
      );
      observerRole = roleResult.payload?.data;
      assert(typeof observerRole?.id === "string", "Role create returned no ID");
      assert(Number.isInteger(observerRole?.revision), "Role create returned no revision");
      assert(
        observerRole.permissions?.includes("view_member_progress"),
        "Progress observer role is missing its summary permission",
      );

      const inviteResult = await request(
        `/v1/collections/${encodeURIComponent(collection.id)}/invites`,
        {
          method: "POST",
          headers: { "idempotency-key": `acceptance-invite-${runId}` },
          body: { maxUses: 1, roleIds: [observerRole.id] },
        },
      );
      const inviteToken = inviteResult.payload?.data?.token;
      assert(typeof inviteToken === "string", "Invite create returned no token");

      const accepted = await request("/v1/invites/accept", {
        method: "POST",
        token: memberAccessToken,
        headers: {
          "idempotency-key": `acceptance-redeem-${runId}`,
          "x-turnstile-token": turnstileToken,
        },
        body: { token: inviteToken },
      });
      assert(
        accepted.payload?.data?.id === collection.id,
        "Member did not join the expected collection",
      );
    });

    await check("Lesson v8, exact-once progress and stats authorization", async () => {
      const payload = lessonPayload(runId, unit.id);
      const lessonResult = await request("/v1/lessons", {
        method: "POST",
        headers: { "idempotency-key": `acceptance-lesson-${runId}` },
        body: {
          collectionId: collection.id,
          unitId: unit.id,
          unitRevision: unit.revision,
          title: payload.title,
          languageCode: "en",
          payload,
        },
      });
      lesson = lessonResult.payload?.data;
      assert(typeof lesson?.id === "string", "Lesson create returned no ID");

      const progressResult = await request(
        `/v1/lessons/${encodeURIComponent(lesson.id)}/progress`,
        {
          method: "POST",
          headers: { "idempotency-key": `acceptance-progress-${runId}` },
        },
      );
      const progressId = progressResult.payload?.data?.id;
      assert(typeof progressId === "string", "Progress start returned no ID");

      const timestamp = new Date().toISOString();
      const progressBatch = {
        batchId: randomUUID(),
        completedAt: timestamp,
        events: [{
          eventId: randomUUID(),
          attemptId: randomUUID(),
          questionId: "question-1",
          attemptNumber: 1,
          answer: "acceptance",
          outcome: "correct",
          score: 1,
          firstTry: true,
          evaluationSource: "client_extension",
          answeredAt: timestamp,
        }],
        snapshot: {
          lessonId: lesson.id,
          completedQuestionIds: ["question-1"],
          attemptsByQuestion: { "question-1": 1 },
          firstTryCorrect: 1,
          totalQuestions: 8,
          masteryPercent: 12.5,
          updatedAt: timestamp,
        },
      };
      const submitted = await request(
        `/v1/progress/${encodeURIComponent(progressId)}/batches`,
        { method: "POST", body: progressBatch },
      );
      assert(
        submitted.payload?.data?.acceptedEvents === 1,
        "Progress batch did not accept exactly one event",
      );
      const retried = await request(
        `/v1/progress/${encodeURIComponent(progressId)}/batches`,
        { method: "POST", body: progressBatch },
      );
      assert(
        retried.payload?.data?.acceptedEvents === 1,
        "Exact progress retry did not return its original result",
      );

      const ownerDetail = await request(`/v1/progress/${encodeURIComponent(progressId)}`);
      assert(
        ownerDetail.payload?.data?.attempts?.[0]?.answer === "acceptance",
        "Progress owner cannot retrieve the stored raw answer",
      );
      const globalStats = await request("/v1/stats?languageCode=en");
      assert(
        globalStats.payload?.data?.words?.acceptance?.encounterCount === 1,
        "Exact progress retry changed the global encounter count",
      );

      const memberHistory = await request(
        `/v1/progress?collectionId=${encodeURIComponent(collection.id)}&userId=${encodeURIComponent(ownerUserId)}&limit=10`,
        { token: memberAccessToken },
      );
      assert(
        memberHistory.payload?.data?.items?.some((item) => item.id === progressId),
        "Progress observer cannot retrieve authorized member summaries",
      );
      const collectionStats = await request(
        `/v1/collections/${encodeURIComponent(collection.id)}/stats?languageCode=en&userId=${encodeURIComponent(ownerUserId)}`,
        { token: memberAccessToken },
      );
      assert(
        collectionStats.payload?.data?.words?.acceptance?.encounterCount === 1,
        "Progress observer cannot retrieve collection term stats",
      );
      const deniedAnswers = await request(
        `/v1/progress/${encodeURIComponent(progressId)}`,
        { expectedStatus: 403, token: memberAccessToken },
      );
      assert(
        deniedAnswers.payload?.error?.code === "PROGRESS_ANSWERS_FORBIDDEN",
        "Summary-only role was able to retrieve raw answers",
      );

      const previousRoleRevision = observerRole.revision;
      const upgradedRole = await request(
        `/v1/collections/${encodeURIComponent(collection.id)}/roles/${encodeURIComponent(observerRole.id)}`,
        {
          method: "PATCH",
          body: {
            permissions: [
              ...new Set([
                ...observerRole.permissions,
                "view_member_answers",
              ]),
            ],
            expectedRevision: previousRoleRevision,
          },
        },
      );
      observerRole = upgradedRole.payload?.data;
      assert(
        observerRole?.revision === previousRoleRevision + 1,
        "Raw-answer permission update did not advance the role revision",
      );
      assert(
        observerRole.permissions?.includes("view_member_progress") &&
          observerRole.permissions?.includes("view_member_answers"),
        "Upgraded role did not retain summary and raw-answer permissions",
      );

      const allowedAnswers = await request(
        `/v1/progress/${encodeURIComponent(progressId)}`,
        { token: memberAccessToken },
      );
      assert(
        allowedAnswers.payload?.data?.attempts?.length === 1,
        "Raw-answer reader did not receive the exact-once attempt set",
      );
      assert(
        allowedAnswers.payload?.data?.attempts?.[0]?.answer ===
          progressBatch.events[0].answer,
        "Raw-answer reader did not receive the stored answer",
      );
    });
  } else {
    checks.push({
      name: "Role/invite and lesson/progress authorization",
      status: "skipped",
      reason: "Set MEOING_ACCEPTANCE_EXTENDED=true with a second account and Turnstile test token",
    });
    console.log("SKIP extended role/invite/lesson/progress acceptance");
  }

  await check("Private R2 upload, finalize, download and delete", async () => {
    const bytes = Buffer.from("meoing staging acceptance\n", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const initialized = await request("/v1/files/uploads", {
      method: "POST",
      headers: { "idempotency-key": `acceptance-upload-${runId}` },
      body: {
        filename: "acceptance.txt",
        mimeType: "text/plain",
        size: bytes.length,
        sha256,
      },
    });
    assetId = initialized.payload?.data?.assetId;
    const uploadUrl = initialized.payload?.data?.uploadUrl;
    const uploadHeaders = initialized.payload?.data?.headers;
    assert(typeof assetId === "string", "Upload initialization returned no asset ID");
    assert(typeof uploadUrl === "string", "Upload initialization returned no signed URL");
    assert(uploadHeaders && typeof uploadHeaders === "object", "Upload headers are missing");

    const uploaded = await fetch(uploadUrl, {
      method: "PUT",
      headers: uploadHeaders,
      body: bytes,
      signal: AbortSignal.timeout(30_000),
    });
    assert(uploaded.ok, `R2 PUT failed with HTTP ${uploaded.status}`);

    await request(`/v1/files/${encodeURIComponent(assetId)}/finalize`, { method: "POST" });
    const authorized = await request(`/v1/files/${encodeURIComponent(assetId)}/download`);
    const downloadUrl = authorized.payload?.data?.url;
    assert(typeof downloadUrl === "string", "Download authorization returned no URL");
    const downloaded = await fetch(downloadUrl, { signal: AbortSignal.timeout(20_000) });
    assert(downloaded.ok, `R2 GET failed with HTTP ${downloaded.status}`);
    assert(
      Buffer.from(await downloaded.arrayBuffer()).equals(bytes),
      "Downloaded R2 bytes differ from the upload",
    );

    await request(`/v1/files/${encodeURIComponent(assetId)}`, { method: "DELETE" });
    assetId = null;
  });
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  if (assetId) {
    await request(`/v1/files/${encodeURIComponent(assetId)}`, { method: "DELETE" })
      .catch((error) => cleanupErrors.push(`asset: ${error.message}`));
  }
  if (unit?.id && Number.isInteger(unit.revision)) {
    if (lesson?.id && Number.isInteger(lesson.revision)) {
      await request(`/v1/lessons/${encodeURIComponent(lesson.id)}`, {
        method: "DELETE",
        body: { expectedRevision: lesson.revision },
      }).catch((error) => cleanupErrors.push(`lesson: ${error.message}`));
    }
    await request(`/v1/units/${encodeURIComponent(unit.id)}`, {
      method: "DELETE",
      body: { expectedRevision: unit.revision },
    }).catch((error) => cleanupErrors.push(`unit: ${error.message}`));
  }
  if (collection?.id && Number.isInteger(collection.revision)) {
    await request(`/v1/collections/${encodeURIComponent(collection.id)}`, {
      method: "DELETE",
      body: { expectedRevision: collection.revision },
    }).catch((error) => cleanupErrors.push(`collection: ${error.message}`));
  }

  const summary = {
    status: primaryError || cleanupErrors.length > 0 ? "failed" : "passed",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    checks,
    cleanupErrorCount: cleanupErrors.length,
  };
  await writeJsonSummary(outputPath, summary);

  if (cleanupErrors.length > 0) {
    console.error(`Acceptance cleanup failed for ${cleanupErrors.length} resource(s)`);
  }
}

if (primaryError) throw primaryError;
console.log(`Staging smoke passed (${checks.length} checks, ${Date.now() - startedAt} ms)`);
