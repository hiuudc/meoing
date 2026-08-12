import { describe, expect, it } from "vitest";
// @ts-expect-error Vite exposes checked-in configuration fixtures through raw imports.
import costGuardWranglerSource from "../wrangler.cost-guard.jsonc?raw";
import {
  selectProtectedDomains,
  validateResumeDomains,
} from "../src/cost-guard/cloudflare-domains";
import { parseMetricsPayload } from "../src/cost-guard/metrics";
import { assertCostGuardControllerTopology } from "../src/cost-guard/config";
import { runCostGuard } from "../src/cost-guard/service";
import {
  billingCycleAt,
  canResume,
  completeResume,
  isResumeRequest,
  isResumeRequestEligible,
  shouldAttemptStopNotification,
  transitionState,
  usageSnapshot,
  warningReasonToAttempt,
  type BillingCycle,
  type CostGuardLimits,
  type CostGuardMetrics,
  type CostGuardState,
  type ResumeRequest,
} from "../src/cost-guard/model";

const limits: CostGuardLimits = {
  workerRequests: 100,
  workerCpuMs: 100,
  r2ClassAOperations: 100,
  r2ClassBOperations: 100,
  r2StorageBytes: 100,
};

const lowMetrics: CostGuardMetrics = {
  workerRequests: 10,
  workerCpuMs: 10,
  r2ClassAOperations: 10,
  r2ClassBOperations: 10,
  r2StorageBytes: 10,
};

const cycle: BillingCycle = {
  start: "2026-07-31T00:00:00.000Z",
  end: "2026-08-31T00:00:00.000Z",
};

function transition(
  previous: CostGuardState | null,
  outcome:
    | { ok: true; metrics: CostGuardMetrics }
    | { ok: false },
  currentCycle = cycle,
): CostGuardState {
  return transitionState({
    previous,
    environment: "staging",
    cycle: currentCycle,
    checkedAt: "2026-08-01T00:00:00.000Z",
    limits,
    outcome,
  });
}

describe("Cost Guard thresholds", () => {
  it("uses exact 80% warning and 95% stop boundaries", () => {
    const normal = transition(null, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 79.999 },
    });
    expect(normal.status).toBe("NORMAL");

    const warning = transition(null, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 80 },
    });
    expect(warning.status).toBe("WARNING");
    expect(warning.lastUsage?.maxRatio).toBe(0.8);

    const stopped = transition(null, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 95 },
    });
    expect(stopped.status).toBe("STOPPED");
    expect(stopped.stopReason).toBe("usage_threshold");
    expect(stopped.detachPending).toBe(true);
  });

  it("keeps STOPPED latched even when later usage is low", () => {
    const stopped = transition(null, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 95 },
    });
    const later = transition(stopped, { ok: true, metrics: lowMetrics });
    expect(later.status).toBe("STOPPED");
  });

  it("requires usage to be strictly below 5% for resume", () => {
    const stopped = transition(null, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 95 },
    });
    const atFive = usageSnapshot(
      { ...lowMetrics, workerRequests: 5 },
      limits,
      "2026-08-01T00:05:00.000Z",
    );
    const belowFive = usageSnapshot(
      {
        workerRequests: 4.999,
        workerCpuMs: 4,
        r2ClassAOperations: 4,
        r2ClassBOperations: 4,
        r2StorageBytes: 4,
      },
      limits,
      "2026-08-01T00:05:00.000Z",
    );
    expect(canResume(stopped, atFive)).toBe(false);
    expect(canResume(stopped, belowFive)).toBe(true);

    const resumed = completeResume(
      { ...stopped, detachedDomains: [{
        domainId: "domain-1",
        hostname: "api-staging.meoing.com",
        service: "meoing-api-staging",
        zoneId: "zone-1",
        zoneName: "meoing.com",
      }] },
      belowFive,
      {
        version: 1,
        environment: "staging",
        cycleStart: cycle.start,
        stoppedAt: stopped.stoppedAt!,
        requestedAt: "2026-08-01T00:04:00.000Z",
        workflowRunId: "1234",
      },
      "2026-08-01T00:05:00.000Z",
    );
    expect(resumed.status).toBe("NORMAL");
    expect(resumed.detachedDomains).toEqual([]);
    expect(resumed.resumeWorkflowRunId).toBe("1234");
  });
});

