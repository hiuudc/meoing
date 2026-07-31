import {
  assert,
  parseResponseBody,
  resolveUrl,
} from "./acceptance-helpers.mjs";
import { acquirePasswordAccessTokens } from "./acceptance-auth.mjs";
import {
  assertExpectedStagingApiOrigin,
  assertOwnedAcceptanceUser,
  existingAcceptanceUsersByEmail,
  requireStagingProvisioningTargets,
  reservedAcceptanceEmail,
} from "./provision-staging-guard.mjs";

const AUTH_USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCEPTANCE_IDENTITY_COUNT = 102;

export function parseAcceptanceCleanupSelection(value) {
  let selection;
  try {
    selection = JSON.parse(value);
  } catch {
    throw new Error("MEOING_CLEANUP_USERNAMES_JSON must be a valid JSON array");
  }

  assert(
    Array.isArray(selection),
    "MEOING_CLEANUP_USERNAMES_JSON must be a JSON array",
  );
  assert(
    selection.length >= 1 && selection.length <= ACCEPTANCE_IDENTITY_COUNT,
    `MEOING_CLEANUP_USERNAMES_JSON must select between 1 and ${ACCEPTANCE_IDENTITY_COUNT} users`,
  );

  for (const username of selection) {
    assert(
      typeof username === "string" && username === username.trim(),
      "Cleanup selections must be exact reserved staging usernames",
    );
    reservedAcceptanceEmail(username);
  }
  assert(
    new Set(selection).size === selection.length,
    "Cleanup selections must not contain duplicate usernames",
  );
  return selection;
}

function checkedPassword(value, name) {
  assert(
    typeof value === "string" && value.length >= 12,
    `${name} must contain at least 12 characters`,
  );
  return value;
}

function cleanupIdentity({
  loadPassword,
  memberPassword,
  ownerPassword,
  username,
}) {
  const password = username === "acceptance.owner"
    ? ownerPassword
    : username === "acceptance.member"
      ? memberPassword
      : loadPassword;
  return {
    email: reservedAcceptanceEmail(username),
    password,
    username,
  };
}

