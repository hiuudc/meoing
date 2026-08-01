import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COST_GUARD_BUCKETS,
  COST_GUARD_RESUME_REQUEST_KEY,
  COST_GUARD_STATE_KEY,
  MAX_COST_GUARD_OBJECT_BYTES,
  costGuardBucketForEnvironment,
  createCostGuardResumeR2Client,
  runCostGuardResumeR2Cli,
} from "./cost-guard-resume-r2.mjs";

const ACCOUNT_ID = "29e80074abc5eb106165d2349db7ca56";
const ACCESS_KEY_ID = "test-access-key-id";
const SECRET_ACCESS_KEY = "test-secret-access-key";

function client(environment, fetchImplementation, extra = {}) {
  return createCostGuardResumeR2Client({
    accessKeyId: ACCESS_KEY_ID,
    accountId: ACCOUNT_ID,
    environment,
    fetchImplementation,
    secretAccessKey: SECRET_ACCESS_KEY,
    ...extra,
  });
}

function expectedUrl(bucket, key) {
  return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

function assertSignedS3Request(request, method, bucket, key) {
  assert.ok(request instanceof Request);
  assert.equal(request.method, method);
  assert.equal(request.url, expectedUrl(bucket, key));
  assert.match(
    request.headers.get("authorization") ?? "",
    /^AWS4-HMAC-SHA256 Credential=/,
  );
  assert.match(
    request.headers.get("x-amz-content-sha256") ?? "",
    /^(?:UNSIGNED-PAYLOAD|[0-9a-f]{64})$/,
  );
}

test("maps only the two deployment environments to fixed Cost Guard buckets", () => {
  assert.deepEqual(COST_GUARD_BUCKETS, {
    production: "meoing-cost-guard-production",
    staging: "meoing-cost-guard-staging",
  });
  assert.equal(
    costGuardBucketForEnvironment("staging"),
    "meoing-cost-guard-staging",
  );
  assert.equal(
    costGuardBucketForEnvironment("production"),
    "meoing-cost-guard-production",
  );
  for (const invalid of [undefined, "", "Staging", "preview", "production "]) {
    assert.throws(
      () => costGuardBucketForEnvironment(invalid),
      /must be exactly staging or production/,
    );
  }
});

test("downloads only the fixed state key with bucket-scoped S3 signing", async () => {
  let calls = 0;
  const value = '{"state":"STOPPED"}';
  const r2 = client("staging", async (request, init) => {
    calls += 1;
    assertSignedS3Request(
      request,
      "GET",
      "meoing-cost-guard-staging",
      COST_GUARD_STATE_KEY,
    );
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(value, {
      headers: { "content-length": String(Buffer.byteLength(value)) },
      status: 200,
    });
  }, {
    bucket: "meoing-files-staging",
    endpoint: "https://attacker.invalid",
    key: "other/object",
  });

  const result = await r2.downloadState();
  assert.equal(new TextDecoder().decode(result), value);
  assert.equal(r2.bucket, "meoing-cost-guard-staging");
  assert.equal(calls, 1);
});

test("uploads only the fixed resume-request key to the production bucket", async () => {
  let calls = 0;
  const value = new TextEncoder().encode('{"requested":true}');
  const r2 = client("production", async (request, init) => {
    calls += 1;
    assertSignedS3Request(
      request,
      "PUT",
      "meoing-cost-guard-production",
      COST_GUARD_RESUME_REQUEST_KEY,
    );
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.deepEqual(
      new Uint8Array(await request.clone().arrayBuffer()),
      value,
    );
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(null, { status: 204 });
  });

  await r2.uploadResumeRequest(value);
  assert.equal(r2.bucket, "meoing-cost-guard-production");
  assert.equal(calls, 1);
});

test("rejects an invalid environment before any network access", () => {
  let calls = 0;
  assert.throws(
    () => client("preview", async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }),
    /must be exactly staging or production/,
  );
  assert.equal(calls, 0);
});

test("rejects invalid identity, credentials, and timeout before network access", () => {
  let calls = 0;
  const fetchImplementation = async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  };
  for (const override of [
    { accountId: "not-an-account" },
    { accessKeyId: "" },
    { secretAccessKey: "" },
    { requestTimeoutMilliseconds: 60_001 },
  ]) {
    assert.throws(
      () => client("staging", fetchImplementation, override),
      /account ID|is required|between 1 and 60000/,
    );
  }
  assert.equal(calls, 0);
});

