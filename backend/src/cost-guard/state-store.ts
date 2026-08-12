import {
  COST_GUARD_RESUME_REQUEST_KEY,
  COST_GUARD_STATE_KEY,
  isCostGuardState,
  isResumeRequest,
  type CostGuardState,
  type ResumeRequest,
} from "./model";

export interface StoredState {
  state: CostGuardState | null;
  etag: string | null;
}

export async function loadState(bucket: R2Bucket): Promise<StoredState> {
  const object = await bucket.get(COST_GUARD_STATE_KEY);
  if (object === null) return { state: null, etag: null };
  const value: unknown = await object.json();
  if (!isCostGuardState(value)) {
    throw new Error("Cost Guard state is corrupt");
  }
  const hasSplitWarningMarkers =
    value.metricsWarningAttemptedAt !== undefined &&
    value.metricsWarningDeliveredAt !== undefined;
  // Optional-on-read fields keep state from the first release deploy-safe. Legacy
  // warning markers had no reason, so reset them once rather than risk treating a
  // metrics outage warning as the account-usage 80% warning.
  const state: CostGuardState = {
    ...value,
    warningAttemptedAt: hasSplitWarningMarkers ? value.warningAttemptedAt : null,
    warningDeliveredAt: hasSplitWarningMarkers ? value.warningDeliveredAt : null,
    metricsWarningAttemptedAt: value.metricsWarningAttemptedAt ?? null,
    metricsWarningDeliveredAt: value.metricsWarningDeliveredAt ?? null,
    resumeClaim: value.resumeClaim ?? null,
  };
  return { state, etag: object.etag };
}

export async function saveState(
  bucket: R2Bucket,
  state: CostGuardState,
  expectedEtag: string | null,
): Promise<string> {
  const onlyIf: R2Conditional | Headers =
    expectedEtag === null
      ? new Headers({ "if-none-match": "*" })
      : { etagMatches: expectedEtag };
  const result = await bucket.put(COST_GUARD_STATE_KEY, JSON.stringify(state), {
    onlyIf,
    httpMetadata: { contentType: "application/json" },
  });
  if (result === null) throw new Error("Concurrent Cost Guard state update detected");
  return result.etag;
}

export async function loadResumeRequest(
  bucket: R2Bucket,
): Promise<ResumeRequest | null> {
  const object = await bucket.get(COST_GUARD_RESUME_REQUEST_KEY);
  if (object === null) return null;
  const value: unknown = await object.json();
  if (!isResumeRequest(value)) {
    throw new Error("Cost Guard resume request is invalid");
  }
  return value;
}

export async function deleteResumeRequest(bucket: R2Bucket): Promise<void> {
  await bucket.delete(COST_GUARD_RESUME_REQUEST_KEY);
}
