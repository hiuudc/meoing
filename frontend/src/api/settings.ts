import { ApiError, type ApiClient } from "./client";

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

interface SettingWriteWaiter {
  resolve: (record: SettingRecord) => void;
  reject: (error: unknown) => void;
}

interface PendingSettingWrite {
  value: unknown;
  waiters: SettingWriteWaiter[];
}

interface SettingWriteQueue {
  running: boolean;
  pending: PendingSettingWrite | null;
  target: SettingsTarget;
  key: string;
}

const settingWriteQueues = new WeakMap<ApiClient, Map<string, SettingWriteQueue>>();

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

function settingQueueKey(target: SettingsTarget, key: string): string {
  return `${target.scope}:${target.collectionId ?? ""}:${key}`;
}

async function writeSetting(
  api: ApiClient,
  target: SettingsTarget,
  key: string,
  value: unknown,
): Promise<SettingRecord> {
  async function attempt(): Promise<SettingRecord> {
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

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "REVISION_CONFLICT") throw error;
    return attempt();
  }
}

async function drainSettingQueue(
  api: ApiClient,
  queueMap: Map<string, SettingWriteQueue>,
  queueId: string,
  queue: SettingWriteQueue,
): Promise<void> {
  if (queue.running) return;
  queue.running = true;
  try {
    while (queue.pending) {
      const current = queue.pending;
      queue.pending = null;
      try {
        const record = await writeSetting(api, queue.target, queue.key, current.value);
        current.waiters.forEach(({ resolve }) => resolve(record));
      } catch (error) {
        current.waiters.forEach(({ reject }) => reject(error));
      }
    }
  } finally {
    queue.running = false;
    if (!queue.pending) queueMap.delete(queueId);
    else void drainSettingQueue(api, queueMap, queueId, queue);
  }
}

export function upsertSetting(
  api: ApiClient,
  target: SettingsTarget,
  key: string,
  value: unknown,
): Promise<SettingRecord> {
  let queueMap = settingWriteQueues.get(api);
  if (!queueMap) {
    queueMap = new Map();
    settingWriteQueues.set(api, queueMap);
  }
  const queueId = settingQueueKey(target, key);
  let queue = queueMap.get(queueId);
  if (!queue) {
    queue = { running: false, pending: null, target: { ...target }, key };
    queueMap.set(queueId, queue);
  }

  const result = new Promise<SettingRecord>((resolve, reject) => {
    if (queue.pending) {
      queue.pending.value = value;
      queue.pending.waiters.push({ resolve, reject });
    } else {
      queue.pending = { value, waiters: [{ resolve, reject }] };
    }
  });
  void drainSettingQueue(api, queueMap, queueId, queue);
  return result;
}
