import {
  attachWorkerDomain,
  detachWorkerDomain,
  listWorkerDomains,
  selectProtectedDomains,
  validateResumeDomains,
} from "./cloudflare-domains";
import { parseCostGuardConfig, type CostGuardConfig } from "./config";
import { queryAccountMetrics } from "./metrics";
import {
  beginResumeClaim,
  billingCycleAt,
  completeResume,
  isResumeClaimLeaseExpired,
  isResumeRequestEligible,
  renewResumeClaim,
  shouldAttemptStopNotification,
  transitionState,
  usageSnapshot,
  warningReasonToAttempt,
  type CostGuardState,
  type DetachedDomain,
  type ResumeClaim,
  type ResumeRequest,
  type WarningReason,
} from "./model";
import {
  deleteResumeRequest,
  loadResumeRequest,
  loadState,
  saveState,
} from "./state-store";

export interface CostGuardDependencies {
  fetcher: typeof fetch;
  now: () => Date;
  newResumeAttemptId: () => string;
}

const defaultDependencies: CostGuardDependencies = {
  // Workerd's global fetch requires its original receiver. Dependencies are
  // invoked as properties below, so preserve the global call shape in an arrow.
  fetcher: (...args) => fetch(...args),
  now: () => new Date(),
  newResumeAttemptId: () => crypto.randomUUID(),
};

function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  const payload = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function safeInternalError(error: unknown): {
  errorName: string;
  errorMessage: string;
} {
  if (!(error instanceof Error)) {
    return { errorName: "UnknownError", errorMessage: "Unknown error" };
  }
  // This Worker never needs request data in its operational logs. Preserve only a
  // bounded diagnostic message and redact credential-shaped values defensively.
  return {
    errorName: error.name,
    errorMessage: error.message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(?:sb_secret_[A-Za-z0-9._-]+|[A-Za-z0-9_-]{35,})\b/g, "[redacted]")
      .slice(0, 240),
  };
}