test("fails closed on R2 authorization errors without a REST fallback", async () => {
  let calls = 0;
  const r2 = client("staging", async (request) => {
    calls += 1;
    assertSignedS3Request(
      request,
      "GET",
      "meoing-cost-guard-staging",
      COST_GUARD_STATE_KEY,
    );
    return new Response("denied", { status: 403 });
  });

  await assert.rejects(
    r2.downloadState(),
    /state download failed with HTTP 403/,
  );
  assert.equal(calls, 1);
});

test("enforces the 64 KiB upload and download bounds", async () => {
  let uploadCalls = 0;
  const uploader = client("staging", async () => {
    uploadCalls += 1;
    return new Response(null, { status: 204 });
  });
  await uploader.uploadResumeRequest(
    new Uint8Array(MAX_COST_GUARD_OBJECT_BYTES),
  );
  await assert.rejects(
    uploader.uploadResumeRequest(
      new Uint8Array(MAX_COST_GUARD_OBJECT_BYTES + 1),
    ),
    /Resume request must contain between 1 and/,
  );
  await assert.rejects(
    uploader.uploadResumeRequest(new Uint8Array()),
    /Resume request must contain between 1 and/,
  );
  assert.equal(uploadCalls, 1);

  const declaredTooLarge = client("production", async () =>
    new Response("small", {
      headers: {
        "content-length": String(MAX_COST_GUARD_OBJECT_BYTES + 1),
      },
      status: 200,
    }));
  await assert.rejects(declaredTooLarge.downloadState(), /R2 object exceeds/);

  const streamedTooLarge = client("production", async () =>
    new Response(new Uint8Array(MAX_COST_GUARD_OBJECT_BYTES + 1), {
      status: 200,
    }));
  await assert.rejects(streamedTooLarge.downloadState(), /R2 object exceeds/);

  const empty = client("production", async () =>
    new Response(null, { status: 200 }));
  await assert.rejects(empty.downloadState(), /empty object body/);
});

test("CLI writes downloaded state privately and uploads a bounded local request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meoing-cost-guard-r2-"));
  const statePath = join(directory, "state", "state.json");
  const requestPath = join(directory, "resume-request.json");
  const environment = {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    COST_GUARD_ENVIRONMENT: "staging",
    R2_COST_GUARD_ACCESS_KEY_ID: ACCESS_KEY_ID,
    R2_COST_GUARD_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
  };

  await runCostGuardResumeR2Cli(
    ["download-state", "--output", statePath],
    {
      env: environment,
      fetchImplementation: async (request) => {
        assertSignedS3Request(
          request,
          "GET",
          "meoing-cost-guard-staging",
          COST_GUARD_STATE_KEY,
        );
        return new Response('{"state":"STOPPED"}', { status: 200 });
      },
    },
  );
  assert.equal(await readFile(statePath, "utf8"), '{"state":"STOPPED"}');
  if (process.platform !== "win32") {
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  }

  await writeFile(requestPath, '{"requestId":"fixed"}');
  await runCostGuardResumeR2Cli(
    ["upload-request", "--input", requestPath],
    {
      env: environment,
      fetchImplementation: async (request) => {
        assertSignedS3Request(
          request,
          "PUT",
          "meoing-cost-guard-staging",
          COST_GUARD_RESUME_REQUEST_KEY,
        );
        assert.equal(await request.clone().text(), '{"requestId":"fixed"}');
        return new Response(null, { status: 200 });
      },
    },
  );
});

test("CLI rejects alternate arguments and oversized input before network access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meoing-cost-guard-r2-"));
  const requestPath = join(directory, "oversized.json");
  await writeFile(requestPath, Buffer.alloc(MAX_COST_GUARD_OBJECT_BYTES + 1));
  const environment = {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    COST_GUARD_ENVIRONMENT: "production",
    R2_COST_GUARD_ACCESS_KEY_ID: ACCESS_KEY_ID,
    R2_COST_GUARD_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
  };
  let calls = 0;
  const fetchImplementation = async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  };

  await assert.rejects(
    runCostGuardResumeR2Cli(
      ["download-state", "--bucket", "meoing-files-production"],
      { env: environment, fetchImplementation },
    ),
    /Usage:/,
  );
  await assert.rejects(
    runCostGuardResumeR2Cli(
      ["upload-request", "--input", requestPath],
      { env: environment, fetchImplementation },
    ),
    /Resume request must contain between 1 and/,
  );
  assert.equal(calls, 0);
});
