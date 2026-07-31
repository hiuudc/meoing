import type { DetachedDomain, ProtectedDomain } from "./model";

interface CloudflareDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  result_info?: { count?: number; total_count?: number };
}

function isDomain(value: unknown): value is CloudflareDomain {
  if (typeof value !== "object" || value === null) return false;
  const domain = value as Partial<CloudflareDomain>;
  return (
    typeof domain.id === "string" &&
    typeof domain.hostname === "string" &&
    typeof domain.service === "string" &&
    typeof domain.zone_id === "string" &&
    typeof domain.zone_name === "string"
  );
}

async function apiRequest<T>(input: {
  fetcher: typeof fetch;
  accountId: string;
  apiToken: string;
  path: string;
  method?: "GET" | "PUT" | "DELETE";
  body?: unknown;
  allowNotFound?: boolean;
}): Promise<ApiEnvelope<T> | null> {
  const response = await input.fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${input.accountId}${input.path}`,
    {
      method: input.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiToken}`,
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    },
  );
  if (input.allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Cloudflare API returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as Partial<ApiEnvelope<T>>;
  if (payload.success !== true || payload.result === undefined) {
    throw new Error("Cloudflare API returned an unsuccessful envelope");
  }
  return payload as ApiEnvelope<T>;
}

export async function listWorkerDomains(input: {
  fetcher: typeof fetch;
  accountId: string;
  apiToken: string;
}): Promise<CloudflareDomain[]> {
  const envelope = await apiRequest<unknown[]>({
    ...input,
    path: "/workers/domains",
  });
  if (envelope === null || !Array.isArray(envelope.result)) {
    throw new Error("Cloudflare domains response is invalid");
  }
  if (
    typeof envelope.result_info?.total_count === "number" &&
    envelope.result_info.total_count !== envelope.result.length
  ) {
    throw new Error("Cloudflare domains response was unexpectedly paginated");
  }
  if (!envelope.result.every(isDomain)) {
    throw new Error("Cloudflare domains response contains an invalid domain");
  }
  return envelope.result;
}

export function selectProtectedDomains(
  domains: readonly CloudflareDomain[],
  allowlist: readonly ProtectedDomain[],
): DetachedDomain[] {
  const allowedByHostname = new Map(
    allowlist.map((domain) => [domain.hostname, domain.service]),
  );
  const selected: DetachedDomain[] = [];

  for (const domain of domains) {
    const allowedService = allowedByHostname.get(domain.hostname);
    if (allowedService === undefined) continue;
    if (domain.service !== allowedService) {
      throw new Error(
        `Protected hostname ${domain.hostname} is mapped to an unexpected Worker`,
      );
    }
    selected.push({
      domainId: domain.id,
      hostname: domain.hostname,
      service: domain.service,
      zoneId: domain.zone_id,
      zoneName: domain.zone_name,
    });
  }

  if (new Set(selected.map(({ hostname }) => hostname)).size !== selected.length) {
    throw new Error("Cloudflare returned duplicate protected hostnames");
  }
  return selected;
}

export async function detachWorkerDomain(input: {
  fetcher: typeof fetch;
  accountId: string;
  apiToken: string;
  domainId: string;
}): Promise<void> {
  await apiRequest<unknown>({
    ...input,
    path: `/workers/domains/${encodeURIComponent(input.domainId)}`,
    method: "DELETE",
    allowNotFound: true,
  });
}

export async function attachWorkerDomain(input: {
  fetcher: typeof fetch;
  accountId: string;
  apiToken: string;
  domain: DetachedDomain;
}): Promise<void> {
  await apiRequest<unknown>({
    ...input,
    path: "/workers/domains",
    method: "PUT",
    body: {
      hostname: input.domain.hostname,
      service: input.domain.service,
      zone_id: input.domain.zoneId,
    },
  });
}

export function validateResumeDomains(input: {
  current: readonly CloudflareDomain[];
  detached: readonly DetachedDomain[];
  allowlist: readonly ProtectedDomain[];
}): DetachedDomain[] {
  const allowlistByHostname = new Map(
    input.allowlist.map((domain) => [domain.hostname, domain.service]),
  );
  const currentByHostname = new Map(
    input.current.map((domain) => [domain.hostname, domain]),
  );
  const missing: DetachedDomain[] = [];

  for (const domain of input.detached) {
    if (allowlistByHostname.get(domain.hostname) !== domain.service) {
      throw new Error("Stopped domain is no longer in the strict allowlist");
    }
    const current = currentByHostname.get(domain.hostname);
    if (current === undefined) {
      missing.push(domain);
    } else if (current.service !== domain.service) {
      throw new Error("Protected hostname is attached to an unexpected Worker");
    }
  }
  return missing;
}
