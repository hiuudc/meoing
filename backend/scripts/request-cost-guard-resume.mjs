import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const RESUME_RATIO = 0.05;

const CLASS_A_ACTIONS = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);
const CLASS_B_ACTIONS = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);
const FREE_ACTIONS = new Set([
  "DeleteObject",
  "DeleteBucket",
  "AbortMultipartUpload",
]);

const QUERY = `
  query CostGuardResumeMetrics(
    $accountTag: string!
    $workerStart: string!
    $workerEnd: string!
    $r2Start: Time!
    $r2End: Time!
    $storageStart: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 1
          filter: { datetime_geq: $workerStart, datetime_leq: $workerEnd }
        ) { sum { requests cpuTimeUs } }
        r2OperationsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $r2Start, datetime_leq: $r2End }
        ) { dimensions { actionType } sum { requests } }
        r2StorageAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $storageStart, datetime_leq: $r2End }
          orderBy: [datetime_DESC]
        ) {
          dimensions { bucketName datetime }
          max { payloadSize metadataSize }
        }
      }
    }
  }
`;

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function positiveEnvironment(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return value;
}

function assertNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid metric ${path}`);
  }
  return value;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function parseMetrics(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error("Cloudflare GraphQL returned errors");
  }
  const accounts = payload?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error("Cloudflare GraphQL did not return exactly one account");
  }
  const account = accounts[0];
  const workerRows = account?.workersInvocationsAdaptive;
  if (!Array.isArray(workerRows) || workerRows.length > 1) {
    throw new Error("Invalid Workers metrics response");
  }
  const worker = workerRows[0]?.sum ?? { requests: 0, cpuTimeUs: 0 };

  let classA = 0;
  let classB = 0;
  if (!Array.isArray(account?.r2OperationsAdaptiveGroups)) {
    throw new Error("Invalid R2 operations response");
  }
  for (const row of account.r2OperationsAdaptiveGroups) {
    const action = row?.dimensions?.actionType;
    const requests = assertNumber(row?.sum?.requests, "R2 requests");
    if (CLASS_A_ACTIONS.has(action)) classA += requests;
    else if (CLASS_B_ACTIONS.has(action)) classB += requests;
    else if (!FREE_ACTIONS.has(action)) throw new Error(`Unknown R2 action: ${action}`);
  }

  if (!Array.isArray(account?.r2StorageAdaptiveGroups)) {
    throw new Error("Invalid R2 storage response");
  }
  const latestByBucket = new Map();
  for (const row of account.r2StorageAdaptiveGroups) {
    const bucket = row?.dimensions?.bucketName;
    if (typeof bucket !== "string" || bucket.length === 0) {
      throw new Error("Invalid R2 bucket name");
    }
    if (!latestByBucket.has(bucket)) {
      latestByBucket.set(
        bucket,
        assertNumber(row?.max?.payloadSize, "R2 payload size") +
          assertNumber(row?.max?.metadataSize, "R2 metadata size"),
      );
    }
  }

  return {
    workerRequests: assertNumber(worker.requests, "Worker requests"),
    workerCpuMs: assertNumber(worker.cpuTimeUs, "Worker CPU") / 1_000,
    r2ClassAOperations: classA,
    r2ClassBOperations: classB,
    r2StorageBytes: [...latestByBucket.values()].reduce(
      (total, value) => total + value,
      0,
    ),
  };
}

async function main() {
  const statePath = resolve(argument("--state"));
  const outputPath = resolve(argument("--output"));
  const environment = requiredEnvironment("COST_GUARD_ENVIRONMENT");
  const workflowRunId = requiredEnvironment("GITHUB_RUN_ID");
  if (!/^[1-9][0-9]{0,19}$/.test(workflowRunId)) {
    throw new Error("GITHUB_RUN_ID is invalid");
  }
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredEnvironment("CLOUDFLARE_COST_GUARD_RESUME_TOKEN");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (
    state?.version !== 1 ||
    state?.status !== "STOPPED" ||
    state?.environment !== environment ||
    !isCanonicalTimestamp(state?.cycleStart) ||
    !isCanonicalTimestamp(state?.stoppedAt) ||
    (state?.resumeClaim ?? null) !== null ||
    !Array.isArray(state?.detachedDomains) ||
    state.detachedDomains.length === 0
  ) {
    throw new Error("R2 state is not resumable for the selected environment");
  }

  const measuredAt = new Date().toISOString();
  if (Date.parse(measuredAt) <= Date.parse(state.stoppedAt)) {
    throw new Error("STOPPED state timestamp is not before this resume request");
  }
  const storageStart = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        accountTag: accountId,
        workerStart: state.cycleStart,
        workerEnd: measuredAt,
        r2Start: state.cycleStart,
        r2End: measuredAt,
        storageStart,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare GraphQL returned HTTP ${response.status}`);
  }
  const metrics = parseMetrics(await response.json());
  const limits = {
    workerRequests: positiveEnvironment("WORKERS_REQUEST_GUARD_LIMIT", 1_350_000),
    workerCpuMs: positiveEnvironment("WORKERS_INCLUDED_CPU_MS", 30_000_000),
    r2ClassAOperations: positiveEnvironment(
      "R2_INCLUDED_CLASS_A_OPERATIONS",
      1_000_000,
    ),
    r2ClassBOperations: positiveEnvironment(
      "R2_INCLUDED_CLASS_B_OPERATIONS",
      10_000_000,
    ),
    r2StorageBytes: positiveEnvironment("R2_INCLUDED_STORAGE_BYTES", 10_000_000_000),
  };
  const ratios = Object.fromEntries(
    Object.entries(metrics).map(([name, value]) => [name, value / limits[name]]),
  );
  const maxRatio = Math.max(...Object.values(ratios));
  if (!(maxRatio < RESUME_RATIO)) {
    throw new Error(
      `Resume denied: highest account usage is ${(maxRatio * 100).toFixed(2)}%, not below 5%`,
    );
  }

  const request = {
    version: 1,
    environment,
    cycleStart: state.cycleStart,
    stoppedAt: state.stoppedAt,
    requestedAt: measuredAt,
    workflowRunId,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `Resume request prepared for ${environment}; highest usage ${(maxRatio * 100).toFixed(2)}%.\n`,
  );
}

await main();
