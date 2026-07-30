import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function optionalEnvironment(name) {
  return process.env[name]?.trim() || undefined;
}

export function integerEnvironment(name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = optionalEnvironment(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function numberEnvironment(name, fallback, minimum = 0, maximum = Number.MAX_VALUE) {
  const raw = optionalEnvironment(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

export function booleanEnvironment(name, fallback = false) {
  const raw = optionalEnvironment(name);
  if (raw === undefined) return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

export function normalizedBaseUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}

export function resolveUrl(baseUrl, path) {
  return new URL(path.replace(/^\/+/, ""), baseUrl);
}

export async function passwordAccessToken({
  email,
  password,
  publishableKey,
  supabaseUrl,
}) {
  const response = await fetch(
    resolveUrl(supabaseUrl, "/auth/v1/token?grant_type=password"),
    {
      method: "POST",
      headers: {
        apikey: publishableKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = await parseResponseBody(response);
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new Error(`Supabase test-account sign-in failed with HTTP ${response.status}`);
  }
  return payload.access_token;
}

export async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { unparsed: true };
  }
}

export async function writeJsonSummary(path, summary) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export function percentile(values, percentage) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

export function latencySummary(values) {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
  };
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
