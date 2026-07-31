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
    ["54000", "STORAGE_BUDGET_REACHED", 429, "STORAGE_BUDGET_REACHED"],
    ["P0001", "USERNAME_CHANGE_COOLDOWN", 409, "USERNAME_COOLDOWN"],
    ["23505", "USERNAME_UNAVAILABLE", 409, "USERNAME_RESERVED"],
    ["42501", "ACCOUNT_LOCKED", 423, "ACCOUNT_DELETION_PENDING"],
    ["57P03", "DATABASE_IDENTITY_MISMATCH", 503, "INTERNAL_ERROR"],
  ])(
    "maps SQLSTATE %s and %s to HTTP %i",
    (sqlState, message, expectedStatus, expectedCode) => {
      const mapped = mapDatabaseError(databaseError(sqlState, message));
      expect(mapped.status).toBe(expectedStatus);
      expect(mapped.code).toBe(expectedCode);
      expect(mapped.internalCode).toBe(sqlState);
    },
  );

  it("marks the storage budget failure as non-retryable", () => {
    const mapped = mapDatabaseError(databaseError("54000", "STORAGE_BUDGET_REACHED"));

    expect(mapped.details).toEqual({ retryable: false });
  });

  it("does not expose unknown PostgreSQL messages", () => {
    const mapped = mapDatabaseError(
      databaseError("P0001", "sensitive table detail from an unexpected function"),
    );
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.internalCode).toBe("P0001");
    expect(mapped.message).not.toContain("sensitive");
  });

  it("reports connection exhaustion as a temporary service failure", () => {
    const mapped = mapDatabaseError(
      databaseError("53300", "too many connections for role"),
    );

    expect(mapped.status).toBe(503);
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.internalCode).toBe("53300");
    expect(mapped.message).not.toContain("role");
  });
});
