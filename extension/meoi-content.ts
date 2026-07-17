import {
  MEOI_EXTENSION_PROTOCOL_VERSION,
  MEOI_EXTENSION_SOURCE,
  MEOI_PAGE_SOURCE,
  MEOI_PROMPT_MAX_BYTES,
  type ExtensionRequest,
  type ExtensionResponse,
} from "../src/integration/protocol";
import { isAllowedMeoiOrigin } from "./integration-policy";

const commands = new Set([
  "SEND_OPERATION", "OPEN_VOICE", "GET_INTEGRATION_STATUS",
  "GET_OPERATION_STATE", "RETRY_OPERATION", "ACK_OPERATION_RESULT",
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
  if (value.command === "OPEN_VOICE" && typeof payload.unitId !== "string") return false;
  if (["GET_OPERATION_STATE", "RETRY_OPERATION", "ACK_OPERATION_RESULT"].includes(value.command) && typeof payload.operationId !== "string") return false;
  if (value.command === "SEND_OPERATION") {
    if (
      typeof payload.unitId !== "string"
      || typeof payload.operationId !== "string"
      || typeof payload.prompt !== "string"
      || byteLength(payload.prompt) > MEOI_PROMPT_MAX_BYTES
      || !isRecord(payload.expectation)
      || payload.expectation.unitId !== payload.unitId
      || typeof payload.expectation.targetLanguage !== "string"
      || typeof payload.expectation.level !== "string"
      || !Number.isInteger(payload.expectation.questionCount)
      || typeof payload.expectation.speaking !== "boolean"
      || !["create_lesson", "evaluate_answer", "coaching"].includes(String(payload.kind))
    ) return false;
  }
  return true;
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin || !isAllowedMeoiOrigin(event.origin) || !validRequest(event.data)) return;
  const request = event.data;
  chrome.runtime.sendMessage({ kind: "MEOI_PAGE_REQUEST", request }, (result: ExtensionResponse["data"] & { ok?: boolean; error?: ExtensionResponse["error"] }) => {
    const runtimeError = chrome.runtime.lastError;
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
  });
});