async function tryDeleteResumeMarker(
  env: CostGuardEnv,
  config: CostGuardConfig,
  event: string,
): Promise<void> {
  try {
    await deleteResumeRequest(env.STATE);
  } catch (error) {
    log("error", event, {
      environment: config.environment,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function mergeDetachedDomains(
  stored: readonly DetachedDomain[],
  current: readonly DetachedDomain[],
): DetachedDomain[] {
  const merged = new Map(stored.map((domain) => [domain.hostname, domain]));
  for (const domain of current) merged.set(domain.hostname, domain);
  return [...merged.values()].sort((left, right) =>
    left.hostname.localeCompare(right.hostname),
  );
}

type NotificationKind = WarningReason | "stop";

function markWarningAttempted(
  state: CostGuardState,
  reason: WarningReason,
  attemptedAt: string,
): void {
  if (reason === "metrics_unavailable") {
    state.metricsWarningAttemptedAt = attemptedAt;
  } else {
    state.warningAttemptedAt = attemptedAt;
  }
}

function markWarningDelivered(
  state: CostGuardState,
  reason: WarningReason,
  deliveredAt: string,
): void {
  if (reason === "metrics_unavailable") {
    state.metricsWarningDeliveredAt = deliveredAt;
  } else {
    state.warningDeliveredAt = deliveredAt;
  }
}

function warningWasDelivered(
  state: CostGuardState,
  reason: WarningReason,
): boolean {
  return reason === "metrics_unavailable"
    ? state.metricsWarningDeliveredAt !== null
    : state.warningDeliveredAt !== null;
}

function alertText(
  config: CostGuardConfig,
  state: CostGuardState,
  kind: NotificationKind,
): string {
  const usage = state.lastUsage;
  const measuredUsage =
    usage === null
      ? "Usage metrics are unavailable."
      : `Highest usage: ${usage.maxMetric} at ${(usage.maxRatio * 100).toFixed(2)}%.`;
  return [
    kind === "stop"
      ? "Meoing Cloudflare Cost Guard reached STOPPED and is enforcing public API shutdown."
      : kind === "metrics_unavailable"
        ? "Meoing Cloudflare Cost Guard cannot read account analytics."
        : "Meoing Cloudflare Cost Guard crossed the account-usage warning threshold.",
    `Environment: ${config.environment}`,
    `Billing cycle: ${state.cycleStart} to ${state.cycleEnd}`,
    `Reason: ${kind === "stop" ? state.stopReason : kind}`,
    measuredUsage,
    kind === "stop"
      ? "The strict allowlisted Meoing API custom domains are being detached. Use the protected GitHub resume workflow only after usage is below 5%."
      : kind === "metrics_unavailable"
        ? "Restore account analytics before the third consecutive failure forces STOPPED."
        : "Review account-wide Workers and R2 usage before the 95% stop threshold.",
  ].join("\n");
}

async function trySendNotification(
  env: CostGuardEnv,
  config: CostGuardConfig,
  state: CostGuardState,
  kind: NotificationKind,
): Promise<boolean> {
  try {
    await env.ALERT_EMAIL.send({
      from: config.alertFrom,
      to: config.alertRecipient,
      subject:
        kind === "stop"
          ? `[Meoing ${config.environment}] Cost Guard STOPPED`
          : kind === "metrics_unavailable"
            ? `[Meoing ${config.environment}] Cost Guard metrics warning`
            : `[Meoing ${config.environment}] Cost Guard usage warning`,
      text: alertText(config, state, kind),
    });
    log("warn", "cost_guard_notification_sent", {
      environment: config.environment,
      status: state.status,
      notificationKind: kind,
      cycleStart: state.cycleStart,
    });
    return true;
  } catch (error) {
    log("error", "cost_guard_notification_failed", {
      environment: config.environment,
      status: state.status,
      notificationKind: kind,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }
}

async function finishClaimedResume(input: {
  env: CostGuardEnv;
  config: CostGuardConfig;
  deps: CostGuardDependencies;
  state: CostGuardState;
  stateEtag: string | null;
  claim: ResumeClaim;
  checkedAt: string;
}): Promise<CostGuardState> {
  const usage = input.state.lastUsage;
  if (usage === null || input.state.resumeClaim === null) {
    throw new Error("A durable resume claim and usage snapshot are required");
  }

  const currentDomains = await listWorkerDomains({
    fetcher: input.deps.fetcher,
    accountId: input.config.accountId,
    apiToken: input.config.apiToken,
  });
  const missing = validateResumeDomains({
    current: currentDomains,
    detached: input.state.detachedDomains,
    allowlist: input.config.protectedDomains,
  });
  for (const domain of missing) {
    await attachWorkerDomain({
      fetcher: input.deps.fetcher,
      accountId: input.config.accountId,
      apiToken: input.config.apiToken,
      domain,
    });
  }

  const resumed = completeResume(
    input.state,
    usage,
    input.claim,
    input.checkedAt,
  );
  await saveState(input.env.STATE, resumed, input.stateEtag);
  // The consumed workflow run ID and stoppedAt ordering make a leftover marker
  // unusable. Cleanup is retried if a later STOPPED run encounters it.
  await tryDeleteResumeMarker(
    input.env,
    input.config,
    "cost_guard_resume_marker_cleanup_failed",
  );
  log("info", "cost_guard_resumed", {
    environment: input.config.environment,
    cycleStart: resumed.cycleStart,
    workflowRunId: input.claim.workflowRunId,
  });
  return resumed;
}

async function enforceStop(input: {
  env: CostGuardEnv;
  config: CostGuardConfig;
  deps: CostGuardDependencies;
  state: CostGuardState;
  expectedEtag: string | null;
  warningReason: WarningReason | null;
  sendStop: boolean;
}): Promise<CostGuardState> {
  let currentlyAttached: DetachedDomain[] = [];
  let listError: unknown = null;
  try {
    const domains = await listWorkerDomains({
      fetcher: input.deps.fetcher,
      accountId: input.config.accountId,
      apiToken: input.config.apiToken,
    });
    currentlyAttached = selectProtectedDomains(
      domains,
      input.config.protectedDomains,
    );
  } catch (error) {
    listError = error;
  }
  const planned: CostGuardState = {
    ...input.state,
    detachPending: listError !== null || currentlyAttached.length > 0,
    detachedDomains: mergeDetachedDomains(
      input.state.detachedDomains,
      currentlyAttached,
    ),
  };
  await saveState(input.env.STATE, planned, input.expectedEtag);

  if (input.warningReason !== null) {
    if (
      await trySendNotification(
        input.env,
        input.config,
        planned,
        input.warningReason,
      )
    ) {
      markWarningDelivered(
        planned,
        input.warningReason,
        planned.lastCheckedAt,
      );
    }
  }
  if (input.sendStop) {
    if (await trySendNotification(input.env, input.config, planned, "stop")) {
      planned.stopNotificationDeliveredAt = planned.lastCheckedAt;
    }
  }

  if (listError !== null) {
    // STOPPED and notification markers are durable; the next Cron retries enforcement.
    throw listError;
  }

  for (const domain of currentlyAttached) {
    await detachWorkerDomain({
      fetcher: input.deps.fetcher,
      accountId: input.config.accountId,
      apiToken: input.config.apiToken,
      domainId: domain.domainId,
    });
  }

  // The pre-effect state is intentionally the only write in this run. This keeps the
  // hard 10-subrequest ceiling even for two deletes plus both cycle notifications.
  // The next idempotent Cron sees no attached allowlisted domain and clears pending.
  const completed = { ...planned, detachPending: false };
  log("error", "cost_guard_stopped", {
    environment: input.config.environment,
    cycleStart: completed.cycleStart,
    detachedHostnames: currentlyAttached.map(({ hostname }) => hostname),
    reason: completed.stopReason,
  });
  return completed;
}

export async function runCostGuard(
  env: CostGuardEnv,
  dependencies: Partial<CostGuardDependencies> = {},
): Promise<CostGuardState> {
  const deps = { ...defaultDependencies, ...dependencies };
  const config = parseCostGuardConfig(env);
  const checkedAt = deps.now().toISOString();
  const cycle = billingCycleAt(new Date(checkedAt), config.billingAnchorDay);
  const stored = await loadState(env.STATE);

  let resumeRequest: ResumeRequest | null = null;
  // A resume request cannot legitimately predate STOPPED state. Skipping this R2 read
  // on NORMAL/WARNING runs preserves headroom under the 10-subrequest hard limit.
  if (
    stored.state?.status === "STOPPED" &&
    stored.state.resumeClaim === null
  ) {
    try {
      resumeRequest = await loadResumeRequest(env.STATE);
    } catch (error) {
      await tryDeleteResumeMarker(
        env,
        config,
        "cost_guard_resume_marker_cleanup_failed",
      );
      log("error", "cost_guard_resume_request_invalid", {
        environment: config.environment,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  let metrics: Awaited<ReturnType<typeof queryAccountMetrics>> | null = null;
  try {
    metrics = await queryAccountMetrics({
      fetcher: deps.fetcher,
      accountId: config.accountId,
      apiToken: config.apiToken,
      cycleStart: cycle.start,
      measuredAt: checkedAt,
    });
  } catch (error) {
    const detail = safeInternalError(error);
    log("error", "cost_guard_metrics_failed", {
      environment: config.environment,
      ...detail,
    });
  }

  let next = transitionState({
    previous: stored.state,
    environment: config.environment,
    cycle,
    checkedAt,
    limits: config.limits,
    outcome: metrics === null ? { ok: false } : { ok: true, metrics },
  });

  if (next.status === "STOPPED") {
    const usage =
      metrics === null
        ? null
        : usageSnapshot(metrics, config.limits, checkedAt);
    if (usage !== null) next.lastUsage = usage;

    const candidate = next.resumeClaim ?? resumeRequest;
    const eligible =
      candidate !== null &&
      usage !== null &&
      next.detachedDomains.length > 0 &&
      isResumeRequestEligible({
        state: next,
        usage,
        request: candidate,
        checkedAt,
      });

    if (eligible && usage !== null && candidate !== null) {
      let claimedState: CostGuardState;
      let claimedEtag: string;
      let claim: ResumeClaim;

      if (next.resumeClaim === null) {
        claimedState = beginResumeClaim({
          state: next,
          usage,
          request: candidate,
          claimedAt: checkedAt,
          attemptId: deps.newResumeAttemptId(),
        });
        claimedEtag = await saveState(env.STATE, claimedState, stored.etag);
        const persistedClaim = claimedState.resumeClaim;
        if (persistedClaim === null) {
          throw new Error("Resume claim was not persisted");
        }
        claim = persistedClaim;
        log("info", "cost_guard_resume_claimed", {
          environment: config.environment,
          cycleStart: claimedState.cycleStart,
          workflowRunId: claim.workflowRunId,
        });
      } else if (isResumeClaimLeaseExpired(next.resumeClaim, checkedAt)) {
        claimedState = renewResumeClaim(
          next,
          checkedAt,
          deps.newResumeAttemptId(),
        );
        claimedEtag = await saveState(env.STATE, claimedState, stored.etag);
        const persistedClaim = claimedState.resumeClaim;
        if (persistedClaim === null) {
          throw new Error("Resume claim renewal was not persisted");
        }
        claim = persistedClaim;
        log("warn", "cost_guard_resume_claim_recovered", {
          environment: config.environment,
          cycleStart: claimedState.cycleStart,
          workflowRunId: claim.workflowRunId,
        });
      } else {
        log("info", "cost_guard_resume_in_progress", {
          environment: config.environment,
          cycleStart: next.cycleStart,
          workflowRunId: next.resumeClaim.workflowRunId,
        });
        return next;
      }

      return finishClaimedResume({
        env,
        config,
        deps,
        state: claimedState,
        stateEtag: claimedEtag,
        claim,
        checkedAt,
      });
    }

    if (candidate !== null) {
      next.resumeClaim = null;
      await tryDeleteResumeMarker(
        env,
        config,
        "cost_guard_resume_marker_cleanup_failed",
      );
      log("warn", "cost_guard_resume_rejected", {
        environment: config.environment,
        cycleStart: next.cycleStart,
        maxRatio: usage?.maxRatio ?? null,
        workflowRunId: candidate.workflowRunId,
      });
      resumeRequest = null;
    }
  }

  const warningReason = warningReasonToAttempt(next);
  const stopAttempt = shouldAttemptStopNotification(next);
  if (warningReason !== null) {
    markWarningAttempted(next, warningReason, checkedAt);
  }
  if (stopAttempt) next.stopNotificationAttemptedAt = checkedAt;

  if (next.status === "STOPPED") {
    return enforceStop({
      env,
      config,
      deps,
      state: next,
      expectedEtag: stored.etag,
      warningReason,
      sendStop: stopAttempt,
    });
  }

  let stateEtag = await saveState(env.STATE, next, stored.etag);
  if (warningReason !== null) {
    const delivered = await trySendNotification(env, config, next, warningReason);
    if (delivered) markWarningDelivered(next, warningReason, checkedAt);
  }
  if (warningReason !== null && warningWasDelivered(next, warningReason)) {
    stateEtag = await saveState(env.STATE, next, stateEtag);
  }
  void stateEtag;
  log("info", "cost_guard_checked", {
    environment: config.environment,
    cycleStart: next.cycleStart,
    status: next.status,
    maxMetric: next.lastUsage?.maxMetric ?? null,
    maxRatio: next.lastUsage?.maxRatio ?? null,
    consecutiveMetricFailures: next.consecutiveMetricFailures,
  });
  return next;
}
