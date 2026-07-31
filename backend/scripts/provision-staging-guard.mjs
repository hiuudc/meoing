import {
  assert,
  parseResponseBody,
  resolveUrl,
} from "./acceptance-helpers.mjs";

const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const LOAD_USERNAME_PATTERN = /^load([0-9]{3})$/;

export function assertReservedAcceptanceIdentity({ email, username }) {
  let expectedEmail;
  if (username === "acceptance.owner") {
    expectedEmail = "acceptance-owner@auth.meoing.com";
  } else if (username === "acceptance.member") {
    expectedEmail = "acceptance-member@auth.meoing.com";
  } else {
    const loadMatch = LOAD_USERNAME_PATTERN.exec(username);
    assert(loadMatch, "Acceptance usernames must use the reserved staging namespace");
    const loadIndex = Number(loadMatch[1]);
    assert(
      loadIndex >= 1 && loadIndex <= 100,
      "Acceptance load usernames must be between load001 and load100",
    );
    expectedEmail = `acceptance-load-${loadMatch[1]}@auth.meoing.com`;
  }
  assert(
    email === expectedEmail,
    "Acceptance emails must use the reserved staging namespace",
  );
}

export function acceptanceUserMarker({ expectedProjectRef, username }) {
  return {
    project_ref: expectedProjectRef,
    username,
  };
}

export function acceptanceAuthMutation({
  expectedProjectRef,
  identity,
  user,
}) {
  if (user) {
    assert(
      typeof user.id === "string" && user.id.length > 0,
      "An existing acceptance Auth user must have an ID",
    );
    return {
      body: {
        email_confirm: true,
        password: identity.password,
      },
      method: "PUT",
      path: `/auth/v1/admin/users/${encodeURIComponent(user.id)}`,
    };
  }

  return {
    body: {
      app_metadata: {
        meoing_acceptance: acceptanceUserMarker({
          expectedProjectRef,
          username: identity.username,
        }),
      },
      email: identity.email,
      email_confirm: true,
      password: identity.password,
    },
    method: "POST",
    path: "/auth/v1/admin/users",
  };
}

export function assertOwnedAcceptanceUser({
  expectedProjectRef,
  user,
  username,
}) {
  const marker = user?.app_metadata?.meoing_acceptance;
  const markerKeys =
    marker && typeof marker === "object" && !Array.isArray(marker)
      ? Object.keys(marker).sort()
      : [];
  assert(
    markerKeys.length === 2 &&
      markerKeys[0] === "project_ref" &&
      markerKeys[1] === "username" &&
    marker?.project_ref === expectedProjectRef &&
      marker?.username === username,
    `Refusing to modify existing unowned staging identity ${username}`,
  );
}

export async function existingAcceptanceUsersByEmail({
  adminRequest,
  perPage = 1_000,
  targetEmails,
}) {
  const remaining = new Set(targetEmails);
  const matches = new Map();
  for (let page = 1; remaining.size > 0; page += 1) {
    const payload = await adminRequest(
      `/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
    );
    const users = payload?.users;
    assert(Array.isArray(users), "Supabase Auth Admin returned an invalid user list");
    for (const user of users) {
      const email = typeof user?.email === "string" ? user.email.toLowerCase() : null;
      if (email && remaining.has(email) && typeof user.id === "string") {
        matches.set(email, user);
        remaining.delete(email);
      }
    }
    if (users.length < perPage) break;
  }
  return matches;
}

export function assertExpectedStagingSupabaseProject({
  expectedProjectRef,
  supabaseUrl,
}) {
  assert(
    SUPABASE_PROJECT_REF_PATTERN.test(expectedProjectRef),
    "MEOING_PROVISION_EXPECTED_SUPABASE_PROJECT_REF must be a 20-character lowercase alphanumeric project ref",
  );

  const expectedOrigin = `https://${expectedProjectRef}.supabase.co`;
  assert(
    supabaseUrl.origin === expectedOrigin &&
      supabaseUrl.pathname === "/" &&
      supabaseUrl.username === "" &&
      supabaseUrl.password === "",
    "MEOING_PROVISION_SUPABASE_URL must be the canonical URL for MEOING_PROVISION_EXPECTED_SUPABASE_PROJECT_REF; no Auth Admin changes were made",
  );
}

export async function requireStagingProvisioningTargets({
  apiUrl,
  expectedProjectRef,
  fetchImplementation = fetch,
  requestTimeoutMilliseconds = 20_000,
  supabaseUrl,
}) {
  assertExpectedStagingSupabaseProject({
    expectedProjectRef,
    supabaseUrl,
  });

  const liveResponse = await fetchImplementation(resolveUrl(apiUrl, "/health/live"), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  const livePayload = await parseResponseBody(liveResponse);
  assert(
    liveResponse.ok &&
      livePayload?.data?.status === "ok" &&
      livePayload?.data?.environment === "staging" &&
      livePayload?.data?.supabaseProjectRef === expectedProjectRef,
    `API liveness did not identify the expected staging Supabase project (HTTP ${liveResponse.status}); no Auth Admin changes were made`,
  );

  const readyResponse = await fetchImplementation(resolveUrl(apiUrl, "/health/ready"), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  const readyPayload = await parseResponseBody(readyResponse);
  assert(
    readyResponse.ok &&
      readyPayload?.data?.status === "ready" &&
      readyPayload?.data?.databaseEnvironment === "staging" &&
      readyPayload?.data?.databaseProjectRef === expectedProjectRef,
    `Staging API is not ready (HTTP ${readyResponse.status}); no Auth Admin changes were made`,
  );
}
