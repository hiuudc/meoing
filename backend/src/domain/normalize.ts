import { ApiError } from "../http/errors";
import type { JsonObject, JsonValue } from "../types";

export function normalizeStudyText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function normalizeMetadata(value: JsonValue): JsonValue {
  return typeof value === "string" ? normalizeStudyText(value) : value;
}

export function studySurface(value: JsonValue): string {
  if (typeof value === "string") {
    return normalizeStudyText(value);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.text === "string"
  ) {
    return normalizeStudyText(value.text);
  }
  throw new ApiError(
    400,
    "INVALID_REQUEST",
    "Study items must be strings or objects containing a text string",
  );
}

export function normalizeStudyList(values: readonly JsonValue[], field: string): JsonValue[] {
  const surfaces: string[] = [];
  const normalized = values.map((value) => {
    const surface = studySurface(value);
    if (surface.length === 0) {
      throw new ApiError(400, "INVALID_REQUEST", `${field} may not contain empty values`);
    }
    surfaces.push(surface);
    if (typeof value === "string") {
      return surface;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(400, "INVALID_REQUEST", `${field} contains an invalid study item`);
    }
    if (Object.hasOwn(value, "id")) {
      throw new ApiError(400, "INVALID_REQUEST", `${field} items may not contain ids`);
    }
    const result: JsonObject = { ...value, text: surface };
    if (result.translation !== undefined) {
      result.translation = normalizeMetadata(result.translation);
    }
    if (result.notes !== undefined) {
      result.notes = normalizeMetadata(result.notes);
    }
    return result;
  });
  const unique = new Set(surfaces);
  if (unique.size !== surfaces.length) {
    throw new ApiError(409, "CONFLICT", `${field} contains duplicate normalized surfaces`);
  }
  return normalized;
}
