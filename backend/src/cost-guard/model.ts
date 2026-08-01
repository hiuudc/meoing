export const COST_GUARD_STATE_KEY = "cost-guard/state.json";
export const COST_GUARD_RESUME_REQUEST_KEY = "cost-guard/resume-request.json";

export const WARNING_RATIO = 0.8;
export const STOP_RATIO = 0.95;
export const RESUME_RATIO = 0.05;
export const METRIC_FAILURES_BEFORE_STOP = 3;
export const RESUME_REQUEST_MAX_AGE_MS = 15 * 60 * 1_000;
export const RESUME_CLAIM_LEASE_MS = 4 * 60 * 1_000;

export type CostGuardStatus = "NORMAL" | "WARNING" | "STOPPED";

export type CostMetricName =
  | "workerRequests"
  | "workerCpuMs"
  | "r2ClassAOperations"
  | "r2ClassBOperations"
  | "r2StorageBytes";

export type CostGuardMetrics = Record<CostMetricName, number>;
export type CostGuardLimits = Record<CostMetricName, number>;

export interface BillingCycle {
  start: string;
  end: string;
}

export interface ProtectedDomain {
  hostname: string;
  service: string;
}

export interface DetachedDomain extends ProtectedDomain {
  domainId: string;
  zoneId: string;
  zoneName: string;
}

export interface UsageSnapshot {
  measuredAt: string;
  values: CostGuardMetrics;
  ratios: Record<CostMetricName, number>;
  maxMetric: CostMetricName;
  maxRatio: number;
}

export type StopReason =
  | "usage_threshold"
  | "metrics_unavailable"
  | "manual_resume_required"
  | null;

export type WarningReason = "usage_threshold" | "metrics_unavailable";

export interface CostGuardState {
  version: 1;
  environment: string;
  cycleStart: string;
  cycleEnd: string;
  status: CostGuardStatus;
  stopReason: StopReason;
  consecutiveMetricFailures: number;
  warningAttemptedAt: string | null;
  warningDeliveredAt: string | null;
  metricsWarningAttemptedAt: string | null;
  metricsWarningDeliveredAt: string | null;
  stopNotificationAttemptedAt: string | null;
  stopNotificationDeliveredAt: string | null;
  stoppedAt: string | null;
  resumedAt: string | null;
  resumeWorkflowRunId: string | null;
  resumeClaim: ResumeClaim | null;
  detachPending: boolean;
  detachedDomains: DetachedDomain[];
  lastCheckedAt: string;
  lastUsage: UsageSnapshot | null;
}

export interface ResumeRequest {
  version: 1;
  environment: string;
  cycleStart: string;
  stoppedAt: string;
  requestedAt: string;
  workflowRunId: string;
}

export interface ResumeClaim extends ResumeRequest {
  claimedAt: string;
  attemptId: string;
}

export type MetricOutcome =
  | { ok: true; metrics: CostGuardMetrics }
  | { ok: false };

const METRIC_NAMES: readonly CostMetricName[] = [
  "workerRequests",
  "workerCpuMs",
  "r2ClassAOperations",
  "r2ClassBOperations",
  "r2StorageBytes",
];

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function anchoredDate(year: number, month: number, anchorDay: number): Date {
  return new Date(
    Date.UTC(year, month, Math.min(anchorDay, daysInUtcMonth(year, month))),
  );
}

export function billingCycleAt(now: Date, anchorDay: number): BillingCycle {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new Error("BILLING_CYCLE_ANCHOR_DAY_UTC must be an integer from 1 to 31");
  }

  const thisMonth = anchoredDate(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    anchorDay,
  );
  const start =
    now.getTime() >= thisMonth.getTime()
      ? thisMonth
      : anchoredDate(now.getUTCFullYear(), now.getUTCMonth() - 1, anchorDay);
  const end = anchoredDate(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    anchorDay,
  );

  return { start: start.toISOString(), end: end.toISOString() };
}

