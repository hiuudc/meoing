import type { CostGuardLimits, ProtectedDomain } from "./model";

const STAGING_SIMULATION_DOMAINS: readonly ProtectedDomain[] = [
  {
    hostname: "api-staging.meoing.com",
    service: "meoing-api-staging",
  },
];

const PRODUCTION_CONTROLLER_DOMAINS: readonly ProtectedDomain[] = [
  ...STAGING_SIMULATION_DOMAINS,
  {
    hostname: "api.meoing.com",
    service: "meoing-api-production",
  },
];

export interface CostGuardConfig {
  environment: string;
  accountId: string;
  apiToken: string;
  billingAnchorDay: number;
  limits: CostGuardLimits;
  protectedDomains: ProtectedDomain[];
  alertFrom: string;
  alertRecipient: string;
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function emailAddress(value: string, name: string): string {
  const normalized = value.trim();
  if (
    normalized !== value ||
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new Error(`${name} must be one email address`);
  }
  return normalized;
}

function parseProtectedDomains(raw: string): ProtectedDomain[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PROTECTED_CUSTOM_DOMAINS must be valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new Error("PROTECTED_CUSTOM_DOMAINS must contain one or two entries");
  }

  const domains = value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("Each protected domain must be an object");
    }
    const hostname = Reflect.get(item, "hostname");
    const service = Reflect.get(item, "service");
    if (
      typeof hostname !== "string" ||
      hostname !== hostname.toLowerCase() ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) ||
      hostname.includes("*") ||
      typeof service !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(service)
    ) {
      throw new Error("Protected domains require exact lowercase hostname/service values");
    }
    return { hostname, service };
  });

  if (new Set(domains.map(({ hostname }) => hostname)).size !== domains.length) {
    throw new Error("Protected domain hostnames must be unique");
  }
  return domains;
}

function domainKey(domain: ProtectedDomain): string {
  return `${domain.hostname}\u0000${domain.service}`;
}

export function assertCostGuardControllerTopology(
  environment: string,
  domains: readonly ProtectedDomain[],
): void {
  const expected =
    environment === "production"
      ? PRODUCTION_CONTROLLER_DOMAINS
      : environment === "staging"
        ? STAGING_SIMULATION_DOMAINS
        : null;
  if (expected === null) return;

  const actualKeys = [...domains].map(domainKey).sort();
  const expectedKeys = [...expected].map(domainKey).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(
      environment === "production"
        ? "Production Cost Guard must be the account-wide singleton for both Meoing API domains"
        : "Staging Cost Guard simulation must target only the staging API domain",
    );
  }
}

export function parseCostGuardConfig(env: CostGuardEnv): CostGuardConfig {
  const billingAnchorDay = Number(env.BILLING_CYCLE_ANCHOR_DAY_UTC);
  if (
    !Number.isInteger(billingAnchorDay) ||
    billingAnchorDay < 1 ||
    billingAnchorDay > 31
  ) {
    throw new Error("BILLING_CYCLE_ANCHOR_DAY_UTC must be an integer from 1 to 31");
  }
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID");
  }
  if (env.CLOUDFLARE_COST_GUARD_TOKEN.trim().length < 20) {
    throw new Error("CLOUDFLARE_COST_GUARD_TOKEN is missing");
  }

  const protectedDomains = parseProtectedDomains(env.PROTECTED_CUSTOM_DOMAINS);
  assertCostGuardControllerTopology(env.APP_ENV, protectedDomains);

  return {
    environment: env.APP_ENV,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_COST_GUARD_TOKEN,
    billingAnchorDay,
    limits: {
      workerRequests: positiveNumber(
        env.WORKERS_REQUEST_GUARD_LIMIT,
        "WORKERS_REQUEST_GUARD_LIMIT",
      ),
      workerCpuMs: positiveNumber(
        env.WORKERS_INCLUDED_CPU_MS,
        "WORKERS_INCLUDED_CPU_MS",
      ),
      r2ClassAOperations: positiveNumber(
        env.R2_INCLUDED_CLASS_A_OPERATIONS,
        "R2_INCLUDED_CLASS_A_OPERATIONS",
      ),
      r2ClassBOperations: positiveNumber(
        env.R2_INCLUDED_CLASS_B_OPERATIONS,
        "R2_INCLUDED_CLASS_B_OPERATIONS",
      ),
      r2StorageBytes: positiveNumber(
        env.R2_INCLUDED_STORAGE_BYTES,
        "R2_INCLUDED_STORAGE_BYTES",
      ),
    },
    protectedDomains,
    alertFrom: emailAddress(env.ALERT_FROM, "ALERT_FROM"),
    alertRecipient: emailAddress(env.ALERT_RECIPIENT, "ALERT_RECIPIENT"),
  };
}
