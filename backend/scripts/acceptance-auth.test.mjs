import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceAuthRetryDelay,
  acquirePasswordAccessTokens,
  retryAfterMilliseconds,
} from "./acceptance-auth.mjs";

test("parses Retry-After seconds and HTTP dates", () => {
  assert.equal(retryAfterMilliseconds("2.5", 0), 2_500);
  assert.equal(
    retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:05 GMT", 1_000),
    4_000,
  );
  assert.equal(retryAfterMilliseconds("invalid", 0), null);
});

test("uses bounded exponential backoff with jitter and honors Retry-After", () => {
  assert.equal(acceptanceAuthRetryDelay({ attempt: 3, random: () => 0 }), 4_000);
  assert.equal(
    acceptanceAuthRetryDelay({
      attempt: 1,
      random: () => 0,
      retryAfter: "3",
    }),
    3_000,
  );
  assert.equal(
    acceptanceAuthRetryDelay({
      attempt: 1,
      retryAfter: "61",
    }),
    null,
  );
});

test("paces token requests and retries a 429 without exposing user credentials", async () => {
  let nowMilliseconds = 0;
  const requestStartedAt = [];
  const retryEvents = [];
  const responses = [
    new Response("{}", {
      status: 429,
      headers: { "retry-after": "3" },
    }),
    Response.json({ access_token: "token-one" }),
    Response.json({ access_token: "token-two" }),
  ];

  const tokens = await acquirePasswordAccessTokens({
    fetchImplementation: async () => {
      requestStartedAt.push(nowMilliseconds);
      return responses.shift();
    },
    now: () => nowMilliseconds,
    onRetry: (event) => retryEvents.push(event),
    passwordUsers: [
      { email: "first@example.com", password: "not-logged-one" },
      { email: "second@example.com", password: "not-logged-two" },
    ],
    publishableKey: "sb_publishable_test",
    random: () => 0,
    requestIntervalMilliseconds: 2_100,
    supabaseUrl: new URL("https://example.supabase.co/"),
    wait: async (milliseconds) => {
      nowMilliseconds += milliseconds;
    },
  });

  assert.deepEqual(tokens, ["token-one", "token-two"]);
  assert.deepEqual(requestStartedAt, [0, 3_000, 5_100]);
  assert.deepEqual(retryEvents, [
    { attempt: 1, delayMilliseconds: 3_000, maximumAttempts: 8 },
  ]);
});

test("does not retry invalid credentials", async () => {
  let requests = 0;
  await assert.rejects(
    acquirePasswordAccessTokens({
      fetchImplementation: async () => {
        requests += 1;
        return new Response("{}", { status: 400 });
      },
      passwordUsers: [
        { email: "invalid@example.com", password: "not-logged" },
      ],
      publishableKey: "sb_publishable_test",
      supabaseUrl: new URL("https://example.supabase.co/"),
    }),
    /HTTP 400/,
  );
  assert.equal(requests, 1);
});