export function usageSnapshot(
  metrics: CostGuardMetrics,
  limits: CostGuardLimits,
  measuredAt: string,
): UsageSnapshot {
  const ratios = {} as Record<CostMetricName, number>;
  let maxMetric: CostMetricName = "workerRequests";
  let maxRatio = -1;

  for (const metric of METRIC_NAMES) {
    const value = metrics[metric];
    const limit = limits[metric];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid usage value for ${metric}`);
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`Invalid included limit for ${metric}`);
    }
    const ratio = value / limit;
    ratios[metric] = ratio;
    if (ratio > maxRatio) {
      maxRatio = ratio;
      maxMetric = metric;
    }
  }

  return { measuredAt, values: metrics, ratios, maxMetric, maxRatio };
}

function initialState(
  environment: string,
  cycle: BillingCycle,
  checkedAt: string,
): CostGuardState {
  return {
    version: 1,
    environment,
    cycleStart: cycle.start,
    cycleEnd: cycle.end,
    status: "NORMAL",
    stopReason: null,
    consecutiveMetricFailures: 0,
    warningAttemptedAt: null,
    warningDeliveredAt: null,
    metricsWarningAttemptedAt: null,
    metricsWarningDeliveredAt: null,
    stopNotificationAttemptedAt: null,
    stopNotificationDeliveredAt: null,
    stoppedAt: null,
    resumedAt: null,
    resumeWorkflowRunId: null,
    resumeClaim: null,
    detachPending: false,
    detachedDomains: [],
    lastCheckedAt: checkedAt,
    lastUsage: null,
  };
}

function beginCycle(
  previous: CostGuardState | null,
  environment: string,
  cycle: BillingCycle,
  checkedAt: string,
): CostGuardState {
  if (
    previous !== null &&
    previous.environment === environment &&
    previous.cycleStart === cycle.start &&
    previous.cycleEnd === cycle.end
  ) {
    return structuredClone(previous);
  }

  const next = initialState(environment, cycle, checkedAt);
  if (
    previous !== null &&
    (previous.status === "STOPPED" ||
      previous.detachPending ||
      previous.detachedDomains.length > 0)
  ) {
    next.status = "STOPPED";
    next.stopReason = "manual_resume_required";
    next.stoppedAt = previous.stoppedAt ?? checkedAt;
    next.resumeClaim = null;
    next.detachPending = true;
    next.detachedDomains = structuredClone(previous.detachedDomains);
  }
  return next;
}

export function transitionState(input: {
  previous: CostGuardState | null;
  environment: string;
  cycle: BillingCycle;
  checkedAt: string;
  limits: CostGuardLimits;
  outcome: MetricOutcome;
}): CostGuardState {
  const next = beginCycle(
    input.previous,
    input.environment,
    input.cycle,
    input.checkedAt,
  );
  next.lastCheckedAt = input.checkedAt;

  if (!input.outcome.ok) {
    next.consecutiveMetricFailures += 1;
    if (next.status !== "STOPPED") {
      next.status =
        next.consecutiveMetricFailures >= METRIC_FAILURES_BEFORE_STOP
          ? "STOPPED"
          : "WARNING";
      next.stopReason = "metrics_unavailable";
      if (next.status === "STOPPED") {
        next.stoppedAt ??= input.checkedAt;
        next.detachPending = true;
      }
    }
    return next;
  }

  next.consecutiveMetricFailures = 0;
  next.lastUsage = usageSnapshot(
    input.outcome.metrics,
    input.limits,
    input.checkedAt,
  );

  // STOPPED is deliberately latched. Only an approved resume request can clear it.
  if (next.status === "STOPPED") return next;

  if (next.lastUsage.maxRatio >= STOP_RATIO) {
    next.status = "STOPPED";
    next.stopReason = "usage_threshold";
    next.stoppedAt = input.checkedAt;
    next.detachPending = true;
  } else if (next.lastUsage.maxRatio >= WARNING_RATIO) {
    next.status = "WARNING";
    next.stopReason = null;
  } else {
    next.status = "NORMAL";
    next.stopReason = null;
  }

  return next;
}

export function warningReasonToAttempt(
  next: CostGuardState,
): WarningReason | null {
  if (next.status === "NORMAL") return null;
  if (next.stopReason === "metrics_unavailable") {
    return next.metricsWarningAttemptedAt === null
      ? "metrics_unavailable"
      : null;
  }
  const crossedUsageWarning =
    next.stopReason === "usage_threshold" ||
    (next.status === "WARNING" &&
      next.lastUsage !== null &&
      next.lastUsage.maxRatio >= WARNING_RATIO);
  return crossedUsageWarning && next.warningAttemptedAt === null
    ? "usage_threshold"
    : null;
}

export function shouldAttemptStopNotification(next: CostGuardState): boolean {
  return next.status === "STOPPED" && next.stopNotificationAttemptedAt === null;
}

export function canResume(state: CostGuardState, usage: UsageSnapshot): boolean {
  return state.status === "STOPPED" && usage.maxRatio < RESUME_RATIO;
}

function strictTimestampMillis(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function validWorkflowRunId(value: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(value);
}

export function isResumeRequestEligible(input: {
  state: CostGuardState;
  usage: UsageSnapshot;
  request: ResumeRequest;
  checkedAt: string;
}): boolean {
  if (
    !canResume(input.state, input.usage) ||
    input.state.stoppedAt === null ||
    input.request.version !== 1 ||
    input.request.environment !== input.state.environment ||
    input.request.cycleStart !== input.state.cycleStart ||
    input.request.stoppedAt !== input.state.stoppedAt ||
    !validWorkflowRunId(input.request.workflowRunId) ||
    input.request.workflowRunId === input.state.resumeWorkflowRunId
  ) {
    return false;
  }

  const requestedAt = strictTimestampMillis(input.request.requestedAt);
  const stoppedAt = strictTimestampMillis(input.state.stoppedAt);
  const checkedAt = strictTimestampMillis(input.checkedAt);
  if (requestedAt === null || stoppedAt === null || checkedAt === null) {
    return false;
  }
  return (
    requestedAt > stoppedAt &&
    requestedAt <= checkedAt &&
    checkedAt - requestedAt <= RESUME_REQUEST_MAX_AGE_MS
  );
}

export function beginResumeClaim(input: {
  state: CostGuardState;
  usage: UsageSnapshot;
  request: ResumeRequest;
  claimedAt: string;
  attemptId: string;
}): CostGuardState {
  if (
    input.state.resumeClaim !== null ||
    input.state.detachedDomains.length === 0 ||
    !isResumeRequestEligible({
      state: input.state,
      usage: input.usage,
      request: input.request,
      checkedAt: input.claimedAt,
    }) ||
    input.attemptId.length === 0
  ) {
    throw new Error("Resume request is not eligible for a durable claim");
  }

  return {
    ...input.state,
    resumeClaim: {
      ...input.request,
      claimedAt: input.claimedAt,
      attemptId: input.attemptId,
    },
    lastCheckedAt: input.claimedAt,
    lastUsage: input.usage,
  };
}

export function isResumeClaimLeaseExpired(
  claim: ResumeClaim,
  checkedAt: string,
): boolean {
  const claimedAt = strictTimestampMillis(claim.claimedAt);
  const now = strictTimestampMillis(checkedAt);
  return (
    claimedAt === null ||
    now === null ||
    now - claimedAt >= RESUME_CLAIM_LEASE_MS
  );
}

export function renewResumeClaim(
  state: CostGuardState,
  claimedAt: string,
  attemptId: string,
): CostGuardState {
  if (
    state.resumeClaim === null ||
    strictTimestampMillis(claimedAt) === null ||
    attemptId.length === 0
  ) {
    throw new Error("Resume claim cannot be renewed");
  }
  return {
    ...state,
    resumeClaim: { ...state.resumeClaim, claimedAt, attemptId },
    lastCheckedAt: claimedAt,
  };
}

export function completeResume(
  state: CostGuardState,
  usage: UsageSnapshot,
  request: ResumeRequest,
  resumedAt: string,
): CostGuardState {
  if (
    !isResumeRequestEligible({ state, usage, request, checkedAt: resumedAt })
  ) {
    throw new Error("Resume request does not match the stopped billing cycle");
  }

  return {
    ...state,
    status: "NORMAL",
    stopReason: null,
    consecutiveMetricFailures: 0,
    stoppedAt: null,
    resumedAt,
    resumeWorkflowRunId: request.workflowRunId,
    resumeClaim: null,
    detachPending: false,
    detachedDomains: [],
    lastCheckedAt: resumedAt,
    lastUsage: usage,
  };
}

export function isCostGuardState(value: unknown): value is CostGuardState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<CostGuardState>;
  const nullableString = (field: unknown): boolean =>
    field === null || typeof field === "string";
  const validMetricRecord = (field: unknown): boolean => {
    if (typeof field !== "object" || field === null) return false;
    const record = field as Partial<Record<CostMetricName, unknown>>;
    return METRIC_NAMES.every(
      (metric) =>
        typeof record[metric] === "number" &&
        Number.isFinite(record[metric]) &&
        (record[metric] ?? -1) >= 0,
    );
  };
  const validUsage = (field: unknown): boolean => {
    if (field === null) return true;
    if (typeof field !== "object") return false;
    const usage = field as Partial<UsageSnapshot>;
    return (
      typeof usage.measuredAt === "string" &&
      validMetricRecord(usage.values) &&
      validMetricRecord(usage.ratios) &&
      METRIC_NAMES.includes(usage.maxMetric as CostMetricName) &&
      typeof usage.maxRatio === "number" &&
      Number.isFinite(usage.maxRatio) &&
      usage.maxRatio >= 0
    );
  };
  const validDetachedDomains =
    Array.isArray(state.detachedDomains) &&
    state.detachedDomains.every(
      (domain) =>
        typeof domain === "object" &&
        domain !== null &&
        typeof domain.domainId === "string" &&
        typeof domain.hostname === "string" &&
        typeof domain.service === "string" &&
        typeof domain.zoneId === "string" &&
        typeof domain.zoneName === "string",
    ) &&
    new Set(state.detachedDomains.map(({ hostname }) => hostname)).size ===
      state.detachedDomains.length;
  const validResumeClaim =
    state.resumeClaim === undefined ||
    state.resumeClaim === null ||
    isResumeClaim(state.resumeClaim);
  return (
    state.version === 1 &&
    typeof state.environment === "string" &&
    typeof state.cycleStart === "string" &&
    typeof state.cycleEnd === "string" &&
    (state.status === "NORMAL" ||
      state.status === "WARNING" ||
      state.status === "STOPPED") &&
    (state.stopReason === null ||
      state.stopReason === "usage_threshold" ||
      state.stopReason === "metrics_unavailable" ||
      state.stopReason === "manual_resume_required") &&
    Number.isInteger(state.consecutiveMetricFailures) &&
    (state.consecutiveMetricFailures ?? -1) >= 0 &&
    nullableString(state.warningAttemptedAt) &&
    nullableString(state.warningDeliveredAt) &&
    (state.metricsWarningAttemptedAt === undefined ||
      nullableString(state.metricsWarningAttemptedAt)) &&
    (state.metricsWarningDeliveredAt === undefined ||
      nullableString(state.metricsWarningDeliveredAt)) &&
    nullableString(state.stopNotificationAttemptedAt) &&
    nullableString(state.stopNotificationDeliveredAt) &&
    nullableString(state.stoppedAt) &&
    nullableString(state.resumedAt) &&
    nullableString(state.resumeWorkflowRunId) &&
    validResumeClaim &&
    typeof state.detachPending === "boolean" &&
    validDetachedDomains &&
    typeof state.lastCheckedAt === "string" &&
    validUsage(state.lastUsage)
  );
}

export function isResumeRequest(value: unknown): value is ResumeRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<ResumeRequest>;
  return (
    request.version === 1 &&
    typeof request.environment === "string" &&
    typeof request.cycleStart === "string" &&
    strictTimestampMillis(request.cycleStart) !== null &&
    typeof request.stoppedAt === "string" &&
    strictTimestampMillis(request.stoppedAt) !== null &&
    typeof request.requestedAt === "string" &&
    strictTimestampMillis(request.requestedAt) !== null &&
    typeof request.workflowRunId === "string" &&
    validWorkflowRunId(request.workflowRunId)
  );
}

export function isResumeClaim(value: unknown): value is ResumeClaim {
  if (!isResumeRequest(value)) return false;
  const claim = value as Partial<ResumeClaim>;
  return (
    typeof claim.claimedAt === "string" &&
    strictTimestampMillis(claim.claimedAt) !== null &&
    typeof claim.attemptId === "string" &&
    claim.attemptId.length > 0
  );
}
