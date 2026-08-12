import type { components } from "./generated";
import type { ApiClient, ApiSuccess } from "./client";

export type UnitRevisionSummary = components["schemas"]["UnitRevisionSummary"];
export type WireUnit = components["schemas"]["Unit"];

export interface UnitRevisionPage {
  items: UnitRevisionSummary[];
  nextCursor: string | null;
}

export function listUnitRevisions(
  api: ApiClient,
  unitId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<ApiSuccess<UnitRevisionPage>> {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);
  return api.get(
    `/v1/units/${encodeURIComponent(unitId)}/revisions?${query.toString()}`,
    signal,
  );
}

export function restoreUnitRevision(
  api: ApiClient,
  unitId: string,
  revision: number,
  expectedRevision: number,
): Promise<ApiSuccess<WireUnit>> {
  return api.post(
    `/v1/units/${encodeURIComponent(unitId)}/revisions/${revision}/restore`,
    { expectedRevision },
  );
}
