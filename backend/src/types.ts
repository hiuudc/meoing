export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Actor {
  readonly userId: string;
  readonly email: string | null;
  readonly tokenId: string | null;
  readonly sessionId: string | null;
}

export interface RequestState {
  readonly requestId: string;
  readonly startedAt: number;
  actor: Actor | null;
  queryCount: number;
  databaseDurationMs: number;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value !== "object") {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

export function asJsonObject(value: unknown): JsonObject {
  if (!isJsonValue(value) || value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Expected a JSON object");
  }
  return value;
}
