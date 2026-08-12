/**
 * Versioned, provider-neutral browser contract. It intentionally has no runtime
 * dependency so a private connector and the public app can consume it directly.
 * HTTP boundaries use their local Zod copy to produce OpenAPI documents.
 */
export const AI_OPERATION_CONTRACT_VERSION = 1 as const;

export const AI_PROVIDERS = ["api", "bridge"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_OPERATION_KINDS = [
  "create_lesson",
  "evaluate_answer",
  "coaching",
] as const;
export type AiOperationKind = (typeof AI_OPERATION_KINDS)[number];

export const AI_OPERATION_OUTCOMES = [
  "completed",
  "needs_source",
  "failed",
] as const;
export type AiOperationOutcome = (typeof AI_OPERATION_OUTCOMES)[number];

export interface AiConsent {
  version: typeof AI_OPERATION_CONTRACT_VERSION;
  grantedAt?: string;
}

export interface AiOperationRequest {
  contractVersion: typeof AI_OPERATION_CONTRACT_VERSION;
  operationId: string;
  kind: AiOperationKind;
  collectionId: string;
  unitId: string;
  input: Record<string, unknown>;
}

export interface AiOperationError {
  code: string;
  message: string;
}

export interface AiOperationResult {
  contractVersion: typeof AI_OPERATION_CONTRACT_VERSION;
  operationId: string;
  kind: AiOperationKind;
  outcome: AiOperationOutcome;
  result?: Record<string, unknown>;
  error?: AiOperationError;
}

export interface ContractSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: Error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseRequest(value: unknown): AiOperationRequest {
  if (!isRecord(value)
    || value.contractVersion !== AI_OPERATION_CONTRACT_VERSION
    || !uuid(value.operationId)
    || !uuid(value.collectionId)
    || !uuid(value.unitId)
    || !AI_OPERATION_KINDS.includes(value.kind as AiOperationKind)
    || !isRecord(value.input)) {
    throw new Error("Invalid AI operation request");
  }
  return value as unknown as AiOperationRequest;
}

function parseResult(value: unknown): AiOperationResult {
  if (!isRecord(value)
    || value.contractVersion !== AI_OPERATION_CONTRACT_VERSION
    || !uuid(value.operationId)
    || !AI_OPERATION_KINDS.includes(value.kind as AiOperationKind)
    || !AI_OPERATION_OUTCOMES.includes(value.outcome as AiOperationOutcome)) {
    throw new Error("Invalid AI operation result");
  }
  if (value.outcome === "failed") {
    if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
      throw new Error("Failed AI operation needs an error");
    }
  } else if (!isRecord(value.result)) {
    throw new Error("Successful AI operation needs a result");
  }
  return value as unknown as AiOperationResult;
}

function schema<T>(parser: (value: unknown) => T): ContractSchema<T> {
  return {
    parse: parser,
    safeParse(value) {
      try {
        return { success: true, data: parser(value) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error : new Error("Invalid value") };
      }
    },
  };
}

export const AiOperationRequestSchema = schema(parseRequest);
export const AiOperationResultSchema = schema(parseResult);

export const AiOperationFixtures = {
  createLesson: {
    contractVersion: AI_OPERATION_CONTRACT_VERSION,
    operationId: "11111111-1111-4111-8111-111111111111",
    kind: "create_lesson",
    collectionId: "22222222-2222-4222-8222-222222222222",
    unitId: "33333333-3333-4333-8333-333333333333",
    input: { customRequest: "Create a review lesson." },
  } satisfies AiOperationRequest,
} as const;