describe("resume request replay protection", () => {
  const stopped = (() => {
    const state = transition(null, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 95 },
    });
    state.detachedDomains = [{
      domainId: "domain-1",
      hostname: "api-staging.meoing.com",
      service: "meoing-api-staging",
      zoneId: "zone-1",
      zoneName: "meoing.com",
    }];
    return state;
  })();
  const belowFive = usageSnapshot(
    {
      workerRequests: 4,
      workerCpuMs: 4,
      r2ClassAOperations: 4,
      r2ClassBOperations: 4,
      r2StorageBytes: 4,
    },
    limits,
    "2026-08-01T00:05:00.000Z",
  );
  const request: ResumeRequest = {
    version: 1,
    environment: "staging",
    cycleStart: cycle.start,
    stoppedAt: stopped.stoppedAt!,
    requestedAt: "2026-08-01T00:01:00.000Z",
    workflowRunId: "1234",
  };

  it("accepts only a strict, fresh timestamp after the current stop", () => {
    expect(isResumeRequestEligible({
      state: stopped,
      usage: belowFive,
      request,
      checkedAt: "2026-08-01T00:05:00.000Z",
    })).toBe(true);
    expect(isResumeRequestEligible({
      state: stopped,
      usage: belowFive,
      request: { ...request, requestedAt: stopped.stoppedAt! },
      checkedAt: "2026-08-01T00:05:00.000Z",
    })).toBe(false);
    expect(isResumeRequestEligible({
      state: stopped,
      usage: belowFive,
      request,
      checkedAt: "2026-08-01T00:17:00.001Z",
    })).toBe(false);
    expect(isResumeRequest({
      ...request,
      requestedAt: "2026-08-01 00:01:00Z",
    })).toBe(false);
  });

  it("rejects a workflow run ID already consumed by this billing cycle", () => {
    expect(isResumeRequestEligible({
      state: { ...stopped, resumeWorkflowRunId: request.workflowRunId },
      usage: belowFive,
      request,
      checkedAt: "2026-08-01T00:05:00.000Z",
    })).toBe(false);
  });

  it("binds an approval marker to the exact current stop", () => {
    expect(isResumeRequestEligible({
      state: { ...stopped, stoppedAt: "2026-08-01T00:02:00.000Z" },
      usage: belowFive,
      request: {
        ...request,
        requestedAt: "2026-08-01T00:03:00.000Z",
        workflowRunId: "1235",
      },
      checkedAt: "2026-08-01T00:05:00.000Z",
    })).toBe(false);
  });
});

describe("Cost Guard metric failure state", () => {
  it("fails closed on the third consecutive metric failure", () => {
    const first = transition(null, { ok: false });
    expect(first.status).toBe("WARNING");
    expect(first.consecutiveMetricFailures).toBe(1);
    expect(warningReasonToAttempt(first)).toBe("metrics_unavailable");

    const warned = {
      ...first,
      metricsWarningAttemptedAt: first.lastCheckedAt,
    };
    const second = transition(warned, { ok: false });
    expect(second.status).toBe("WARNING");
    expect(second.consecutiveMetricFailures).toBe(2);
    expect(warningReasonToAttempt(second)).toBeNull();

    const third = transition(second, { ok: false });
    expect(third.status).toBe("STOPPED");
    expect(third.stopReason).toBe("metrics_unavailable");
    expect(third.detachPending).toBe(true);
  });

  it("resets the failure counter after a valid query", () => {
    const failed = transition(null, { ok: false });
    const recovered = transition(failed, { ok: true, metrics: lowMetrics });
    expect(recovered.status).toBe("NORMAL");
    expect(recovered.consecutiveMetricFailures).toBe(0);
  });

  it("does not let a metrics warning consume the later 80% usage warning", () => {
    const failed = transition(null, { ok: false });
    failed.metricsWarningAttemptedAt = failed.lastCheckedAt;

    const recovered = transition(failed, { ok: true, metrics: lowMetrics });
    expect(recovered.status).toBe("NORMAL");
    expect(recovered.warningAttemptedAt).toBeNull();

    const usageWarning = transition(recovered, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 80 },
    });
    expect(warningReasonToAttempt(usageWarning)).toBe("usage_threshold");
  });

  it("sends one warning and a separate idempotent stop notification", () => {
    const warning = transition(null, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 80 },
    });
    expect(warningReasonToAttempt(warning)).toBe("usage_threshold");
    expect(shouldAttemptStopNotification(warning)).toBe(false);

    const warningMarked = {
      ...warning,
      warningAttemptedAt: warning.lastCheckedAt,
    };
    const stopped = transition(warningMarked, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 95 },
    });
    expect(warningReasonToAttempt(stopped)).toBeNull();
    expect(shouldAttemptStopNotification(stopped)).toBe(true);

    const stopMarked = {
      ...stopped,
      stopNotificationAttemptedAt: stopped.lastCheckedAt,
    };
    expect(shouldAttemptStopNotification(stopMarked)).toBe(false);
  });
});

