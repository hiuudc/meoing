import {
  assert,
  booleanEnvironment,
  integerEnvironment,
  latencySummary,
  normalizedBaseUrl,
  numberEnvironment,
  optionalEnvironment,
  parseResponseBody,
  passwordAccessToken,
  requiredEnvironment,
  resolveUrl,
  sleep,
  writeJsonSummary,
} from "./acceptance-helpers.mjs";

const HELP = `
Meoing authenticated load gate

Defaults:
  MEOING_LOAD_CONCURRENCY=100
  MEOING_LOAD_DURATION_SECONDS=600
  MEOING_LOAD_REQUESTS_PER_USER_PER_MINUTE=60
  MEOING_LOAD_MUTATION_EVERY=10
  MEOING_LOAD_READ_P95_MS=400
  MEOING_LOAD_MUTATION_P95_MS=800
  MEOING_LOAD_MAX_ERROR_RATE=0.01

Required:
  MEOING_LOAD_API_URL
  MEOING_LOAD_USERS_JSON
    JSON array of unique {"email","password"} test accounts
  MEOING_LOAD_SUPABASE_URL
  MEOING_LOAD_SUPABASE_PUBLISHABLE_KEY

Alternative:
  MEOING_LOAD_ACCESS_TOKENS_JSON
    JSON array containing at least one unique token per virtual user

Optional:
  MEOING_LOAD_OUTPUT
  MEOING_LOAD_READ_ONLY=true
`;

if (process.argv.includes("--help")) {
  console.log(HELP.trim());
  process.exit(0);
}

const apiUrl = normalizedBaseUrl(
  requiredEnvironment("MEOING_LOAD_API_URL"),
  "MEOING_LOAD_API_URL",
);
const concurrency = integerEnvironment("MEOING_LOAD_CONCURRENCY", 100, 1, 1_000);
const durationSeconds = integerEnvironment("MEOING_LOAD_DURATION_SECONDS", 600, 10, 3_600);
const requestsPerMinute = integerEnvironment(
  "MEOING_LOAD_REQUESTS_PER_USER_PER_MINUTE",
  60,
  1,
  240,
);
const mutationEvery = integerEnvironment("MEOING_LOAD_MUTATION_EVERY", 10, 2, 1_000);
const readP95Limit = numberEnvironment("MEOING_LOAD_READ_P95_MS", 400, 1);
const mutationP95Limit = numberEnvironment("MEOING_LOAD_MUTATION_P95_MS", 800, 1);
const maximumErrorRate = numberEnvironment("MEOING_LOAD_MAX_ERROR_RATE", 0.01, 0, 1);
const readOnly = booleanEnvironment("MEOING_LOAD_READ_ONLY", false);
const outputPath = optionalEnvironment("MEOING_LOAD_OUTPUT");
const requestIntervalMs = 60_000 / requestsPerMinute;

