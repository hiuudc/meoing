import type { ApiClient } from "./client";

export type SettingsScope = "user" | "collection" | "collection_user";

export interface SettingRecord {
  key: string;
  value: unknown;
  revision: number;
  updatedAt?: string;
}

interface SettingsResponse {
  items: SettingRecord[];
}

export interface SettingsTarget {
  scope: SettingsScope;
  collectionId?: string;
}

function settingsQuery(target: SettingsTarget, key?: string): string {
  const query = new URLSearchParams({ scope: target.scope });
  if (target.collectionId) query.set("collectionId", target.collectionId);
  if (key) query.set("key", key);
  return query.toString();
}

export async function readSettings(
  api: ApiClient,
  target: SettingsTarget,
): Promise<SettingRecord[]> {
  const response = await api.get<SettingsResponse>(`/v1/settings?${settingsQuery(target)}`);
  return response.data.items;
}

export function settingsValues(records: readonly SettingRecord[]): Record<string, unknown> {
  return Object.fromEntries(records.map((record) => [record.key, record.value]));
}

export async function upsertSetting(
  api: ApiClient,
  target: SettingsTarget,
  key: string,
  value: unknown,
): Promise<SettingRecord> {
  const current = await api.get<SettingsResponse>(
    `/v1/settings?${settingsQuery(target, key)}`,
  );
  const existing = current.data.items.find((record) => record.key === key);
  const response = await api.put<SettingRecord>("/v1/settings", {
    ...target,
    key,
    value,
    expectedRevision: existing?.revision ?? 0,
  });
  return response.data;
}
