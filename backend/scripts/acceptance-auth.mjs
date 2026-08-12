import {
  parseResponseBody,
  resolveUrl,
  sleep,
} from "./acceptance-helpers.mjs";

const DEFAULT_REQUEST_INTERVAL_MS = 2_100;
const DEFAULT_MAXIMUM_ATTEMPTS = 8;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAXIMUM_DELAY_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function retryAfterMilliseconds(value, nowMilliseconds = Date.now()) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - nowMilliseconds);
}

export function acceptanceAuthRetryDelay({
  attempt,
  random = Math.random,
  retryAfter,
  retryBaseDelayMilliseconds = DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaximumDelayMilliseconds = DEFAULT_RETRY_MAXIMUM_DELAY_MS,
  nowMilliseconds = Date.now(),
}) {
  const exponentialDelay = Math.min(
    retryMaximumDelayMilliseconds,
    retryBaseDelayMilliseconds * (2 ** Math.max(0, attempt - 1)),
  );
  const jitterRange = Math.min(500, Math.max(1, Math.floor(exponentialDelay / 4)));
  const jitter = Math.floor(random() * jitterRange);
  const fallbackDelay = Math.min(
    retryMaximumDelayMilliseconds,
    exponentialDelay + jitter,
  );
  const serverDelay = retryAfterMilliseconds(retryAfter, nowMilliseconds);

  if (serverDelay !== null && serverDelay > retryMaximumDelayMilliseconds) {
    return null;
  }
  return Math.max(fallbackDelay, serverDelay ?? 0);
}

export async function acquirePasswordAccessTokens({
  fetchImplementation = fetch,
  maximumAttempts = DEFAULT_MAXIMUM_ATTEMPTS,
  now = Date.now,
  onProgress = () => {},
  onRetry = () => {},
  onTokenAcquired = () => {},
  passwordUsers,
  publishableKey,
  random = Math.random,
  requestIntervalMilliseconds = DEFAULT_REQUEST_INTERVAL_MS,
  requestTimeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MS,
  retryBaseDelayMilliseconds = DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaximumDelayMilliseconds = DEFAULT_RETRY_MAXIMUM_DELAY_MS,
  supabaseUrl,
  wait = sleep,
}) {
  let lastRequestStartedAt = null;

  async function paceRequest() {
    if (lastRequestStartedAt !== null) {
      const remaining = lastRequestStartedAt + requestIntervalMilliseconds - now();
      if (remaining > 0) await wait(remaining);
    }
    lastRequestStartedAt = now();
  }

  async function signIn({ email, password }) {
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      await paceRequest();
      const response = await fetchImplementation(
        resolveUrl(supabaseUrl, "/auth/v1/token?grant_type=password"),
        {
          method: "POST",
          headers: {
            apikey: publishableKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email, password }),
          signal: AbortSignal.timeout(requestTimeoutMilliseconds),
        },
      );
      const payload = await parseResponseBody(response);

      if (response.ok && typeof payload?.access_token === "string") {
        return payload.access_token;
      }
      if (response.status !== 429 || attempt === maximumAttempts) {
        throw new Error(
          `Supabase acceptance test-account sign-in failed with HTTP ${response.status}`,
        );
      }

      const delayMilliseconds = acceptanceAuthRetryDelay({
        attempt,
        nowMilliseconds: now(),
        random,
        retryAfter: response.headers.get("retry-after"),
        retryBaseDelayMilliseconds,
        retryMaximumDelayMilliseconds,
      });
      if (delayMilliseconds === null) {
        throw new Error(
          "Supabase acceptance test-account sign-in returned Retry-After beyond the retry window",
        );
      }
      onRetry({ attempt, delayMilliseconds, maximumAttempts });
      await wait(delayMilliseconds);
    }

    throw new Error("Supabase acceptance test-account sign-in exhausted retry attempts");
  }

  const tokens = [];
  for (let offset = 0; offset < passwordUsers.length; offset += 1) {
    const token = await signIn(passwordUsers[offset]);
    tokens.push(token);
    onTokenAcquired({ token });
    onProgress({ completed: offset + 1, total: passwordUsers.length });
  }
  return tokens;
}
