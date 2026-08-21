import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupStagingAcceptanceUsers,
  parseAcceptanceCleanupSelection,
} from "./acceptance-cleanup.mjs";

const STAGING_PROJECT_REF = "stagingprojectref001";
const API_URL = new URL("https://api-staging.meoing.com/");
const SUPABASE_URL = new URL(`https://${STAGING_PROJECT_REF}.supabase.co/`);
const AUTH_USER_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_AUTH_USER_ID = "00000000-0000-4000-8000-000000000002";
const ACCESS_TOKEN = "secret-access-token-that-must-never-be-logged";
const MEMBER_ACCESS_TOKEN = "second-secret-access-token";
const RESERVED_EMAIL = "acceptance-owner@auth.meoing.com";
const MEMBER_RESERVED_EMAIL = "acceptance-member@auth.meoing.com";

function options(overrides = {}) {
  return {
    applicationDataCleaner: {
      purge: async ({ candidates }) => ({
        assetIds: [],
        assetKeys: [],
        collectionIds: [],
        userIds: candidates.map(({ userId }) => userId),
      }),
      verifyAbsent: async () => {},
    },
    apiUrl: API_URL,
    expectedApiOrigin: API_URL,
    expectedProjectRef: STAGING_PROJECT_REF,
    loadPassword: "load-password-not-real",
    maximumAuthAttempts: 1,
    memberPassword: "member-password-not-real",
    ownerPassword: "owner-password-not-real",
    publishableKey: "sb_publishable_test",
    requestIntervalMilliseconds: 0,
    secretKey: "sb_secret_test",
    selectedUsernames: ["acceptance.owner"],
    supabaseUrl: SUPABASE_URL,
    wait: async () => {},
    ...overrides,
  };
}

function healthResponse(pathname) {
  if (pathname === "/health/live") {
    return Response.json({
      data: {
        environment: "staging",
        status: "ok",
        supabaseProjectRef: STAGING_PROJECT_REF,
      },
    });
  }
  if (pathname === "/health/ready") {
    return Response.json({
      data: {
        databaseEnvironment: "staging",
        databaseProjectRef: STAGING_PROJECT_REF,
        status: "ready",
      },
    });
  }
  return null;
}

function ownedUser(marker = {
  project_ref: STAGING_PROJECT_REF,
  username: "acceptance.owner",
}) {
  return {
    app_metadata: { meoing_acceptance: marker },
    email: RESERVED_EMAIL,
    id: AUTH_USER_ID,
  };
}

test("parses only a non-empty, unique list of exact reserved usernames", () => {
  assert.deepEqual(
    parseAcceptanceCleanupSelection(
      '["acceptance.owner","acceptance.member","load001","load100"]',
    ),
    ["acceptance.owner", "acceptance.member", "load001", "load100"],
  );

  for (const value of [
    "not-json",
    "{}",
    "[]",
    '["acceptance.owner","acceptance.owner"]',
    '[" acceptance.owner"]',
    '["acceptance-owner@auth.meoing.com"]',
    '["load000"]',
    '["load101"]',
    "[true]",
  ]) {
    assert.throws(() => parseAcceptanceCleanupSelection(value));
  }
});

test("treats explicitly selected users that are already absent as a safe no-op", async () => {
  const requests = [];
  const summary = await cleanupStagingAcceptanceUsers(options({
    fetchImplementation: async (input, init = {}) => {
      const url = new URL(input);
      requests.push(`${init.method ?? "GET"} ${url.pathname}`);
      const health = healthResponse(url.pathname);
      if (health) return health;
      if (url.pathname === "/auth/v1/admin/users" && url.search) {
        return Response.json({ users: [] });
      }
      throw new Error("Unexpected request in absent-user test");
    },
  }));

  assert.deepEqual(summary, { absent: 1, deleted: 0, selected: 1 });
  assert.deepEqual(requests, [
    "GET /health/live",
    "GET /health/ready",
    "GET /auth/v1/admin/users",
  ]);
});

test("refuses every non-exact ownership marker before sign-in or mutation", async () => {
  const invalidMarkers = [
    undefined,
    true,
    { project_ref: "aaaaaaaaaaaaaaaaaaaa", username: "acceptance.owner" },
    { project_ref: STAGING_PROJECT_REF, username: "acceptance.member" },
    {
      extra: true,
      project_ref: STAGING_PROJECT_REF,
      username: "acceptance.owner",
    },
  ];

  for (const marker of invalidMarkers) {
    const requests = [];
    await assert.rejects(
      cleanupStagingAcceptanceUsers(options({
        fetchImplementation: async (input, init = {}) => {
          const url = new URL(input);
          requests.push(`${init.method ?? "GET"} ${url.pathname}`);
          const health = healthResponse(url.pathname);
          if (health) return health;
          if (url.pathname === "/auth/v1/admin/users" && url.search) {
            const user = ownedUser();
            user.app_metadata = marker === undefined
              ? {}
              : { meoing_acceptance: marker };
            return Response.json({ users: [user] });
          }
          throw new Error("Cleanup continued after an invalid marker");
        },
      })),
      /Refusing to modify existing unowned staging identity/,
    );
    assert.deepEqual(requests, [
      "GET /health/live",
      "GET /health/ready",
      "GET /auth/v1/admin/users",
    ]);
  }
});

