import {
  MEOI_EXTENSION_PROTOCOL_VERSION,
  MEOI_EXTENSION_SOURCE,
  MEOI_PAGE_SOURCE,
  MEOI_PROMPT_MAX_BYTES,
  type ExtensionRequest,
  type ExtensionResponse,
} from "../src/integration/protocol";
import { LESSON_QUESTION_FORMATS } from "../src/learning/types";
import { isAllowedMeoiOrigin } from "./integration-policy";

const commands = new Set([
  "SEND_OPERATION", "OPEN_VOICE", "GET_INTEGRATION_STATUS",
  "GET_UNIT_OPERATION", "GET_OPERATION_STATE", "RETRY_OPERATION", "ACK_OPERATION_RESULT", "RESET_UNIT_CHAT",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validRequest(value: unknown): value is ExtensionRequest<Record<string, unknown>> {
  if (!isRecord(value) || value.source !== MEOI_PAGE_SOURCE || value.version !== MEOI_EXTENSION_PROTOCOL_VERSION) return false;
  if (typeof value.nonce !== "string" || value.nonce.length < 10 || typeof value.requestId !== "string") return false;
  if (typeof value.command !== "string" || !commands.has(value.command) || !isRecord(value.payload)) return false;
  const payload = value.payload;
  if (["OPEN_VOICE", "RESET_UNIT_CHAT"].includes(value.command) && typeof payload.unitId !== "string") return false;
  if (value.command === "GET_UNIT_OPERATION"
    && (typeof payload.unitId !== "string"
      || (payload.kind !== undefined && !["create_lesson", "evaluate_answer", "coaching"].includes(String(payload.kind))))) return false;
  if (["GET_OPERATION_STATE", "RETRY_OPERATION", "ACK_OPERATION_RESULT"].includes(value.command) && typeof payload.operationId !== "string") return false;
  if (value.command === "SEND_OPERATION") {
    const expectation = payload.expectation;
    if (
      !isRecord(expectation)
      || !Array.isArray(expectation.allowedFormats)
    ) return false;
    const allowedFormats = expectation.allowedFormats;
    if (
      typeof payload.unitId !== "string"
      || typeof payload.operationId !== "string"
      || typeof payload.prompt !== "string"
      || byteLength(payload.prompt) > MEOI_PROMPT_MAX_BYTES
      || expectation.unitId !== payload.unitId
      || typeof expectation.targetLanguage !== "string"
      || typeof expectation.sourceLanguage !== "string"
      || typeof expectation.level !== "string"
      || !Number.isInteger(expectation.questionCount)
      || typeof expectation.speaking !== "boolean"
      || allowedFormats.length < 5
      || allowedFormats.some((format) => !LESSON_QUESTION_FORMATS.includes(format as (typeof LESSON_QUESTION_FORMATS)[number]))
      || !["create_lesson", "evaluate_answer", "coaching"].includes(String(payload.kind))
    ) return false;
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Meoi extension context is no longer available.";
}

function postResponse(
  request: ExtensionRequest<Record<string, unknown>>,
  result?: ExtensionResponse["data"] & { ok?: boolean; error?: ExtensionResponse["error"] },
  runtimeError?: { message?: string },
): void {
  const response: ExtensionResponse = {
    source: MEOI_EXTENSION_SOURCE,
    version: MEOI_EXTENSION_PROTOCOL_VERSION,
    nonce: request.nonce,
    requestId: request.requestId,
    ok: !runtimeError && result?.ok !== false,
    data: result && "data" in result ? result.data : result,
    error: runtimeError
      ? { code: "EXTENSION_NOT_READY", message: runtimeError.message || "Meoi extension is not ready." }
      : result?.error,
  };
  window.postMessage(response, window.location.origin);
}

function invalidateContentBridge(
  request: ExtensionRequest<Record<string, unknown>>,
  error: unknown,
): void {
  postResponse(request, undefined, { message: errorMessage(error) });
  window.removeEventListener("message", handlePageMessage);
}

function handlePageMessage(event: MessageEvent): void {
  if (event.source !== window || event.origin !== window.location.origin || !isAllowedMeoiOrigin(event.origin) || !validRequest(event.data)) return;
  const request = event.data;
  try {
    chrome.runtime.sendMessage({ kind: "MEOI_PAGE_REQUEST", request }, (result: ExtensionResponse["data"] & { ok?: boolean; error?: ExtensionResponse["error"] }) => {
      try {
        postResponse(request, result, chrome.runtime.lastError);
      } catch (error) {
        invalidateContentBridge(request, error);
      }
    });
  } catch (error) {
    invalidateContentBridge(request, error);
  }
}

window.addEventListener("message", handlePageMessage);
