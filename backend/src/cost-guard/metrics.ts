import type { CostGuardMetrics } from "./model";

export const COST_GUARD_METRICS_QUERY = `
  query CostGuardMetrics(
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
        ) {
          sum { requests cpuTimeUs }
        }
        r2OperationsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $r2Start, datetime_leq: $r2End }
        ) {
          dimensions { actionType }
          sum { requests }
        }
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

type UnknownRecord = Record<string, unknown>;

function object(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid GraphQL object at ${path}`);
  }
  return value as UnknownRecord;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid GraphQL array at ${path}`);
  return value;
}

function nonnegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid GraphQL number at ${path}`);
  }
  return value;
}

export function classifyR2Action(actionType: string): "A" | "B" | "FREE" {
  if (CLASS_A_ACTIONS.has(actionType)) return "A";
  if (CLASS_B_ACTIONS.has(actionType)) return "B";
  if (FREE_ACTIONS.has(actionType)) return "FREE";
  throw new Error(`Unknown R2 action type: ${actionType}`);
}

export function parseMetricsPayload(payload: unknown): CostGuardMetrics {
  const root = object(payload, "root");
  const data = object(root.data, "data");
  const viewer = object(data.viewer, "data.viewer");
  const accounts = array(viewer.accounts, "data.viewer.accounts");
  if (accounts.length !== 1) {
    throw new Error("GraphQL account query must return exactly one account");
  }
  const account = object(accounts[0], "data.viewer.accounts[0]");

  const workerRows = array(
    account.workersInvocationsAdaptive,
    "workersInvocationsAdaptive",
  );
  if (workerRows.length > 1) {
    throw new Error("Workers metrics unexpectedly returned more than one aggregate row");
  }
  const workerSum =
    workerRows.length === 0
      ? { requests: 0, cpuTimeUs: 0 }
      : object(object(workerRows[0], "worker row").sum, "worker sum");

  let r2ClassAOperations = 0;
  let r2ClassBOperations = 0;
  for (const [index, rawRow] of array(
    account.r2OperationsAdaptiveGroups,
    "r2OperationsAdaptiveGroups",
  ).entries()) {
    const row = object(rawRow, `R2 operation row ${index}`);
    const dimensions = object(row.dimensions, `R2 operation dimensions ${index}`);
    const sum = object(row.sum, `R2 operation sum ${index}`);
    if (typeof dimensions.actionType !== "string") {
      throw new Error(`Invalid R2 action type at row ${index}`);
    }
    const requests = nonnegativeNumber(sum.requests, `R2 operation requests ${index}`);
    const actionClass = classifyR2Action(dimensions.actionType);
    if (actionClass === "A") r2ClassAOperations += requests;
    if (actionClass === "B") r2ClassBOperations += requests;
  }

  const latestStorageByBucket = new Map<string, number>();
  for (const [index, rawRow] of array(
    account.r2StorageAdaptiveGroups,
    "r2StorageAdaptiveGroups",
  ).entries()) {
    const row = object(rawRow, `R2 storage row ${index}`);
    const dimensions = object(row.dimensions, `R2 storage dimensions ${index}`);
    const maximum = object(row.max, `R2 storage max ${index}`);
    if (typeof dimensions.bucketName !== "string" || dimensions.bucketName.length === 0) {
      throw new Error(`Invalid R2 bucket name at row ${index}`);
    }
    // Results are datetime_DESC, so the first sample for each bucket is current.
    if (!latestStorageByBucket.has(dimensions.bucketName)) {
      latestStorageByBucket.set(
        dimensions.bucketName,
        nonnegativeNumber(maximum.payloadSize, `R2 payload size ${index}`) +
          nonnegativeNumber(maximum.metadataSize, `R2 metadata size ${index}`),
      );
    }
  }

  return {
    workerRequests: nonnegativeNumber(workerSum.requests, "worker requests"),
    workerCpuMs: nonnegativeNumber(workerSum.cpuTimeUs, "worker cpuTimeUs") / 1_000,
    r2ClassAOperations,
    r2ClassBOperations,
    r2StorageBytes: [...latestStorageByBucket.values()].reduce(
      (total, bytes) => total + bytes,
      0,
    ),
  };
}

export async function queryAccountMetrics(input: {
  fetcher: typeof fetch;
  accountId: string;
  apiToken: string;
  cycleStart: string;
  measuredAt: string;
}): Promise<CostGuardMetrics> {
  const measuredAtMs = new Date(input.measuredAt).getTime();
  const storageStart = new Date(measuredAtMs - 2 * 60 * 60 * 1_000).toISOString();
  const response = await input.fetcher("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: COST_GUARD_METRICS_QUERY,
      variables: {
        accountTag: input.accountId,
        workerStart: input.cycleStart,
        workerEnd: input.measuredAt,
        r2Start: input.cycleStart,
        r2End: input.measuredAt,
        storageStart,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare GraphQL returned HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  const root = object(payload, "root");
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw new Error("Cloudflare GraphQL returned errors");
  }
  return parseMetricsPayload(payload);
}
