import type { MaintenanceRepository } from "./db/maintenance-repository";
import { log } from "./observability";
import type { JsonObject, JsonValue } from "./types";

export type MaintenanceFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

async function verifyAuthAdminAccess(
  env: MaintenanceEnv,
  fetcher: MaintenanceFetch,
): Promise<void> {
  if (
    env.APP_ENV !== "local" &&
    (typeof env.SUPABASE_SECRET_KEY !== "string" ||
      !env.SUPABASE_SECRET_KEY.startsWith("sb_secret_"))
  ) {
    throw new Error("Supabase Auth Admin secret is not a dedicated secret key");
  }

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
  const response = await fetcher(`${baseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
    headers: {
      accept: "application/json",
      apikey: env.SUPABASE_SECRET_KEY,
    },
  });
  if (!response.ok) {
    throw new Error("Supabase Auth Admin canary failed");
  }
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function deleteAuthUsers(
  env: MaintenanceEnv,
  userIds: readonly string[],
  fetcher: MaintenanceFetch,
): Promise<void> {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
  for (let offset = 0; offset < userIds.length; offset += 10) {
    const batch = userIds.slice(offset, offset + 10);
    const responses = await Promise.all(
      batch.map((userId) =>
        fetcher(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: "DELETE",
          headers: {
            apikey: env.SUPABASE_SECRET_KEY,
          },
        }),
      ),
    );
    if (responses.some((response) => !response.ok && response.status !== 404)) {
      throw new Error("One or more Supabase Auth deletions failed");
    }
  }
}

export async function runMaintenance(
  env: MaintenanceEnv,
  repository: MaintenanceRepository,
  fetcher: MaintenanceFetch = fetch,
): Promise<JsonObject> {
  await verifyAuthAdminAccess(env, fetcher);

  const result = await repository.cleanup({
    batchSize: 500,
    now: new Date().toISOString(),
  });
  const aiOperationCleanup = repository.cleanupAiOperations
    ? await repository.cleanupAiOperations({ batchSize: 500 })
    : {};
  const r2Keys = stringArray(result.r2Keys);
  const authUserIds = stringArray(result.authUserIds);
  const dueCollectionIds = stringArray(result.dueCollectionIds);
  const dueAssetIds = stringArray(result.dueAssetIds);

  if (r2Keys.length > 0) {
    await env.FILES.delete(r2Keys);
  }
  if (authUserIds.length > 0) {
    await deleteAuthUsers(env, authUserIds, fetcher);
  }
  const finalized = dueCollectionIds.length > 0 || dueAssetIds.length > 0 || authUserIds.length > 0
    ? await repository.finalize({
        collectionIds: dueCollectionIds,
        assetIds: dueAssetIds,
        authUserIds,
      })
    : {};
  const finalizedAuthUserIds = stringArray(finalized.authUserIds);

  log("info", {
    authDeleteCount: finalizedAuthUserIds.length,
    clearedProgressAnswers: numberValue(result.clearedProgressAnswers),
    count: r2Keys.length + finalizedAuthUserIds.length,
    deletedAuditLogs: numberValue(result.deletedAuditLogs),
    deletedCollections: numberValue(finalized.deletedCollections),
    deletedUnitRevisions: numberValue(result.deletedUnitRevisions),
    deletedUnits: numberValue(result.deletedUnits),
    dueAssets: numberValue(result.dueAssets),
    dueCollections: numberValue(result.dueCollections),
    environment: env.APP_ENV,
    event: "maintenance_complete",
    expiredRateLimitBuckets: numberValue(result.expiredRateLimitBuckets),
    expiredUploads: numberValue(result.expiredUploads),
    expiredAiOperations: numberValue(aiOperationCleanup.expiredAiOperations),
    expiredUsernameReservations: numberValue(result.expiredUsernameReservations),
    purgedAssets: numberValue(finalized.purgedAssets),
    r2DeleteCount: r2Keys.length,
  });

  let observation: JsonObject = {};
  if (repository.observe) {
    try {
      observation = await repository.observe();
      log("info", {
        apiConnectionCount: numberValue(observation.apiConnectionCount),
        collectionStatsP95Bytes: numberValue(observation.collectionStatsP95Bytes),
        environment: env.APP_ENV,
        estimatedCollectionStatsRows: numberValue(observation.estimatedCollectionStatsRows),
        estimatedGlobalStatsRows: numberValue(observation.estimatedGlobalStatsRows),
        event: "maintenance_observation",
        globalStatsP95Bytes: numberValue(observation.globalStatsP95Bytes),
        maintenanceConnectionCount: numberValue(observation.maintenanceConnectionCount),
        maxSampledStatsRowBytes: numberValue(observation.maxSampledStatsRowBytes),
        oldestWaitingQueryAgeMs: numberValue(observation.oldestWaitingQueryAgeMs),
        sampledCollectionStatsRows: numberValue(observation.sampledCollectionStatsRows),
        sampledGlobalStatsRows: numberValue(observation.sampledGlobalStatsRows),
        sampledStatsRowsOver256KiB: numberValue(observation.sampledStatsRowsOver256KiB),
        statsSamplePercent: numberValue(observation.statsSamplePercent),
        waitingLockCount: numberValue(observation.waitingLockCount),
      });
    } catch (error) {
      log("warn", {
        environment: env.APP_ENV,
        errorName: error instanceof Error ? error.name : "UnknownError",
        event: "maintenance_observation_failed",
      });
    }
  }

  return { ...result, aiOperationCleanup, finalized, observation };
}