describe("billing cycle rollover", () => {
  it("clamps a day-31 anchor for short UTC months", () => {
    expect(billingCycleAt(new Date("2026-03-01T12:00:00.000Z"), 31)).toEqual({
      start: "2026-02-28T00:00:00.000Z",
      end: "2026-03-31T00:00:00.000Z",
    });
  });

  it("preserves a stop latch and detached-domain record into a new cycle", () => {
    const stopped = transition(null, {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 95 },
    });
    stopped.warningAttemptedAt = stopped.lastCheckedAt;
    stopped.detachedDomains = [{
      domainId: "domain-1",
      hostname: "api-staging.meoing.com",
      service: "meoing-api-staging",
      zoneId: "zone-1",
      zoneName: "meoing.com",
    }];
    const nextCycle = {
      start: "2026-08-31T00:00:00.000Z",
      end: "2026-09-30T00:00:00.000Z",
    };
    const rolled = transition(stopped, { ok: true, metrics: lowMetrics }, nextCycle);
    expect(rolled.status).toBe("STOPPED");
    expect(rolled.stopReason).toBe("manual_resume_required");
    expect(rolled.detachedDomains).toEqual(stopped.detachedDomains);
    expect(rolled.warningAttemptedAt).toBeNull();
    expect(warningReasonToAttempt(rolled)).toBeNull();
  });
});

describe("account-wide singleton controller topology", () => {
  const stagingDomain = {
    hostname: "api-staging.meoing.com",
    service: "meoing-api-staging",
  };
  const productionDomain = {
    hostname: "api.meoing.com",
    service: "meoing-api-production",
  };

  it("requires production to own both exact API domain pairs", () => {
    expect(() =>
      assertCostGuardControllerTopology("production", [
        stagingDomain,
        productionDomain,
      ])
    ).not.toThrow();
    expect(() =>
      assertCostGuardControllerTopology("production", [productionDomain])
    ).toThrow(/account-wide singleton/);
  });

  it("limits staging simulation to only the staging API domain", () => {
    expect(() =>
      assertCostGuardControllerTopology("staging", [stagingDomain])
    ).not.toThrow();
    expect(() =>
      assertCostGuardControllerTopology("staging", [
        stagingDomain,
        productionDomain,
      ])
    ).toThrow(/simulation must target only/);
  });

  it("keeps only the production singleton scheduled in checked-in Wrangler config", () => {
    const rawConfig = JSON.parse(
      costGuardWranglerSource.replace(/^\s*\/\/.*$/gm, ""),
    ) as {
      triggers: { crons: string[] };
      env: Record<
        "staging" | "production",
        {
          account_id: string;
          triggers: { crons: string[] };
          r2_buckets: Array<{ binding: string; bucket_name: string }>;
          vars: {
            APP_ENV: string;
            CLOUDFLARE_ACCOUNT_ID: string;
            PROTECTED_CUSTOM_DOMAINS: string;
          };
        }
      >;
    };

    expect(rawConfig.triggers.crons).toEqual([]);
    expect(rawConfig.env.staging.triggers.crons).toEqual([]);
    expect(rawConfig.env.production.triggers.crons).toEqual(["*/5 * * * *"]);
    expect(rawConfig.env.staging.vars.APP_ENV).toBe("staging");
    expect(rawConfig.env.production.vars.APP_ENV).toBe("production");
    expect(rawConfig.env.staging.account_id).toBe(
      "00000000000000000000000000000000",
    );
    expect(rawConfig.env.production.account_id).toBe(
      "00000000000000000000000000000000",
    );
    expect(rawConfig.env.staging.account_id).toBe(
      rawConfig.env.staging.vars.CLOUDFLARE_ACCOUNT_ID,
    );
    expect(rawConfig.env.production.account_id).toBe(
      rawConfig.env.production.vars.CLOUDFLARE_ACCOUNT_ID,
    );
    expect(rawConfig.env.production.account_id).toBe(
      rawConfig.env.staging.account_id,
    );
    expect(rawConfig.env.staging.r2_buckets).toEqual([
      {
        binding: "STATE",
        bucket_name: "meoing-cost-guard-staging",
      },
    ]);
    expect(rawConfig.env.production.r2_buckets).toEqual([
      {
        binding: "STATE",
        bucket_name: "meoing-cost-guard-production",
      },
    ]);
    expect(() =>
      assertCostGuardControllerTopology(
        "staging",
        JSON.parse(rawConfig.env.staging.vars.PROTECTED_CUSTOM_DOMAINS),
      )
    ).not.toThrow();
    expect(() =>
      assertCostGuardControllerTopology(
        "production",
        JSON.parse(rawConfig.env.production.vars.PROTECTED_CUSTOM_DOMAINS),
      )
    ).not.toThrow();
  });
});

