import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExpectedStagingApiOrigin,
  acceptanceAuthMutation,
  acceptanceUserMarker,
  assertOwnedAcceptanceUser,
  assertExpectedStagingSupabaseProject,
  assertReservedAcceptanceIdentity,
  existingAcceptanceUsersByEmail,
  requireStagingProvisioningTargets,
  reservedAcceptanceEmail,
} from "./provision-staging-guard.mjs";

const STAGING_PROJECT_REF = "stagingprojectref001";
const API_URL = new URL("https://api-staging.meoing.com/");
const SUPABASE_URL = new URL(`https://${STAGING_PROJECT_REF}.supabase.co/`);

test("pins cleanup API traffic to the canonical Meoing staging HTTPS origin", () => {
  assert.doesNotThrow(() => assertExpectedStagingApiOrigin({
    apiUrl: API_URL,
    expectedApiOrigin: API_URL,
  }));
  for (const url of [
    new URL("http://api-staging.meoing.com/"),
    new URL("https://foreign.example/"),
  ]) {
    assert.throws(() => assertExpectedStagingApiOrigin({
      apiUrl: url,
      expectedApiOrigin: url,
    }));
  }
});

test("accepts only reserved staging acceptance identities", () => {
  assert.equal(
    reservedAcceptanceEmail("acceptance.owner"),
    "acceptance-owner@auth.meoing.com",
  );
  assert.equal(
    reservedAcceptanceEmail("load100"),
    "acceptance-load-100@auth.meoing.com",
  );
  for (const identity of [
    {
      email: "acceptance-owner@auth.meoing.com",
      username: "acceptance.owner",
    },
    {
      email: "acceptance-member@auth.meoing.com",
      username: "acceptance.member",
    },
    {
      email: "acceptance-load-001@auth.meoing.com",
      username: "load001",
    },
  ]) {
    assert.doesNotThrow(() => assertReservedAcceptanceIdentity(identity));
  }
  assert.throws(
    () =>
      assertReservedAcceptanceIdentity({
        email: "real-user@example.com",
        username: "acceptance.owner",
      }),
    /reserved staging namespace/,
  );
  assert.throws(
    () =>
      assertReservedAcceptanceIdentity({
        email: "acceptance-load-1@auth.meoing.com",
        username: "load001",
    }),
    /reserved staging namespace/,
  );
  for (const username of ["load000", "load101"]) {
    assert.throws(
      () =>
        assertReservedAcceptanceIdentity({
          email: `acceptance-load-${username.slice(-3)}@auth.meoing.com`,
          username,
        }),
      /between load001 and load100/,
    );
  }
});

test("refuses to reset an existing Auth user without the immutable acceptance marker", () => {
  const marker = acceptanceUserMarker({
    expectedProjectRef: STAGING_PROJECT_REF,
    username: "load001",
  });
  assert.doesNotThrow(() =>
    assertOwnedAcceptanceUser({
      expectedProjectRef: STAGING_PROJECT_REF,
      user: { app_metadata: { meoing_acceptance: marker } },
      username: "load001",
    }),
  );
  for (const user of [
    { app_metadata: {} },
    {
      app_metadata: {
        meoing_acceptance: {
          project_ref: "aaaaaaaaaaaaaaaaaaaa",
          username: "load001",
        },
      },
    },
    {
      app_metadata: {
        meoing_acceptance: {
          project_ref: STAGING_PROJECT_REF,
          username: "load002",
        },
      },
    },
    {
      app_metadata: {
        meoing_acceptance: {
          project_ref: STAGING_PROJECT_REF,
          username: "load001",
          unexpected: true,
        },
      },
    },
    {
      app_metadata: {},
      user_metadata: {
        meoing_acceptance: marker,
      },
    },
  ]) {
    assert.throws(
      () =>
        assertOwnedAcceptanceUser({
          expectedProjectRef: STAGING_PROJECT_REF,
          user,
          username: "load001",
        }),
      /Refusing to modify existing unowned staging identity/,
    );
  }
});

test("keeps the ownership marker immutable on idempotent Auth reruns", () => {
  const identity = {
    email: "acceptance-load-001@auth.meoing.com",
    password: "not-a-real-password",
    username: "load001",
  };
  const createMutation = acceptanceAuthMutation({
    expectedProjectRef: STAGING_PROJECT_REF,
    identity,
  });
  assert.deepEqual(createMutation, {
    body: {
      app_metadata: {
        meoing_acceptance: {
          project_ref: STAGING_PROJECT_REF,
          username: "load001",
        },
      },
      email: identity.email,
      email_confirm: true,
      password: identity.password,
    },
    method: "POST",
    path: "/auth/v1/admin/users",
  });

  const updateMutation = acceptanceAuthMutation({
    expectedProjectRef: STAGING_PROJECT_REF,
    identity,
    user: { id: "existing/auth-id" },
  });
  assert.deepEqual(updateMutation, {
    body: {
      email_confirm: true,
      password: identity.password,
    },
    method: "PUT",
    path: "/auth/v1/admin/users/existing%2Fauth-id",
  });
  assert.equal("app_metadata" in updateMutation.body, false);
});

