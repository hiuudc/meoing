import {
  assert,
  integerEnvironment,
  normalizedBaseUrl,
  parseResponseBody,
  requiredEnvironment,
  resolveUrl,
} from "./acceptance-helpers.mjs";
import { acquirePasswordAccessTokens } from "./acceptance-auth.mjs";
import {
  acceptanceAuthMutation,
  assertOwnedAcceptanceUser,
  assertReservedAcceptanceIdentity,
  existingAcceptanceUsersByEmail,
  requireStagingProvisioningTargets,
} from "./provision-staging-guard.mjs";

const LOAD_USER_COUNT = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

const HELP = `
Meoing staging acceptance user provisioning

This command is intentionally run only after the staging API and migrations are ready.
It creates or updates two smoke accounts and load001-load100, confirms their email
addresses without sending email, then completes username onboarding through the API.

Required:
  MEOING_PROVISION_API_URL
  MEOING_PROVISION_SUPABASE_URL
  MEOING_PROVISION_EXPECTED_SUPABASE_PROJECT_REF
    Non-secret 20-character staging project ref. The Supabase URL must match it.
  MEOING_PROVISION_SUPABASE_SECRET_KEY
    Temporary sb_secret_* key. It is sent only in the Supabase apikey header.
  MEOING_PROVISION_SUPABASE_PUBLISHABLE_KEY
  MEOING_PROVISION_OWNER_EMAIL
  MEOING_PROVISION_OWNER_PASSWORD
  MEOING_PROVISION_MEMBER_EMAIL
  MEOING_PROVISION_MEMBER_PASSWORD
  MEOING_LOAD_EMAIL_TEMPLATE
    Must contain exactly one {index}; it expands to 001 through 100.
  MEOING_LOAD_PASSWORD

Auth pacing (optional):
  MEOING_ACCEPTANCE_AUTH_INTERVAL_MS=2100
  MEOING_ACCEPTANCE_AUTH_MAX_ATTEMPTS=8

The command never prints credentials. Revoke the temporary Supabase secret key after
the command succeeds.
`;

if (process.argv.includes("--help")) {
  console.log(HELP.trim());
  process.exit(0);
}

const apiUrl = normalizedBaseUrl(
  requiredEnvironment("MEOING_PROVISION_API_URL"),
  "MEOING_PROVISION_API_URL",
);
const supabaseUrl = normalizedBaseUrl(
  requiredEnvironment("MEOING_PROVISION_SUPABASE_URL"),
  "MEOING_PROVISION_SUPABASE_URL",
);
const expectedSupabaseProjectRef = requiredEnvironment(
  "MEOING_PROVISION_EXPECTED_SUPABASE_PROJECT_REF",
);
const secretKey = requiredEnvironment("MEOING_PROVISION_SUPABASE_SECRET_KEY");
const publishableKey = requiredEnvironment("MEOING_PROVISION_SUPABASE_PUBLISHABLE_KEY");
const loadEmailTemplate = requiredEnvironment("MEOING_LOAD_EMAIL_TEMPLATE");
const authIntervalMilliseconds = integerEnvironment(
  "MEOING_ACCEPTANCE_AUTH_INTERVAL_MS",
  2_100,
  250,
  60_000,
);
const authMaximumAttempts = integerEnvironment(
  "MEOING_ACCEPTANCE_AUTH_MAX_ATTEMPTS",
  8,
  1,
  20,
);

assert(
  secretKey.startsWith("sb_secret_"),
  "MEOING_PROVISION_SUPABASE_SECRET_KEY must be a temporary sb_secret_* key",
);

function normalizedEmail(value, environmentName) {
  const email = value.trim().toLowerCase();
  assert(EMAIL_PATTERN.test(email), `${environmentName} must contain a valid email address`);
  return email;
}

function checkedPassword(value, environmentName) {
  assert(value.length >= 12, `${environmentName} must contain at least 12 characters`);
  return value;
}

function indexedLoadEmail(index) {
  const placeholders = loadEmailTemplate.match(/\{index\}/g) ?? [];
  assert(
    placeholders.length === 1,
    "MEOING_LOAD_EMAIL_TEMPLATE must contain exactly one {index} placeholder",
  );
  const paddedIndex = String(index).padStart(3, "0");
  return normalizedEmail(
    loadEmailTemplate.replace("{index}", paddedIndex),
    "MEOING_LOAD_EMAIL_TEMPLATE",
  );
}

const identities = [
  {
    email: normalizedEmail(
      requiredEnvironment("MEOING_PROVISION_OWNER_EMAIL"),
      "MEOING_PROVISION_OWNER_EMAIL",
    ),
    password: checkedPassword(
      requiredEnvironment("MEOING_PROVISION_OWNER_PASSWORD"),
      "MEOING_PROVISION_OWNER_PASSWORD",
    ),
    username: "acceptance.owner",
  },
  {
    email: normalizedEmail(
      requiredEnvironment("MEOING_PROVISION_MEMBER_EMAIL"),
      "MEOING_PROVISION_MEMBER_EMAIL",
    ),
    password: checkedPassword(
      requiredEnvironment("MEOING_PROVISION_MEMBER_PASSWORD"),
      "MEOING_PROVISION_MEMBER_PASSWORD",
    ),
    username: "acceptance.member",
  },
  ...Array.from({ length: LOAD_USER_COUNT }, (_, offset) => {
    const index = offset + 1;
    return {
      email: indexedLoadEmail(index),
      password: checkedPassword(
        requiredEnvironment("MEOING_LOAD_PASSWORD"),
        "MEOING_LOAD_PASSWORD",
      ),
      username: `load${String(index).padStart(3, "0")}`,
    };
  }),
];

