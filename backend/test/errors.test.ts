import { describe, expect, it } from "vitest";
import { mapDatabaseError } from "../src/http/errors";

function databaseError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("PostgreSQL application error mapping", () => {
  it.each([
    ["40001", "REVISION_CONFLICT", 409, "REVISION_CONFLICT"],
    ["P0001", "UNIT_NOT_FOUND", 404, "UNIT_NOT_FOUND"],
    ["42501", "MISSING_PERMISSION", 403, "MISSING_PERMISSION"],
    ["42501", "ROLE_HIERARCHY_VIOLATION", 403, "ROLE_HIERARCHY_VIOLATION"],
    ["22023", "INVALID_LESSON_TRACKING", 400, "INVALID_LESSON_TRACKING"],
    ["22023", "UNIT_CONTENT_REPLACEMENT_REQUIRED", 400, "UNIT_CONTENT_REPLACEMENT_REQUIRED"],
    ["54000", "UPLOAD_DAILY_QUOTA", 429, "UPLOAD_DAILY_QUOTA"],
    ["P0001", "USERNAME_CHANGE_COOLDOWN", 409, "USERNAME_COOLDOWN"],
    ["23505", "USERNAME_UNAVAILABLE", 409, "USERNAME_RESERVED"],
    ["42501", "ACCOUNT_LOCKED", 423, "ACCOUNT_DELETION_PENDING"],
  ])(
    "maps SQLSTATE %s and %s to HTTP %i",
    (sqlState, message, expectedStatus, expectedCode) => {
      const mapped = mapDatabaseError(databaseError(sqlState, message));
      expect(mapped.status).toBe(expectedStatus);
      expect(mapped.code).toBe(expectedCode);
    },
  );

  it("does not expose unknown PostgreSQL messages", () => {
    const mapped = mapDatabaseError(
      databaseError("P0001", "sensitive table detail from an unexpected function"),
    );
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.message).not.toContain("sensitive");
  });
});