function parseJsonArray(name) {
  const raw = optionalEnvironment(name);
  if (!raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
  if (!Array.isArray(value)) throw new Error(`${name} must be a JSON array`);
  return value;
}

async function resolveTokens() {
  const providedTokens = parseJsonArray("MEOING_LOAD_ACCESS_TOKENS_JSON");
  if (providedTokens) {
    if (!providedTokens.every((token) => typeof token === "string" && token.length > 20)) {
      throw new Error("MEOING_LOAD_ACCESS_TOKENS_JSON contains an invalid token");
    }
    return providedTokens;
  }

  const users = parseJsonArray("MEOING_LOAD_USERS_JSON");
  if (!users || !users.every((user) =>
    user &&
    typeof user === "object" &&
    typeof user.email === "string" &&
    typeof user.password === "string"
  )) {
    throw new Error("MEOING_LOAD_USERS_JSON must contain email/password test accounts");
  }
  const supabaseUrl = normalizedBaseUrl(
    requiredEnvironment("MEOING_LOAD_SUPABASE_URL"),
    "MEOING_LOAD_SUPABASE_URL",
  );
  const publishableKey = requiredEnvironment("MEOING_LOAD_SUPABASE_PUBLISHABLE_KEY");
  const tokens = [];
  for (let offset = 0; offset < users.length; offset += 10) {
    const batch = users.slice(offset, offset + 10);
    tokens.push(...await Promise.all(batch.map((user) =>
      passwordAccessToken({
        email: user.email,
        password: user.password,
        publishableKey,
        supabaseUrl,
      })
    )));
  }
  return tokens;
}

const tokens = await resolveTokens();
assert(tokens.length >= concurrency, `Load gate needs at least ${concurrency} test identities`);
assert(
  new Set(tokens.slice(0, concurrency)).size === concurrency,
  "Every virtual user must have a unique access token",
);

async function timedRequest(token, path, { body, method = "GET" } = {}) {
  const startedAt = performance.now();
  try {
    const response = await fetch(resolveUrl(apiUrl, path), {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await parseResponseBody(response);
    return {
      durationMs: performance.now() - startedAt,
      ok: response.ok,
      payload,
      status: response.status,
    };
  } catch {
    return {
      durationMs: performance.now() - startedAt,
      ok: false,
      payload: null,
      status: 0,
    };
  }
}

console.log(
  `Starting ${concurrency} authenticated users for ${durationSeconds}s at up to ${requestsPerMinute} requests/user/minute`,
);

const virtualUsers = [];
for (let index = 0; index < concurrency; index += 1) {
  const token = tokens[index];
  const initial = await timedRequest(token, "/v1/me");
  assert(initial.ok, `Virtual user ${index + 1} failed initial /v1/me with HTTP ${initial.status}`);
  const profile = initial.payload?.data?.profile;
  assert(
    initial.payload?.data?.onboardingComplete === true &&
    Number.isInteger(profile?.revision),
    `Virtual user ${index + 1} is not verified and fully onboarded`,
  );
  virtualUsers.push({
    token,
    displayName: profile.displayName || `Load user ${index + 1}`,
    revision: profile.revision,
  });
}

const readLatencies = [];
const mutationLatencies = [];
const errorsByStatus = new Map();
let requestCount = 0;
let errorCount = 0;
let healthCheckCount = 0;
let healthErrorCount = 0;
const startedAt = Date.now();
const deadline = startedAt + durationSeconds * 1_000;

function record(result, category) {
  requestCount += 1;
  if (result.ok) {
    (category === "mutation" ? mutationLatencies : readLatencies).push(result.durationMs);
    return;
  }
  errorCount += 1;
  errorsByStatus.set(result.status, (errorsByStatus.get(result.status) ?? 0) + 1);
}

async function runVirtualUser(user) {
  let iteration = 0;
  while (Date.now() < deadline) {
    const targetStartedAt = startedAt + iteration * requestIntervalMs;
    const waitMs = targetStartedAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    if (Date.now() >= deadline) break;

    const mutation = !readOnly && iteration % mutationEvery === mutationEvery - 1;
    if (mutation) {
      const result = await timedRequest(user.token, "/v1/me/profile", {
        method: "PATCH",
        body: {
          displayName: user.displayName,
          expectedRevision: user.revision,
        },
      });
      record(result, "mutation");
      if (result.ok && Number.isInteger(result.payload?.data?.revision)) {
        user.revision = result.payload.data.revision;
      }
    } else {
      record(await timedRequest(user.token, "/v1/me"), "read");
    }
    iteration += 1;
  }
}

async function monitorReadiness() {
  while (Date.now() < deadline) {
    const response = await fetch(resolveUrl(apiUrl, "/health/ready"), {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    healthCheckCount += 1;
    if (!response?.ok) healthErrorCount += 1;
    await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
  }
}

await Promise.all([
  ...virtualUsers.map((user) => runVirtualUser(user)),
  monitorReadiness(),
]);

const read = latencySummary(readLatencies);
const mutation = latencySummary(mutationLatencies);
const errorRate = requestCount === 0 ? 1 : errorCount / requestCount;
const failures = [];
if (read.count === 0) failures.push("no successful authenticated reads were recorded");
if (!readOnly && mutation.count === 0) failures.push("no successful mutations were recorded");
if ((read.p95Ms ?? Number.POSITIVE_INFINITY) >= readP95Limit) {
  failures.push(`read p95 ${read.p95Ms} ms is not below ${readP95Limit} ms`);
}
if (!readOnly && (mutation.p95Ms ?? Number.POSITIVE_INFINITY) >= mutationP95Limit) {
  failures.push(`mutation p95 ${mutation.p95Ms} ms is not below ${mutationP95Limit} ms`);
}
if (errorRate >= maximumErrorRate) {
  failures.push(`error rate ${(errorRate * 100).toFixed(3)}% is not below ${maximumErrorRate * 100}%`);
}
if (healthErrorCount > 0) {
  failures.push(`${healthErrorCount}/${healthCheckCount} readiness probes failed during the load`);
}

const summary = {
  status: failures.length === 0 ? "passed" : "failed",
  fullGate: !readOnly,
  startedAt: new Date(startedAt).toISOString(),
  durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  configuration: {
    concurrency,
    requestedDurationSeconds: durationSeconds,
    requestsPerUserPerMinute: requestsPerMinute,
    mutationEvery: readOnly ? null : mutationEvery,
    thresholds: {
      readP95MsExclusive: readP95Limit,
      mutationP95MsExclusive: readOnly ? null : mutationP95Limit,
      maximumErrorRateExclusive: maximumErrorRate,
    },
  },
  requests: {
    total: requestCount,
    errors: errorCount,
    errorRate,
    errorsByStatus: Object.fromEntries([...errorsByStatus.entries()].sort(([left], [right]) => left - right)),
  },
  read,
  mutation: readOnly ? null : mutation,
  readiness: {
    checks: healthCheckCount,
    errors: healthErrorCount,
  },
  failures,
};
await writeJsonSummary(outputPath, summary);
console.log(JSON.stringify(summary, null, 2));

if (failures.length > 0) {
  throw new Error(`Load gate failed: ${failures.join("; ")}`);
}