assert(
  new Set(identities.map(({ email }) => email)).size === identities.length,
  "Acceptance account emails must be unique",
);
assert(
  new Set(identities.map(({ username }) => username)).size === identities.length,
  "Acceptance account usernames must be unique",
);
for (const identity of identities) {
  assertReservedAcceptanceIdentity(identity);
}

async function adminRequest(path, { body, method = "GET" } = {}) {
  const response = await fetch(resolveUrl(supabaseUrl, path), {
    method,
    headers: {
      accept: "application/json",
      apikey: secretKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(`Supabase Auth Admin ${method} request failed with HTTP ${response.status}`);
  }
  return payload;
}

async function synchronizeAuthUsers() {
  const existing = await existingAcceptanceUsersByEmail({
    adminRequest,
    targetEmails: identities.map(({ email }) => email),
  });
  let created = 0;
  let updated = 0;

  for (const identity of identities) {
    const user = existing.get(identity.email);
    if (!user) continue;
    assertOwnedAcceptanceUser({
      expectedProjectRef: expectedSupabaseProjectRef,
      user,
      username: identity.username,
    });
  }

  for (let offset = 0; offset < identities.length; offset += 1) {
    const identity = identities[offset];
    const user = existing.get(identity.email);
    const mutation = acceptanceAuthMutation({
      expectedProjectRef: expectedSupabaseProjectRef,
      identity,
      user,
    });
    if (user) {
      await adminRequest(mutation.path, {
        method: mutation.method,
        body: mutation.body,
      });
      updated += 1;
    } else {
      const createdPayload = await adminRequest(mutation.path, {
        method: mutation.method,
        body: mutation.body,
      });
      assertOwnedAcceptanceUser({
        expectedProjectRef: expectedSupabaseProjectRef,
        user: createdPayload?.user ?? createdPayload,
        username: identity.username,
      });
      created += 1;
    }

    if ((offset + 1) % 10 === 0 || offset + 1 === identities.length) {
      console.log(`Auth synchronization: ${offset + 1}/${identities.length}`);
    }
  }
  return { created, updated };
}

async function appRequest(path, token, { body, method = "GET" } = {}) {
  const response = await fetch(resolveUrl(apiUrl, path), {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await parseResponseBody(response);
  if (!response.ok) {
    const code = typeof payload?.error?.code === "string" ? ` (${payload.error.code})` : "";
    throw new Error(`Staging API ${method} request failed with HTTP ${response.status}${code}`);
  }
  return payload;
}

async function completeOnboarding() {
  let claimed = 0;
  let alreadyComplete = 0;
  const tokens = await acquirePasswordAccessTokens({
    maximumAttempts: authMaximumAttempts,
    onProgress: ({ completed, total }) => {
      if (completed % 10 === 0 || completed === total) {
        console.log(`Provisioning authentication: ${completed}/${total}`);
      }
    },
    onRetry: ({ attempt, delayMilliseconds, maximumAttempts }) => {
      console.warn(
        "Supabase Auth rate-limited provisioning authentication; " +
          `retrying in ${Math.ceil(delayMilliseconds / 1_000)}s ` +
          `(attempt ${attempt + 1}/${maximumAttempts})`,
      );
    },
    passwordUsers: identities,
    publishableKey,
    requestIntervalMilliseconds: authIntervalMilliseconds,
    supabaseUrl,
  });

  for (let offset = 0; offset < identities.length; offset += 1) {
    const identity = identities[offset];
    const token = tokens[offset];
    assert(typeof token === "string", "A provisioned acceptance account has no access token");
    let me = await appRequest("/v1/me", token);
    assert(me?.data?.emailVerified === true, "A provisioned acceptance account is not verified");

    if (me?.data?.profile?.username === null) {
      await appRequest("/v1/me/username", token, {
        method: "POST",
        body: { username: identity.username },
      });
      claimed += 1;
      me = await appRequest("/v1/me", token);
    } else {
      alreadyComplete += 1;
    }

    assert(
      me?.data?.onboardingComplete === true &&
        me?.data?.profile?.username === identity.username,
      "A provisioned acceptance account did not complete onboarding",
    );

    if ((offset + 1) % 10 === 0 || offset + 1 === identities.length) {
      console.log(`Username onboarding: ${offset + 1}/${identities.length}`);
    }
  }
  return { alreadyComplete, claimed };
}

await requireStagingProvisioningTargets({
  apiUrl,
  expectedProjectRef: expectedSupabaseProjectRef,
  supabaseUrl,
});
console.log("Staging API and Supabase project identity confirmed; starting Auth synchronization");
const auth = await synchronizeAuthUsers();
const onboarding = await completeOnboarding();
console.log(
  `Provisioned ${identities.length} acceptance identities: ` +
    `${auth.created} created, ${auth.updated} updated, ` +
    `${onboarding.claimed} usernames claimed, ${onboarding.alreadyComplete} already onboarded`,
);
console.log("Revoke the temporary Supabase secret key now.");
