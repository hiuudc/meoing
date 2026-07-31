import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppBindings } from "../app-types";

export type ErrorCode =
  | "ACCOUNT_DELETION_PENDING"
  | "AUTH_REQUIRED"
  | "BODY_TOO_LARGE"
  | "CONFLICT"
  | "EMAIL_NOT_VERIFIED"
  | "FILE_CHECKSUM_MISMATCH"
  | "FILE_INVALID_TYPE"
  | "FILE_NOT_READY"
  | "FORBIDDEN"
  | "INTERNAL_ERROR"
  | "INVALID_CURSOR"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "REVISION_CONFLICT"
  | "USERNAME_COOLDOWN"
  | "USERNAME_RESERVED"
  | `${string}_FORBIDDEN`
  | `${string}_NOT_FOUND`
  | `INVALID_${string}`
  | `${string}_LIMIT`
  | `${string}_QUOTA`
  | "ACCOUNT_NOT_READY"
  | "DELETION_NOT_CANCELABLE"
  | "INVITE_INVALID"
  | "MISSING_PERMISSION"
  | "OWNER_REQUIRED"
  | "ROLE_HIERARCHY_VIOLATION"
  | "UNIT_CONTENT_REPLACEMENT_REQUIRED";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly internalCode?: string;
  readonly status: ContentfulStatusCode;
  readonly details?: Record<string, unknown>;

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    internalCode?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.internalCode = internalCode;
  }
}

interface DatabaseErrorLike extends Error {
  readonly code: string;
}

