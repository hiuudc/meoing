type LogLevel = "error" | "info" | "warn";

interface LogEvent {
  readonly event: string;
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly databaseDurationMs?: number;
  readonly queryCount?: number;
  readonly errorCode?: string;
  readonly databaseCode?: string;
  readonly errorMessage?: string;
  readonly errorName?: string;
  readonly environment?: string;
  readonly count?: number;
  readonly expiredRateLimitBuckets?: number;
  readonly expiredUsernameReservations?: number;
  readonly clearedProgressAnswers?: number;
  readonly deletedUnitRevisions?: number;
  readonly deletedAuditLogs?: number;
  readonly deletedUnits?: number;
  readonly expiredUploads?: number;
  readonly expiredAiOperations?: number;
  readonly dueCollections?: number;
  readonly dueAssets?: number;
  readonly r2DeleteCount?: number;
  readonly authDeleteCount?: number;
  readonly deletedCollections?: number;
  readonly purgedAssets?: number;
  readonly statsSamplePercent?: number;
  readonly estimatedGlobalStatsRows?: number;
  readonly estimatedCollectionStatsRows?: number;
  readonly sampledGlobalStatsRows?: number;
  readonly sampledCollectionStatsRows?: number;
  readonly globalStatsP95Bytes?: number;
  readonly collectionStatsP95Bytes?: number;
  readonly maxSampledStatsRowBytes?: number;
  readonly sampledStatsRowsOver256KiB?: number;
  readonly waitingLockCount?: number;
  readonly oldestWaitingQueryAgeMs?: number;
  readonly apiConnectionCount?: number;
  readonly maintenanceConnectionCount?: number;
}

export function log(level: LogLevel, data: LogEvent): void {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    ...data,
  };

  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}
