import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

export const MAX_COST_GUARD_OBJECT_BYTES = 64 * 1024;
export const COST_GUARD_STATE_KEY = "cost-guard/state.json";
export const COST_GUARD_RESUME_REQUEST_KEY =
  "cost-guard/resume-request.json";
export const COST_GUARD_BUCKETS = Object.freeze({
  production: "meoing-cost-guard-production",
  staging: "meoing-cost-guard-staging",
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function costGuardBucketForEnvironment(environment) {
  assert(
    Object.hasOwn(COST_GUARD_BUCKETS, environment),
    "COST_GUARD_ENVIRONMENT must be exactly staging or production",
  );
  return COST_GUARD_BUCKETS[environment];
}

function assertCredential(value, name) {
  assert(
    typeof value === "string" && value.trim().length > 0,
    `${name} is required`,
  );
}

function objectUrl({ accountId, bucket, key }) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return new URL(
    `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encodedKey}`,
  );
}

async function readBoundedResponseBody(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    assert(
      Number.isSafeInteger(parsedLength) && parsedLength >= 0,
      "R2 returned an invalid Content-Length",
    );
    assert(
      parsedLength <= MAX_COST_GUARD_OBJECT_BYTES,
      `R2 object exceeds the ${MAX_COST_GUARD_OBJECT_BYTES}-byte limit`,
    );
  }

  assert(response.body !== null, "R2 returned an empty object body");

  const reader = response.body.getReader();
  const chunks = [];
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLength += value.byteLength;
      if (totalLength > MAX_COST_GUARD_OBJECT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `R2 object exceeds the ${MAX_COST_GUARD_OBJECT_BYTES}-byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assert(result.byteLength > 0, "R2 returned an empty object body");
  return result;
}

function assertBoundedBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  assert(
    bytes.byteLength > 0 && bytes.byteLength <= MAX_COST_GUARD_OBJECT_BYTES,
    `Resume request must contain between 1 and ${MAX_COST_GUARD_OBJECT_BYTES} bytes`,
  );
  return bytes;
}

export function createCostGuardResumeR2Client({
  accessKeyId,
  accountId,
  environment,
  fetchImplementation = fetch,
  requestTimeoutMilliseconds = 20_000,
  secretAccessKey,
}) {
  assert(
    typeof accountId === "string" && ACCOUNT_ID_PATTERN.test(accountId),
    "CLOUDFLARE_ACCOUNT_ID must be a lowercase 32-character Cloudflare account ID",
  );
  assertCredential(accessKeyId, "R2_COST_GUARD_ACCESS_KEY_ID");
  assertCredential(secretAccessKey, "R2_COST_GUARD_SECRET_ACCESS_KEY");
  assert(
    typeof fetchImplementation === "function",
    "A fetch implementation is required",
  );
  assert(
    Number.isSafeInteger(requestTimeoutMilliseconds) &&
      requestTimeoutMilliseconds > 0 &&
      requestTimeoutMilliseconds <= 60_000,
    "requestTimeoutMilliseconds must be between 1 and 60000",
  );

  const bucket = costGuardBucketForEnvironment(environment);
  const signer = new AwsClient({
    accessKeyId,
    secretAccessKey,
    region: "auto",
    service: "s3",
    retries: 0,
  });

  async function request(key, init) {
    const signed = await signer.sign(objectUrl({ accountId, bucket, key }), {
      ...init,
      aws: { allHeaders: true },
    });
    return fetchImplementation(signed, {
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    });
  }

  return Object.freeze({
    bucket,
    async downloadState() {
      const response = await request(COST_GUARD_STATE_KEY, { method: "GET" });
      assert(
        response.ok,
        `Cost Guard state download failed with HTTP ${response.status}`,
      );
      return readBoundedResponseBody(response);
    },
    async uploadResumeRequest(value) {
      const body = assertBoundedBytes(value);
      const response = await request(COST_GUARD_RESUME_REQUEST_KEY, {
        body,
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      assert(
        response.ok,
        `Cost Guard resume request upload failed with HTTP ${response.status}`,
      );
    },
  });
}

async function readBoundedFile(path) {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    assert(metadata.isFile(), "Resume request input must be a regular file");
    assert(
      metadata.size > 0 && metadata.size <= MAX_COST_GUARD_OBJECT_BYTES,
      `Resume request must contain between 1 and ${MAX_COST_GUARD_OBJECT_BYTES} bytes`,
    );
    const contents = await file.readFile();
    return assertBoundedBytes(contents);
  } finally {
    await file.close();
  }
}

async function writePrivateFile(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "w", 0o600);
  try {
    await file.writeFile(contents);
  } finally {
    await file.close();
  }
  await chmod(path, 0o600);
}

function parseCommand(argv) {
  assert(
    Array.isArray(argv) && argv.length === 3,
    "Usage: cost-guard-resume-r2.mjs download-state --output <path> | upload-request --input <path>",
  );
  const [command, option, path] = argv;
  assert(
    typeof path === "string" && path.length > 0,
    "A non-empty local file path is required",
  );
  if (command === "download-state" && option === "--output") {
    return { command, path };
  }
  if (command === "upload-request" && option === "--input") {
    return { command, path };
  }
  throw new Error(
    "Usage: cost-guard-resume-r2.mjs download-state --output <path> | upload-request --input <path>",
  );
}

export async function runCostGuardResumeR2Cli(
  argv,
  { env = process.env, fetchImplementation = fetch } = {},
) {
  const operation = parseCommand(argv);
  const client = createCostGuardResumeR2Client({
    accessKeyId: env.R2_COST_GUARD_ACCESS_KEY_ID,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    environment: env.COST_GUARD_ENVIRONMENT,
    fetchImplementation,
    secretAccessKey: env.R2_COST_GUARD_SECRET_ACCESS_KEY,
  });

  if (operation.command === "download-state") {
    await writePrivateFile(operation.path, await client.downloadState());
    return;
  }

  await client.uploadResumeRequest(await readBoundedFile(operation.path));
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  runCostGuardResumeR2Cli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