function isDatabaseError(error: unknown): error is DatabaseErrorLike {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

const APPLICATION_ERROR = /^(?<code>[A-Z][A-Z0-9_]+)\|(?<message>.+)$/s;
const BARE_APPLICATION_ERROR = /^[A-Z][A-Z0-9_]+$/;
const CONFLICT_CODES = new Set([
  "AUDIT_LOG_IS_APPEND_ONLY",
  "COLLECTION_DELETED",
  "COLLECTION_NOT_RESTORABLE",
  "DELETION_NOT_CANCELABLE",
  "FILE_IS_REFERENCED",
  "IDEMPOTENCY_KEY_REUSED",
  "LESSON_CONTENT_IS_IMMUTABLE",
  "MANAGED_ROLE_CANNOT_BE_DELETED",
  "MANAGED_ROLE_IDENTITY_IS_IMMUTABLE",
  "NEW_OWNER_MUST_BE_MEMBER",
  "OWNER_CANNOT_BE_REMOVED",
  "OWNER_CANNOT_LEAVE",
  "OWNERSHIP_TRANSFER_REQUIRED",
  "PROGRESS_ALREADY_CLOSED",
  "UNIT_DELETED",
  "UNIT_NOT_RESTORABLE",
  "UPLOAD_EXPIRED",
]);
const FORBIDDEN_CODES = new Set([
  "AUDIT_LOG_IS_APPEND_ONLY",
  "MAINTENANCE_ROLE_REQUIRED",
  "MISSING_PERMISSION",
  "OWNER_REQUIRED",
  "ROLE_HIERARCHY_VIOLATION",
]);
const INVALID_CODES = new Set([
  "AVATAR_ASSET_INVALID",
  "DUPLICATE_PROGRESS_EVENT",
  "UNIT_CONTENT_REPLACEMENT_REQUIRED",
]);

function applicationError(code: string): ApiError | null {
  if (code === "REVISION_CONFLICT") {
    return new ApiError(
      409,
      "REVISION_CONFLICT",
      "The resource changed; reload it and try again",
    );
  }
  if (code === "USERNAME_CHANGE_COOLDOWN") {
    return new ApiError(
      409,
      "USERNAME_COOLDOWN",
      "Username can only be changed once every 7 days",
    );
  }
  if (code === "USERNAME_UNAVAILABLE") {
    return new ApiError(409, "USERNAME_RESERVED", "That username is unavailable");
  }
  if (code === "ACCOUNT_LOCKED") {
    return new ApiError(
      423,
      "ACCOUNT_DELETION_PENDING",
      "Account deletion is pending; cancel it before using the application",
    );
  }
  if (code === "ACCOUNT_NOT_READY") {
    return new ApiError(
      403,
      "ACCOUNT_NOT_READY",
      "Complete account verification and onboarding before using this endpoint",
    );
  }
  if (code === "AUTH_REQUIRED") {
    return new ApiError(401, "AUTH_REQUIRED", "Authentication is required");
  }
  if (code === "EMAIL_NOT_VERIFIED") {
    return new ApiError(403, "EMAIL_NOT_VERIFIED", "Email verification is required");
  }
  if (code === "INVITE_INVALID" || code === "LESSON_NOT_AVAILABLE") {
    return new ApiError(404, code as ErrorCode, "The requested resource was not found");
  }
  if (code === "PROGRESS_TOO_LARGE") {
    return new ApiError(413, "BODY_TOO_LARGE", "The progress record is too large");
  }
  if (code.endsWith("_NOT_FOUND") || code === "REVISION_NOT_FOUND") {
    return new ApiError(404, code as ErrorCode, "The requested resource was not found");
  }
  if (
    code.endsWith("_FORBIDDEN") ||
    FORBIDDEN_CODES.has(code)
  ) {
    return new ApiError(403, code as ErrorCode, "You do not have permission for this action");
  }
  if (
    code.startsWith("INVALID_") ||
    INVALID_CODES.has(code)
  ) {
    return new ApiError(400, code as ErrorCode, "The request is invalid");
  }
  if (code.endsWith("_LIMIT") || code.endsWith("_QUOTA")) {
    return new ApiError(429, code as ErrorCode, "The request quota has been reached; retry later");
  }
  if (CONFLICT_CODES.has(code)) {
    return new ApiError(409, code as ErrorCode, "The requested change conflicts with current data");
  }
  return null;
}

export function mapDatabaseError(error: unknown): ApiError {
  if (!isDatabaseError(error)) {
    return new ApiError(500, "INTERNAL_ERROR", "An unexpected database error occurred");
  }

  const legacyApplication = APPLICATION_ERROR.exec(error.message);
  const applicationCode = legacyApplication?.groups?.code ??
    (BARE_APPLICATION_ERROR.test(error.message) ? error.message : undefined);
  if (applicationCode) {
    const mapped = applicationError(applicationCode);
    if (mapped) {
      return new ApiError(
        mapped.status,
        mapped.code,
        mapped.message,
        mapped.details,
        error.code,
      );
    }
  }

  const databaseError = (
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
  ): ApiError => new ApiError(status, code, message, undefined, error.code);

  switch (error.code) {
    case "22023":
      return databaseError(400, "INVALID_REQUEST", "The request is invalid");
    case "28000":
      return databaseError(401, "AUTH_REQUIRED", "Authentication is required");
    case "40001":
      return databaseError(
        409,
        "REVISION_CONFLICT",
        "The resource changed; reload it and try again",
      );
    case "54000":
      return databaseError(
        429,
        "RATE_LIMITED",
        "The request quota has been reached; retry later",
      );
    case "23505":
    case "23503":
    case "23514":
      return databaseError(
        409,
        "CONFLICT",
        "The requested change conflicts with current data",
      );
    case "42501":
      return databaseError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    case "57014":
      return databaseError(503, "INTERNAL_ERROR", "The database operation timed out");
    case "57P03":
      return databaseError(
        503,
        "INTERNAL_ERROR",
        "The database identity could not be verified",
      );
    case "53300":
      return databaseError(
        503,
        "INTERNAL_ERROR",
        "The database is temporarily unavailable",
      );
    default:
      return databaseError(500, "INTERNAL_ERROR", "An unexpected database error occurred");
  }
}

export function errorResponse(c: Context<AppBindings>, error: ApiError): Response {
  const requestId = c.get("requestState")?.requestId ?? c.res.headers.get("x-request-id") ?? "unknown";
  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        requestId,
      },
    },
    error.status,
  );
}