test("pages through Auth users before matching a reserved identity", async () => {
  const requestedPaths = [];
  const pages = [
    {
      users: [
        { email: "someone@example.com", id: "unrelated-1" },
        { email: "another@example.com", id: "unrelated-2" },
      ],
    },
    {
      users: [
        {
          email: "ACCEPTANCE-LOAD-001@AUTH.MEOING.COM",
          id: "owned-load-user",
        },
      ],
    },
  ];

  const matches = await existingAcceptanceUsersByEmail({
    adminRequest: async (path) => {
      requestedPaths.push(path);
      return pages.shift();
    },
    perPage: 2,
    targetEmails: ["acceptance-load-001@auth.meoing.com"],
  });

  assert.deepEqual(requestedPaths, [
    "/auth/v1/admin/users?page=1&per_page=2",
    "/auth/v1/admin/users?page=2&per_page=2",
  ]);
  assert.equal(matches.get("acceptance-load-001@auth.meoing.com")?.id, "owned-load-user");
});

test("accepts only the canonical URL for the expected staging project ref", () => {
  assert.doesNotThrow(() =>
    assertExpectedStagingSupabaseProject({
      expectedProjectRef: STAGING_PROJECT_REF,
      supabaseUrl: SUPABASE_URL,
    }),
  );

  assert.throws(
    () =>
      assertExpectedStagingSupabaseProject({
        expectedProjectRef: "aaaaaaaaaaaaaaaaaaaa",
        supabaseUrl: SUPABASE_URL,
      }),
    /canonical URL/,
  );
  assert.throws(
    () =>
      assertExpectedStagingSupabaseProject({
        expectedProjectRef: STAGING_PROJECT_REF,
        supabaseUrl: new URL(`https://${STAGING_PROJECT_REF}.supabase.co.example/`),
      }),
    /canonical URL/,
  );
});

test("requires a valid expected project ref before any network request", async () => {
  let requests = 0;

  await assert.rejects(
    requireStagingProvisioningTargets({
      apiUrl: API_URL,
      expectedProjectRef: "PRODUCTION_PROJECT_REF",
      fetchImplementation: async () => {
        requests += 1;
        return Response.json({});
      },
      supabaseUrl: SUPABASE_URL,
    }),
    /20-character lowercase alphanumeric project ref/,
  );

  assert.equal(requests, 0);
});

test("requires staging liveness before readiness", async () => {
  const requestedPaths = [];
  const responses = [
    Response.json({
      data: {
        environment: "staging",
        status: "ok",
        supabaseProjectRef: STAGING_PROJECT_REF,
      },
    }),
    Response.json({
      data: {
        databaseEnvironment: "staging",
        databaseProjectRef: STAGING_PROJECT_REF,
        status: "ready",
      },
    }),
  ];

  await requireStagingProvisioningTargets({
    apiUrl: API_URL,
    expectedProjectRef: STAGING_PROJECT_REF,
    fetchImplementation: async (url) => {
      requestedPaths.push(url.pathname);
      return responses.shift();
    },
    supabaseUrl: SUPABASE_URL,
  });

  assert.deepEqual(requestedPaths, ["/health/live", "/health/ready"]);
});

test("rejects readiness from a Hyperdrive database with a different identity", async () => {
  const requestedPaths = [];
  const responses = [
    Response.json({
      data: {
        environment: "staging",
        status: "ok",
        supabaseProjectRef: STAGING_PROJECT_REF,
      },
    }),
    Response.json({
      data: {
        databaseEnvironment: "production",
        databaseProjectRef: "aaaaaaaaaaaaaaaaaaaa",
        status: "ready",
      },
    }),
  ];

  await assert.rejects(
    requireStagingProvisioningTargets({
      apiUrl: API_URL,
      expectedProjectRef: STAGING_PROJECT_REF,
      fetchImplementation: async (url) => {
        requestedPaths.push(url.pathname);
        return responses.shift();
      },
      supabaseUrl: SUPABASE_URL,
    }),
    /Staging API is not ready/,
  );

  assert.deepEqual(requestedPaths, ["/health/live", "/health/ready"]);
});

test("rejects a staging API bound to a different Supabase project", async () => {
  const requestedPaths = [];

  await assert.rejects(
    requireStagingProvisioningTargets({
      apiUrl: API_URL,
      expectedProjectRef: STAGING_PROJECT_REF,
      fetchImplementation: async (url) => {
        requestedPaths.push(url.pathname);
        return Response.json({
          data: {
            environment: "staging",
            status: "ok",
            supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa",
          },
        });
      },
      supabaseUrl: SUPABASE_URL,
    }),
    /expected staging Supabase project/,
  );

  assert.deepEqual(requestedPaths, ["/health/live"]);
});

test("rejects a production API before readiness or Auth Admin can run", async () => {
  const requestedPaths = [];

  await assert.rejects(
    requireStagingProvisioningTargets({
      apiUrl: API_URL,
      expectedProjectRef: STAGING_PROJECT_REF,
      fetchImplementation: async (url) => {
        requestedPaths.push(url.pathname);
        return Response.json({
          data: {
            environment: "production",
            status: "ok",
            supabaseProjectRef: STAGING_PROJECT_REF,
          },
        });
      },
      supabaseUrl: SUPABASE_URL,
    }),
    /did not identify the expected staging Supabase project/,
  );

  assert.deepEqual(requestedPaths, ["/health/live"]);
});