export async function cleanupStagingAcceptanceUsers({
  applicationDataCleaner,
  apiUrl,
  expectedApiOrigin,
  expectedProjectRef,
  fetchImplementation = fetch,
  loadPassword,
  maximumAuthAttempts = 8,
  memberPassword,
  onAuthenticationProgress = () => {},
  onAuthenticationRetry = () => {},
  ownerPassword,
  publishableKey,
  requestIntervalMilliseconds = 2_100,
  requestTimeoutMilliseconds = 20_000,
  secretKey,
  selectedUsernames,
  supabaseUrl,
  wait,
}) {
  assert(
    Array.isArray(selectedUsernames) && selectedUsernames.length > 0,
    "At least one reserved staging username must be explicitly selected",
  );
  assert(
    applicationDataCleaner &&
      typeof applicationDataCleaner.purge === "function" &&
      typeof applicationDataCleaner.verifyAbsent === "function",
    "A direct staging database and R2 application-data cleaner is required",
  );
  assert(
    new Set(selectedUsernames).size === selectedUsernames.length,
    "Cleanup selections must not contain duplicate usernames",
  );
  assert(
    typeof secretKey === "string" && secretKey.startsWith("sb_secret_"),
    "MEOING_CLEANUP_SUPABASE_SECRET_KEY must be a temporary sb_secret_* key",
  );
  assert(
    typeof publishableKey === "string" && publishableKey.length > 0,
    "MEOING_CLEANUP_SUPABASE_PUBLISHABLE_KEY is required",
  );

  const passwords = {
    loadPassword: checkedPassword(loadPassword, "MEOING_CLEANUP_LOAD_PASSWORD"),
    memberPassword: checkedPassword(
      memberPassword,
      "MEOING_CLEANUP_MEMBER_PASSWORD",
    ),
    ownerPassword: checkedPassword(ownerPassword, "MEOING_CLEANUP_OWNER_PASSWORD"),
  };
  const identities = selectedUsernames.map((username) =>
    cleanupIdentity({ ...passwords, username }));

  assertExpectedStagingApiOrigin({ apiUrl, expectedApiOrigin });
  await requireStagingProvisioningTargets({
    apiUrl,
    expectedProjectRef,
    fetchImplementation,
    requestTimeoutMilliseconds,
    supabaseUrl,
  });

  async function authAdminRequest(path, { method = "GET" } = {}) {
    const response = await fetchImplementation(resolveUrl(supabaseUrl, path), {
      method,
      headers: {
        accept: "application/json",
        apikey: secretKey,
      },
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    });
    const payload = await parseResponseBody(response);
    return { payload, response };
  }

  const existing = await existingAcceptanceUsersByEmail({
    adminRequest: async (path) => {
      const { payload, response } = await authAdminRequest(path);
      assert(
        response.ok,
        `Supabase Auth Admin list failed with HTTP ${response.status}; no users were deleted`,
      );
      return payload;
    },
    targetEmails: identities.map(({ email }) => email),
  });

  const candidates = [];
  for (const identity of identities) {
    const user = existing.get(identity.email);
    if (!user) continue;
    assert(
      typeof user.email === "string" && user.email.toLowerCase() === identity.email,
      "Refusing to delete an Auth user outside the reserved staging email namespace",
    );
    assert(
      typeof user.id === "string" && AUTH_USER_ID_PATTERN.test(user.id),
      "Refusing to delete a reserved staging identity with an invalid Auth user ID",
    );
    assertOwnedAcceptanceUser({
      expectedProjectRef,
      user,
      username: identity.username,
    });
    candidates.push({ identity, userId: user.id });
  }

  if (candidates.length === 0) {
    return {
      absent: identities.length,
      deleted: 0,
      selected: identities.length,
    };
  }

  const acquiredTokens = [];
  const revokedTokens = new Set();

  async function revokeAllSessions(token) {
    const response = await fetchImplementation(
      resolveUrl(supabaseUrl, "/auth/v1/logout?scope=global"),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: publishableKey,
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      },
    );
    await parseResponseBody(response);
    assert(
      response.ok,
      `Supabase global session revocation failed with HTTP ${response.status}; no deletion followed that failure`,
    );
  }

  try {
    const tokens = await acquirePasswordAccessTokens({
      fetchImplementation,
      maximumAttempts: maximumAuthAttempts,
      onProgress: onAuthenticationProgress,
      onRetry: onAuthenticationRetry,
      onTokenAcquired: ({ token }) => acquiredTokens.push(token),
      passwordUsers: candidates.map(({ identity }) => identity),
      publishableKey,
      requestIntervalMilliseconds,
      requestTimeoutMilliseconds,
      supabaseUrl,
      ...(wait === undefined ? {} : { wait }),
    });
    assert(
      tokens.length === candidates.length,
      "Supabase did not issue all selected cleanup access tokens",
    );

    for (let index = 0; index < candidates.length; index += 1) {
      const response = await fetchImplementation(resolveUrl(apiUrl, "/v1/me"), {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${tokens[index]}`,
        },
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
      const payload = await parseResponseBody(response);
      assert(
        response.ok,
        `Staging profile verification failed with HTTP ${response.status}; no users were deleted`,
      );
      assert(
        payload?.data?.emailVerified === true &&
          payload?.data?.userId === candidates[index].userId &&
          payload?.data?.profile?.username === candidates[index].identity.username,
        "Refusing cleanup because a selected Auth user does not match its verified staging profile",
      );
    }

    // Revoke every selected user's refresh sessions before deleting any user.
    for (const token of tokens) {
      await revokeAllSessions(token);
      revokedTokens.add(token);
    }

    const cleanupReceipt = await applicationDataCleaner.purge({
      candidates,
      expectedProjectRef,
    });

    let deleted = 0;
    for (const candidate of candidates) {
      const deletion = await authAdminRequest(
        `/auth/v1/admin/users/${encodeURIComponent(candidate.userId)}`,
        { method: "DELETE" },
      );
      assert(
        deletion.response.ok || deletion.response.status === 404,
        `Supabase Auth Admin deletion failed with HTTP ${deletion.response.status}`,
      );

      const verification = await authAdminRequest(
        `/auth/v1/admin/users/${encodeURIComponent(candidate.userId)}`,
      );
      assert(
        verification.response.status === 404,
        `Supabase Auth Admin deletion verification failed with HTTP ${verification.response.status}`,
      );
      deleted += 1;
    }

    await applicationDataCleaner.verifyAbsent({
      expectedProjectRef,
      receipt: cleanupReceipt,
    });

    return {
      absent: identities.length - candidates.length,
      deleted,
      selected: identities.length,
    };
  } finally {
    // A failed sign-in batch or profile check may have created fresh sessions.
    // Best-effort global logout keeps the failure path cleanup-only and secret-free.
    for (const token of acquiredTokens) {
      if (revokedTokens.has(token)) continue;
      try {
        await revokeAllSessions(token);
      } catch {
        // Preserve the original failure without logging tokens or response bodies.
      }
    }
  }
}