describe("strict custom-domain allowlist", () => {
  const allowlist = [{
    hostname: "api-staging.meoing.com",
    service: "meoing-api-staging",
  }];
  const protectedDomain = {
    id: "domain-1",
    hostname: "api-staging.meoing.com",
    service: "meoing-api-staging",
    zone_id: "zone-1",
    zone_name: "meoing.com",
  };

  it("selects only an exact hostname and service pair", () => {
    const selected = selectProtectedDomains(
      [
        protectedDomain,
        {
          id: "domain-2",
          hostname: "staging.meoing.com",
          service: "meoing-web-staging",
          zone_id: "zone-1",
          zone_name: "meoing.com",
        },
      ],
      allowlist,
    );
    expect(selected).toEqual([{
      domainId: "domain-1",
      hostname: "api-staging.meoing.com",
      service: "meoing-api-staging",
      zoneId: "zone-1",
      zoneName: "meoing.com",
    }]);
  });

  it("fails instead of detaching when the hostname maps to another Worker", () => {
    expect(() =>
      selectProtectedDomains(
        [{ ...protectedDomain, service: "some-other-worker" }],
        allowlist,
      ),
    ).toThrow(/unexpected Worker/);
  });

  it("reattaches only a recorded domain that remains allowlisted", () => {
    const detached = selectProtectedDomains([protectedDomain], allowlist);
    expect(
      validateResumeDomains({ current: [], detached, allowlist }),
    ).toEqual(detached);
    expect(() =>
      validateResumeDomains({
        current: [],
        detached,
        allowlist: [{ ...allowlist[0]!, service: "changed-worker" }],
      }),
    ).toThrow(/strict allowlist/);
  });
});

describe("Cloudflare GraphQL metric parsing", () => {
  it("uses current datasets and sums account-wide Worker and R2 values", () => {
    expect(parseMetricsPayload({
      data: {
        viewer: {
          accounts: [{
            workersInvocationsAdaptive: [{ sum: { requests: 20, cpuTimeUs: 12_500 } }],
            r2OperationsAdaptiveGroups: [
              { dimensions: { actionType: "PutObject" }, sum: { requests: 3 } },
              { dimensions: { actionType: "GetObject" }, sum: { requests: 7 } },
              { dimensions: { actionType: "DeleteObject" }, sum: { requests: 2 } },
              { dimensions: { actionType: "DeleteObjects" }, sum: { requests: 5 } },
            ],
            r2StorageAdaptiveGroups: [
              {
                dimensions: { bucketName: "one", datetime: "2026-08-01T02:00:00Z" },
                max: { payloadSize: 100, metadataSize: 2 },
              },
              {
                dimensions: { bucketName: "one", datetime: "2026-08-01T01:55:00Z" },
                max: { payloadSize: 90, metadataSize: 2 },
              },
              {
                dimensions: { bucketName: "two", datetime: "2026-08-01T02:00:00Z" },
                max: { payloadSize: 50, metadataSize: 1 },
              },
            ],
          }],
        },
      },
    })).toEqual({
      workerRequests: 20,
      workerCpuMs: 12.5,
      r2ClassAOperations: 3,
      r2ClassBOperations: 7,
      r2StorageBytes: 153,
    });
  });

  it("treats a new unknown R2 action as a metric failure", () => {
    expect(() => parseMetricsPayload({
      data: {
        viewer: {
          accounts: [{
            workersInvocationsAdaptive: [],
            r2OperationsAdaptiveGroups: [{
              dimensions: { actionType: "FuturePaidOperation" },
              sum: { requests: 1 },
            }],
            r2StorageAdaptiveGroups: [],
          }],
        },
      },
    })).toThrow(/Unknown R2 action/);
  });
});