test("verifies every profile and revokes every session before the first hard delete", async () => {
  const requests = [];
  const lifecycle = [];
  const summary = await cleanupStagingAcceptanceUsers(options({
    applicationDataCleaner: {
      purge: async ({ candidates }) => {
        lifecycle.push("purge-app-data");
        return {
          assetIds: ["00000000-0000-4000-8000-000000000099"],
          assetKeys: ["users/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000099"],
          collectionIds: ["00000000-0000-4000-8000-000000000098"],
          userIds: candidates.map(({ userId }) => userId),
        };
      },
      verifyAbsent: async () => lifecycle.push("verify-app-data-absent"),
    },
    fetchImplementation: async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      requests.push(`${method} ${url.pathname}${url.search}`);
      const health = healthResponse(url.pathname);
      if (health) return health;
      if (url.pathname === "/auth/v1/admin/users" && url.search) {
        assert.equal(init.headers.apikey, "sb_secret_test");
        return Response.json({
          users: [
            ownedUser(),
            {
              app_metadata: {
                meoing_acceptance: {
                  project_ref: STAGING_PROJECT_REF,
                  username: "acceptance.member",
                },
              },
              email: MEMBER_RESERVED_EMAIL,
              id: MEMBER_AUTH_USER_ID,
            },
          ],
        });
      }
      if (url.pathname === "/auth/v1/token") {
        assert.equal(init.headers.apikey, "sb_publishable_test");
        const body = JSON.parse(init.body);
        return Response.json({
          access_token: body.email === RESERVED_EMAIL
            ? ACCESS_TOKEN
            : MEMBER_ACCESS_TOKEN,
        });
      }
      if (url.hostname === API_URL.hostname && url.pathname === "/v1/me") {
        const owner = init.headers.authorization === `Bearer ${ACCESS_TOKEN}`;
        return Response.json({
          data: {
            emailVerified: true,
            profile: {
              username: owner ? "acceptance.owner" : "acceptance.member",
            },
            userId: owner ? AUTH_USER_ID : MEMBER_AUTH_USER_ID,
          },
        });
      }
      if (url.pathname === "/auth/v1/logout") {
        lifecycle.push(`logout:${init.headers.authorization}`);
        assert.equal(url.searchParams.get("scope"), "global");
        assert(
          [
            `Bearer ${ACCESS_TOKEN}`,
            `Bearer ${MEMBER_ACCESS_TOKEN}`,
          ].includes(init.headers.authorization),
        );
        return new Response(null, { status: 204 });
      }
      if ([
        `/auth/v1/admin/users/${AUTH_USER_ID}`,
        `/auth/v1/admin/users/${MEMBER_AUTH_USER_ID}`,
      ].includes(url.pathname)) {
        assert.equal(init.headers.apikey, "sb_secret_test");
        if (method === "DELETE") lifecycle.push(`delete-auth:${url.pathname}`);
        return method === "DELETE"
          ? new Response(null, { status: 204 })
          : new Response(null, { status: 404 });
      }
      throw new Error("Unexpected cleanup request");
    },
    selectedUsernames: ["acceptance.owner", "acceptance.member"],
  }));

  assert.deepEqual(summary, { absent: 0, deleted: 2, selected: 2 });
  assert.deepEqual(lifecycle, [
    `logout:Bearer ${ACCESS_TOKEN}`,
    `logout:Bearer ${MEMBER_ACCESS_TOKEN}`,
    "purge-app-data",
    `delete-auth:/auth/v1/admin/users/${AUTH_USER_ID}`,
    `delete-auth:/auth/v1/admin/users/${MEMBER_AUTH_USER_ID}`,
    "verify-app-data-absent",
  ]);
  assert.deepEqual(requests, [
    "GET /health/live",
    "GET /health/ready",
    "GET /auth/v1/admin/users?page=1&per_page=1000",
    "POST /auth/v1/token?grant_type=password",
    "POST /auth/v1/token?grant_type=password",
    "GET /v1/me",
    "GET /v1/me",
    "POST /auth/v1/logout?scope=global",
    "POST /auth/v1/logout?scope=global",
    `DELETE /auth/v1/admin/users/${AUTH_USER_ID}`,
    `GET /auth/v1/admin/users/${AUTH_USER_ID}`,
    `DELETE /auth/v1/admin/users/${MEMBER_AUTH_USER_ID}`,
    `GET /auth/v1/admin/users/${MEMBER_AUTH_USER_ID}`,
  ]);
});

