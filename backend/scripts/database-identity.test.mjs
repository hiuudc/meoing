import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHostedDatabaseIdentity,
  assertPinnedHostedDatabaseTarget,
  configureHostedDatabaseIdentity,
} from "./database-identity.mjs";

const PROJECT_REF = "abcdefghijklmnopqrst";

test("rejects invalid hosted identity before making a network request", async () => {
  let requests = 0;
  await assert.rejects(
    configureHostedDatabaseIdentity({
      accessToken: "token-with-sufficient-length",
      environment: "local",
      expectedProjectRef: PROJECT_REF,
      fetchImplementation: async () => {
        requests += 1;
        return Response.json([]);
      },
      projectRef: PROJECT_REF,
    }),
    /staging or production/,
  );
  assert.equal(requests, 0);
  assert.throws(
    () => assertHostedDatabaseIdentity({
      environment: "staging",
      projectRef: "not-a-project-ref",
    }),
    /20-character/,
  );
});

test("rejects target drift against the independently pinned project ref", async () => {
  assert.throws(
    () =>
      assertPinnedHostedDatabaseTarget({
        environment: "production",
        expectedProjectRef: "aaaaaaaaaaaaaaaaaaaa",
        projectRef: PROJECT_REF,
      }),
    /independently pinned/,
  );

  let requests = 0;
  await assert.rejects(
    configureHostedDatabaseIdentity({
      accessToken: "token-with-sufficient-length",
      environment: "staging",
      expectedProjectRef: "aaaaaaaaaaaaaaaaaaaa",
      fetchImplementation: async () => {
        requests += 1;
        return Response.json([]);
      },
      projectRef: PROJECT_REF,
    }),
    /independently pinned/,
  );
  assert.equal(requests, 0);
});

test("uses separate validated statements with the current Management API body", async () => {
  const requests = [];
  const responses = [
    Response.json([
      {
        identity: {
          environment: "staging",
          supabaseProjectRef: PROJECT_REF,
        },
      },
    ], { status: 201 }),
    Response.json([
      {
        identity: {
          environment: "staging",
          supabaseProjectRef: PROJECT_REF,
        },
      },
    ], { status: 201 }),
  ];
  await configureHostedDatabaseIdentity({
    accessToken: "token-with-sufficient-length",
    environment: "staging",
    expectedProjectRef: PROJECT_REF,
    fetchImplementation: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    },
    projectRef: PROJECT_REF,
  });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(
      request.url,
      `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    );
    assert.equal(request.init.method, "POST");
    assert.equal(
      new Headers(request.init.headers).get("authorization"),
      "Bearer token-with-sufficient-length",
    );
  }

  const configureBody = JSON.parse(requests[0].init.body);
  assert.deepEqual(Object.keys(configureBody), ["query"]);
  assert.match(configureBody.query, /on conflict \(singleton\) do update/i);
  assert.match(
    configureBody.query,
    /values \(true, 'staging'::text, 'abcdefghijklmnopqrst'::text\)/i,
  );
  assert.match(
    configureBody.query,
    /where identity\.environment = excluded\.environment/i,
  );
  assert.doesNotMatch(configureBody.query, /assert_database_identity/i);

  const verifyBody = JSON.parse(requests[1].init.body);
  assert.deepEqual(Object.keys(verifyBody), ["query"]);
  assert.match(
    verifyBody.query,
    /private\.assert_database_identity\(\s*'staging'::text,\s*'abcdefghijklmnopqrst'::text\s*\)/i,
  );
});

test("fails when the linked database has a different existing marker", async () => {
  let requests = 0;
  await assert.rejects(
    configureHostedDatabaseIdentity({
      accessToken: "token-with-sufficient-length",
      environment: "production",
      expectedProjectRef: PROJECT_REF,
      fetchImplementation: async () => {
        requests += 1;
        return Response.json([], { status: 201 });
      },
      projectRef: PROJECT_REF,
    }),
    /refused to insert or confirm/,
  );
  assert.equal(requests, 1);
});

test("fails closed when the post-commit assertion does not return the exact identity", async () => {
  let requests = 0;
  await assert.rejects(
    configureHostedDatabaseIdentity({
      accessToken: "token-with-sufficient-length",
      environment: "staging",
      expectedProjectRef: PROJECT_REF,
      fetchImplementation: async () => {
        requests += 1;
        if (requests === 1) {
          return Response.json([
            {
              identity: {
                environment: "staging",
                supabaseProjectRef: PROJECT_REF,
              },
            },
          ], { status: 201 });
        }
        return Response.json([
          {
            identity: {
              environment: "production",
              supabaseProjectRef: PROJECT_REF,
            },
          },
        ], { status: 201 });
      },
      projectRef: PROJECT_REF,
    }),
    /failed to verify/,
  );
  assert.equal(requests, 2);
});

test("rejects ambiguous identity responses", async () => {
  await assert.rejects(
    configureHostedDatabaseIdentity({
      accessToken: "token-with-sufficient-length",
      environment: "staging",
      expectedProjectRef: PROJECT_REF,
      fetchImplementation: async () =>
        Response.json([
          {
            identity: {
              environment: "staging",
              supabaseProjectRef: PROJECT_REF,
            },
          },
          {
            identity: {
              environment: "staging",
              supabaseProjectRef: PROJECT_REF,
            },
          },
        ], { status: 201 }),
      projectRef: PROJECT_REF,
    }),
    /refused to insert or confirm/,
  );
});

test("reports only the HTTP status when the Management API rejects the request", async () => {
  const token = "token-that-must-never-appear";
  await assert.rejects(
    configureHostedDatabaseIdentity({
      accessToken: token,
      environment: "staging",
      expectedProjectRef: PROJECT_REF,
      fetchImplementation: async () =>
        Response.json({ message: `sensitive ${token}` }, { status: 403 }),
      projectRef: PROJECT_REF,
    }),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    },
  );
});