const protectedDomainRecord = {
  domainId: "api-domain",
  hostname: "api-staging.meoing.com",
  service: "meoing-api-staging",
  zoneId: "zone-1",
  zoneName: "meoing.com",
};

const serviceCycle: BillingCycle = {
  start: "2026-07-30T00:00:00.000Z",
  end: "2026-08-30T00:00:00.000Z",
};

function stoppedResumeState(): CostGuardState {
  const state = transitionState({
    previous: null,
    environment: "staging",
    cycle: serviceCycle,
    checkedAt: "2026-08-01T00:00:00.000Z",
    limits,
    outcome: {
      ok: true,
      metrics: { ...lowMetrics, workerRequests: 95 },
    },
  });
  state.warningAttemptedAt = state.lastCheckedAt;
  state.stopNotificationAttemptedAt = state.lastCheckedAt;
  state.detachPending = false;
  state.detachedDomains = [protectedDomainRecord];
  return state;
}

function queuedResumeRequest(): ResumeRequest {
  return {
    version: 1,
    environment: "staging",
    cycleStart: serviceCycle.start,
    stoppedAt: "2026-08-01T00:00:00.000Z",
    requestedAt: "2026-08-01T00:01:00.000Z",
    workflowRunId: "2001",
  };
}

function memoryStateBucket(input: {
  state?: CostGuardState;
  request?: ResumeRequest;
  beforeStatePut?: (state: CostGuardState) => Promise<void>;
}) {
  const objects = new Map<string, { body: string; etag: string }>();
  let etagSequence = 0;
  const setJson = (key: string, value: unknown): void => {
    objects.set(key, {
      body: JSON.stringify(value),
      etag: `etag-${++etagSequence}`,
    });
  };
  if (input.state !== undefined) {
    setJson("cost-guard/state.json", input.state);
  }
  if (input.request !== undefined) {
    setJson("cost-guard/resume-request.json", input.request);
  }

  const bucket = {
    async get(key: string) {
      const stored = objects.get(key);
      if (stored === undefined) return null;
      return {
        etag: stored.etag,
        json: async () => JSON.parse(stored.body) as unknown,
      } as R2ObjectBody;
    },
    async put(key: string, value: unknown, options?: R2PutOptions) {
      if (typeof value !== "string") throw new Error("Expected JSON string");
      const parsed = JSON.parse(value) as CostGuardState;
      if (key === "cost-guard/state.json") {
        await input.beforeStatePut?.(parsed);
      }

      const existing = objects.get(key);
      const condition = options?.onlyIf;
      if (
        condition instanceof Headers &&
        condition.get("if-none-match") === "*" &&
        existing !== undefined
      ) {
        return null;
      }
      if (
        condition !== undefined &&
        !(condition instanceof Headers) &&
        condition.etagMatches !== undefined &&
        existing?.etag !== condition.etagMatches
      ) {
        return null;
      }
      const etag = `etag-${++etagSequence}`;
      objects.set(key, { body: value, etag });
      return { etag } as R2Object;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as R2Bucket;

  return {
    bucket,
    has: (key: string): boolean => objects.has(key),
    read: <T>(key: string): T =>
      JSON.parse(objects.get(key)!.body) as T,
    setJson,
  };
}

function resumeEnvironment(stateBucket: R2Bucket): CostGuardEnv {
  return {
    STATE: stateBucket,
    ALERT_EMAIL: {
      async send() {
        return {} as EmailSendResult;
      },
    } as SendEmail,
    APP_ENV: "staging",
    CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
    BILLING_CYCLE_ANCHOR_DAY_UTC: "30",
    WORKERS_REQUEST_GUARD_LIMIT: "1350000",
    WORKERS_INCLUDED_CPU_MS: "30000000",
    R2_INCLUDED_CLASS_A_OPERATIONS: "1000000",
    R2_INCLUDED_CLASS_B_OPERATIONS: "10000000",
    R2_INCLUDED_STORAGE_BYTES: "10000000000",
    PROTECTED_CUSTOM_DOMAINS:
      "[{\"hostname\":\"api-staging.meoing.com\",\"service\":\"meoing-api-staging\"}]",
    ALERT_FROM: "no-reply@auth.meoing.com",
    ALERT_RECIPIENT: "verified-recipient@example.com",
    CLOUDFLARE_COST_GUARD_TOKEN: "x".repeat(40),
  };
}

describe("reason-specific warning delivery", () => {
  it("delivers metrics failure then recovered 80% usage as separate warnings", async () => {
    const storage = memoryStateBucket({});
    const subjects: string[] = [];
    const env = {
      ...resumeEnvironment(storage.bucket),
      ALERT_EMAIL: {
        async send(message: EmailMessageBuilder) {
          subjects.push(message.subject);
          return {} as EmailSendResult;
        },
      } as SendEmail,
    };
    let metricCall = 0;
    const fetcher: typeof fetch = async (input) => {
      if (!String(input).endsWith("/graphql")) {
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }
      metricCall += 1;
      if (metricCall === 1) {
        return new Response("analytics unavailable", { status: 503 });
      }
      const workerRequests = metricCall === 2 ? 0 : 1_080_000;
      return Response.json({
        data: {
          viewer: {
            accounts: [{
              workersInvocationsAdaptive: [{
                sum: { requests: workerRequests, cpuTimeUs: 0 },
              }],
              r2OperationsAdaptiveGroups: [],
              r2StorageAdaptiveGroups: [],
            }],
          },
        },
      });
    };

    for (const timestamp of [
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:05:00.000Z",
      "2026-08-01T00:10:00.000Z",
    ]) {
      await runCostGuard(env, {
        fetcher,
        now: () => new Date(timestamp),
      });
    }

    expect(subjects).toEqual([
      "[Meoing staging] Cost Guard metrics warning",
      "[Meoing staging] Cost Guard usage warning",
    ]);
    const persisted = storage.read<CostGuardState>("cost-guard/state.json");
    expect(persisted.metricsWarningAttemptedAt).not.toBeNull();
    expect(persisted.warningAttemptedAt).not.toBeNull();
  });
});

function resumeCloudflareApi(initiallyAttached = false) {
  let attached = initiallyAttached;
  let attachCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/graphql")) {
      return Response.json({
        data: {
          viewer: {
            accounts: [{
              workersInvocationsAdaptive: [{
                sum: { requests: 0, cpuTimeUs: 0 },
              }],
              r2OperationsAdaptiveGroups: [],
              r2StorageAdaptiveGroups: [],
            }],
          },
        },
      });
    }
    if (url.endsWith("/workers/domains") && (init?.method ?? "GET") === "GET") {
      const result = attached
        ? [{
            id: protectedDomainRecord.domainId,
            hostname: protectedDomainRecord.hostname,
            service: protectedDomainRecord.service,
            zone_id: protectedDomainRecord.zoneId,
            zone_name: protectedDomainRecord.zoneName,
          }]
        : [];
      return Response.json({
        success: true,
        result,
        result_info: { count: result.length, total_count: result.length },
      });
    }
    if (url.endsWith("/workers/domains") && init?.method === "PUT") {
      attachCalls += 1;
      attached = true;
      return Response.json({ success: true, result: null });
    }
    if (url.endsWith("/workers/domains/api-domain") && init?.method === "DELETE") {
      attached = false;
      return Response.json({ success: true, result: null });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  };
  return {
    fetcher,
    isAttached: (): boolean => attached,
    attachCalls: (): number => attachCalls,
  };
}

describe("durable resume claim", () => {
  it("allows only one overlapping Cron to attach after winning the state CAS", async () => {
    let arrivals = 0;
    let release!: () => void;
    const bothClaimsReached = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = memoryStateBucket({
      state: stoppedResumeState(),
      request: queuedResumeRequest(),
      async beforeStatePut(state) {
        if (state.status === "STOPPED" && state.resumeClaim !== null) {
          arrivals += 1;
          if (arrivals === 2) release();
          await bothClaimsReached;
        }
      },
    });
    const cloudflare = resumeCloudflareApi();
    const env = resumeEnvironment(storage.bucket);
    let attempt = 0;
    const results = await Promise.allSettled([
      runCostGuard(env, {
        fetcher: cloudflare.fetcher,
        now: () => new Date("2026-08-01T00:05:00.000Z"),
        newResumeAttemptId: () => `attempt-${++attempt}`,
      }),
      runCostGuard(env, {
        fetcher: cloudflare.fetcher,
        now: () => new Date("2026-08-01T00:05:00.000Z"),
        newResumeAttemptId: () => `attempt-${++attempt}`,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(cloudflare.attachCalls()).toBe(1);
    expect(storage.read<CostGuardState>("cost-guard/state.json").status).toBe("NORMAL");
  });

  it("recovers idempotently after attach succeeds but the final state write crashes", async () => {
    let failFinalWrite = true;
    const storage = memoryStateBucket({
      state: stoppedResumeState(),
      request: queuedResumeRequest(),
      async beforeStatePut(state) {
        if (state.status === "NORMAL" && failFinalWrite) {
          failFinalWrite = false;
          throw new Error("simulated crash before final state write");
        }
      },
    });
    const cloudflare = resumeCloudflareApi();
    const env = resumeEnvironment(storage.bucket);

    await expect(runCostGuard(env, {
      fetcher: cloudflare.fetcher,
      now: () => new Date("2026-08-01T00:05:00.000Z"),
      newResumeAttemptId: () => "attempt-before-crash",
    })).rejects.toThrow(/simulated crash/);

    const claimed = storage.read<CostGuardState>("cost-guard/state.json");
    expect(claimed.status).toBe("STOPPED");
    expect(claimed.resumeClaim?.workflowRunId).toBe("2001");
    expect(cloudflare.isAttached()).toBe(true);
    expect(storage.has("cost-guard/resume-request.json")).toBe(true);

    const recovered = await runCostGuard(env, {
      fetcher: cloudflare.fetcher,
      now: () => new Date("2026-08-01T00:10:00.000Z"),
      newResumeAttemptId: () => "attempt-after-crash",
    });
    expect(recovered.status).toBe("NORMAL");
    expect(recovered.resumeClaim).toBeNull();
    expect(cloudflare.attachCalls()).toBe(1);
    expect(storage.has("cost-guard/resume-request.json")).toBe(false);
  });

  it("does not attach for a leftover marker replayed after a later stop", async () => {
    const state = stoppedResumeState();
    state.stoppedAt = "2026-08-01T00:12:00.000Z";
    state.resumeWorkflowRunId = "2001";
    const storage = memoryStateBucket({
      state,
      request: queuedResumeRequest(),
    });
    const cloudflare = resumeCloudflareApi();
    const result = await runCostGuard(resumeEnvironment(storage.bucket), {
      fetcher: cloudflare.fetcher,
      now: () => new Date("2026-08-01T00:15:00.000Z"),
      newResumeAttemptId: () => "must-not-be-used",
    });

    expect(result.status).toBe("STOPPED");
    expect(cloudflare.attachCalls()).toBe(0);
    expect(storage.has("cost-guard/resume-request.json")).toBe(false);
  });
});

describe("notification and STOP idempotency", () => {
  it("sends warning then stop once and never detaches outside the allowlist", async () => {
    const objects = new Map<string, { body: string; etag: string }>();
    let etagSequence = 0;
    const stateBucket = {
      async get(key: string) {
        const stored = objects.get(key);
        if (stored === undefined) return null;
        return {
          etag: stored.etag,
          json: async () => JSON.parse(stored.body) as unknown,
        } as unknown as R2ObjectBody;
      },
      async put(key: string, value: unknown, options?: R2PutOptions) {
        const existing = objects.get(key);
        const condition = options?.onlyIf;
        if (
          condition instanceof Headers &&
          condition.get("if-none-match") === "*" &&
          existing !== undefined
        ) {
          return null;
        }
        if (
          condition !== undefined &&
          !(condition instanceof Headers) &&
          condition.etagMatches !== undefined &&
          existing?.etag !== condition.etagMatches
        ) {
          return null;
        }
        if (typeof value !== "string") throw new Error("Expected JSON state string");
        const etag = `etag-${++etagSequence}`;
        objects.set(key, { body: value, etag });
        return { etag } as R2Object;
      },
      async delete(key: string) {
        objects.delete(key);
      },
    } as unknown as R2Bucket;

    const subjects: string[] = [];
    const email = {
      async send(message: EmailMessageBuilder) {
        subjects.push(message.subject);
        return {} as EmailSendResult;
      },
    } as SendEmail;

    let metricCall = 0;
    let protectedDomainAttached = true;
    const deletedDomainIds: string[] = [];
    const requestValues = [1_080_000, 1_282_500, 1_282_500];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/graphql")) {
        const workerRequests = requestValues[metricCall++] ?? 1_282_500;
        return Response.json({
          data: {
            viewer: {
              accounts: [{
                workersInvocationsAdaptive: [{
                  sum: { requests: workerRequests, cpuTimeUs: 0 },
                }],
                r2OperationsAdaptiveGroups: [],
                r2StorageAdaptiveGroups: [],
              }],
            },
          },
        });
      }
      if (url.endsWith("/workers/domains") && (init?.method ?? "GET") === "GET") {
        const result = protectedDomainAttached
          ? [{
              id: "api-domain",
              hostname: "api-staging.meoing.com",
              service: "meoing-api-staging",
              zone_id: "zone-1",
              zone_name: "meoing.com",
            }, {
              id: "web-domain",
              hostname: "staging.meoing.com",
              service: "meoing-web-staging",
              zone_id: "zone-1",
              zone_name: "meoing.com",
            }]
          : [{
              id: "web-domain",
              hostname: "staging.meoing.com",
              service: "meoing-web-staging",
              zone_id: "zone-1",
              zone_name: "meoing.com",
            }];
        return Response.json({
          success: true,
          result,
          result_info: { count: result.length, total_count: result.length },
        });
      }
      if (url.endsWith("/workers/domains/api-domain") && init?.method === "DELETE") {
        protectedDomainAttached = false;
        deletedDomainIds.push("api-domain");
        return Response.json({ success: true, result: null });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    };

    const env = {
      STATE: stateBucket,
      ALERT_EMAIL: email,
      APP_ENV: "staging",
      CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
      BILLING_CYCLE_ANCHOR_DAY_UTC: "30",
      WORKERS_REQUEST_GUARD_LIMIT: "1350000",
      WORKERS_INCLUDED_CPU_MS: "30000000",
      R2_INCLUDED_CLASS_A_OPERATIONS: "1000000",
      R2_INCLUDED_CLASS_B_OPERATIONS: "10000000",
      R2_INCLUDED_STORAGE_BYTES: "10000000000",
      PROTECTED_CUSTOM_DOMAINS:
        "[{\"hostname\":\"api-staging.meoing.com\",\"service\":\"meoing-api-staging\"}]",
      ALERT_FROM: "no-reply@auth.meoing.com",
      ALERT_RECIPIENT: "verified-recipient@example.com",
      CLOUDFLARE_COST_GUARD_TOKEN: "x".repeat(40),
    } satisfies CostGuardEnv;

    const times = [
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:05:00.000Z"),
      new Date("2026-08-01T00:10:00.000Z"),
    ];
    for (const now of times) {
      await runCostGuard(env, { fetcher, now: () => now });
    }

    expect(subjects).toEqual([
      "[Meoing staging] Cost Guard usage warning",
      "[Meoing staging] Cost Guard STOPPED",
    ]);
    expect(deletedDomainIds).toEqual(["api-domain"]);
    const persisted = JSON.parse(objects.get("cost-guard/state.json")!.body);
    expect(persisted.status).toBe("STOPPED");
    expect(persisted.detachPending).toBe(false);
    expect(persisted.warningAttemptedAt).not.toBeNull();
    expect(persisted.stopNotificationAttemptedAt).not.toBeNull();
  });
});