test("does not delete when global revocation fails and never exposes response secrets", async () => {
  const requests = [];
  let logoutAttempts = 0;
  const responseSecret = `${ACCESS_TOKEN}:${RESERVED_EMAIL}`;

  let error;
  try {
    await cleanupStagingAcceptanceUsers(options({
      fetchImplementation: async (input, init = {}) => {
        const url = new URL(input);
        const method = init.method ?? "GET";
        requests.push(`${method} ${url.pathname}`);
        const health = healthResponse(url.pathname);
        if (health) return health;
        if (url.pathname === "/auth/v1/admin/users" && url.search) {
          return Response.json({ users: [ownedUser()] });
        }
        if (url.pathname === "/auth/v1/token") {
          return Response.json({ access_token: ACCESS_TOKEN });
        }
        if (url.hostname === API_URL.hostname && url.pathname === "/v1/me") {
          return Response.json({
            data: {
              emailVerified: true,
              profile: { username: "acceptance.owner" },
              userId: AUTH_USER_ID,
            },
          });
        }
        if (url.pathname === "/auth/v1/logout") {
          logoutAttempts += 1;
          return Response.json({ error: responseSecret }, { status: 500 });
        }
        if (method === "DELETE") {
          throw new Error("Deletion ran after session revocation failed");
        }
        throw new Error("Unexpected cleanup request");
      },
    }));
    assert.fail("cleanup should fail when global session revocation fails");
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof Error);
  assert.match(error.message, /global session revocation failed with HTTP 500/);
  assert.equal(error.message.includes(ACCESS_TOKEN), false);
  assert.equal(error.message.includes(RESERVED_EMAIL), false);
  assert.equal(logoutAttempts, 2, "the failure path should retry best-effort revocation");
  assert.equal(requests.some((request) => request.startsWith("DELETE ")), false);
});

test("rejects a wrong staging target before listing or authenticating users", async () => {
  let requests = 0;
  await assert.rejects(
    cleanupStagingAcceptanceUsers(options({
      expectedProjectRef: "aaaaaaaaaaaaaaaaaaaa",
      fetchImplementation: async () => {
        requests += 1;
        return Response.json({});
      },
    })),
    /canonical URL/,
  );
  assert.equal(requests, 0);
});

test("rejects HTTP and foreign API origins before acquiring or sending a JWT", async () => {
  for (const apiUrl of [
    new URL("http://api-staging.meoing.com/"),
    new URL("https://foreign.example/"),
  ]) {
    let requests = 0;
    await assert.rejects(
      cleanupStagingAcceptanceUsers(options({
        apiUrl,
        fetchImplementation: async () => {
          requests += 1;
          throw new Error("A foreign API received a request");
        },
      })),
      /exactly match.*pinned HTTPS origin/,
    );
    assert.equal(requests, 0);
  }
});

test("does not hard-delete Auth users when application-data purge fails", async () => {
  const requests = [];
  await assert.rejects(
    cleanupStagingAcceptanceUsers(options({
      applicationDataCleaner: {
        purge: async () => {
          throw new Error("R2 deletion verification failed with HTTP 403");
        },
        verifyAbsent: async () => {
          throw new Error("verifyAbsent must not run after purge failure");
        },
      },
      fetchImplementation: async (input, init = {}) => {
        const url = new URL(input);
        const method = init.method ?? "GET";
        requests.push(`${method} ${url.pathname}`);
        const health = healthResponse(url.pathname);
        if (health) return health;
        if (url.pathname === "/auth/v1/admin/users" && url.search) {
          return Response.json({ users: [ownedUser()] });
        }
        if (url.pathname === "/auth/v1/token") {
          return Response.json({ access_token: ACCESS_TOKEN });
        }
        if (url.hostname === API_URL.hostname && url.pathname === "/v1/me") {
          return Response.json({
            data: {
              emailVerified: true,
              profile: { username: "acceptance.owner" },
              userId: AUTH_USER_ID,
            },
          });
        }
        if (url.pathname === "/auth/v1/logout") {
          return new Response(null, { status: 204 });
        }
        if (method === "DELETE") {
          throw new Error("Auth deletion ran after application-data purge failed");
        }
        throw new Error("Unexpected cleanup request");
      },
    })),
    /R2 deletion verification failed/,
  );
  assert.equal(requests.some((request) => request.startsWith("DELETE ")), false);
});
