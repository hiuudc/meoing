import {
  MEOI_CHAT_RESULT_TYPE,
  MEOI_EXTENSION_PROTOCOL_VERSION,
  type ChatOperationKind,
  type ChatOperationResult,
  type OperationExpectation,
} from "../src/integration/protocol";
import { evaluationSchema, lessonSchema, validateLessonForExpectation } from "../src/learning/schema";
export { conversationIdFromUrl } from "./chatgpt-url";

export type Composer = HTMLTextAreaElement | HTMLElement;

export const CHAT_RESULT_MAX_BYTES = 1024 * 1024;
export const CHAT_RESULT_MAX_REPAIR_ATTEMPTS = 3;
export const ASSISTANT_RESPONSE_SETTLE_MS = 400;
export const ASSISTANT_RESPONSE_FALLBACK_MS = 8_000;
const CHAT_RESULT_MAX_ISSUES = 20;
const CHAT_RESULT_REPAIR_DETAIL_MAX_BYTES = 4 * 1024;

export function repairAttemptNumbers(maximum = CHAT_RESULT_MAX_REPAIR_ATTEMPTS): number[] {
  return Array.from({ length: Math.max(0, Math.floor(maximum)) }, (_, index) => index + 1);
}

export type ResultParseErrorCode =
  | "EMPTY_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "AMBIGUOUS_JSON_BLOCK"
  | "INVALID_JSON"
  | "INVALID_RESULT_SCHEMA"
  | "WRONG_OPERATION_ID"
  | "WRONG_OPERATION_KIND";

export interface ResultParseFailure {
  ok: false;
  code: ResultParseErrorCode;
  details: string[];
}

export type ResultParseResult =
  | { ok: true; result: ChatOperationResult }
  | ResultParseFailure;

export function visibleControl(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

export function findComposer(root: ParentNode = document): Composer | null {
  const preferred = root.querySelector<Composer>(
    '#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"], textarea[data-testid="prompt-textarea"]',
  );
  if (preferred && visibleControl(preferred)) return preferred;
  const accessible = root.querySelector<Composer>(
    '[role="textbox"][contenteditable="true"][aria-label*="message" i], [role="textbox"][contenteditable="true"][aria-label*="ChatGPT" i], textarea[placeholder*="message" i]',
  );
  if (accessible && visibleControl(accessible)) return accessible;
  const fallbacks = Array.from(root.querySelectorAll<HTMLElement>('form [contenteditable="true"], form textarea')).filter(visibleControl);
  return fallbacks.length === 1 ? fallbacks[0] : null;
}

export function currentComposer(fallback: Composer | null = null, root: ParentNode = document): Composer | null {
  return findComposer(root) ?? (fallback?.isConnected ? fallback : null);
}

export function quotaReached(root: ParentNode = document): boolean {
  const controls = Array.from(root.querySelectorAll<HTMLElement>('[role="alert"], [data-testid*="error" i], [data-testid*="limit" i]')).filter(visibleControl);
  const message = controls.map((element) => element.textContent ?? "").join(" ").toLowerCase();
  return /(limit|quota|free plan|try again later|usage cap|reached)/i.test(message);
}

export function findSendButton(composer: Composer): HTMLButtonElement | null {
  const root = composer.closest("form") ?? document;
  const candidates = Array.from(root.querySelectorAll<HTMLButtonElement>(
    'button[data-testid="send-button"], button[aria-label="Send prompt" i], button[aria-label="Send message" i]',
  ));
  return candidates.find((button) => visibleControl(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true") ?? null;
}

export function composerText(composer: Composer): string {
  return composer instanceof HTMLTextAreaElement
    ? composer.value
    : (composer.innerText || composer.textContent || "");
}

function normalizeComposerText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\u00a0/g, " ")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/[\p{White_Space}]+/gu, " ")
    .trim();
}

export function composerTextMatchesExpected(actual: string, expected: string): boolean {
  return normalizeComposerText(actual) === normalizeComposerText(expected);
}

export function composerTextMismatchSummary(actual: string, expected: string): string {
  const normalizedActual = normalizeComposerText(actual);
  const normalizedExpected = normalizeComposerText(expected);
  const sharedLength = Math.min(normalizedActual.length, normalizedExpected.length);
  let differenceAt = sharedLength;
  for (let index = 0; index < sharedLength; index += 1) {
    if (normalizedActual[index] !== normalizedExpected[index]) {
      differenceAt = index;
      break;
    }
  }
  return `actual normalized length ${normalizedActual.length}, expected ${normalizedExpected.length}, first difference at ${differenceAt}`;
}

export function findAssistantTurns(root: ParentNode = document): HTMLElement[] {
  const preferred = Array.from(root.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]')).filter(visibleControl);
  if (preferred.length) return [...new Set(preferred)];

  const explicitFallbacks = Array.from(root.querySelectorAll<HTMLElement>(
    'article[data-testid^="conversation-turn-"][data-turn="assistant"], article[data-testid^="conversation-turn-"][aria-label*="ChatGPT" i], article[data-testid^="conversation-turn-"][aria-label*="assistant" i]',
  )).filter(visibleControl);
  return [...new Set(explicitFallbacks)];
}

function elementText(element: HTMLElement): string {
  return (element.innerText || element.textContent || "").trim();
}

export function assistantTurnText(turn: HTMLElement): string {
  const responseRoot = turn.querySelector<HTMLElement>('.markdown, [data-message-author-role="assistant"] .prose') ?? turn;
  const codeBlocks = Array.from(responseRoot.querySelectorAll<HTMLElement>("pre code"));
  if (!codeBlocks.length) return elementText(responseRoot);

  const withoutCode = responseRoot.cloneNode(true) as HTMLElement;
  withoutCode.querySelectorAll("pre").forEach((pre) => pre.remove());
  const surroundingText = elementText(withoutCode);
  if (!surroundingText && codeBlocks.length === 1 && !/language-json/i.test(codeBlocks[0].className)) {
    return elementText(codeBlocks[0]);
  }
  const fencedBlocks = codeBlocks.map((block) => {
    const language = /language-json/i.test(block.className) ? "json" : "";
    return `\`\`\`${language}\n${elementText(block)}\n\`\`\``;
  }).join("\n");
  return surroundingText ? `${surroundingText}\n${fencedBlocks}` : fencedBlocks;
}

export function responseGenerationActive(root: ParentNode = document): boolean {
  const controls = Array.from(root.querySelectorAll<HTMLElement>(
    'button[data-testid="stop-button"], button[aria-label*="stop generating" i], button[aria-label*="stop response" i], button[aria-label*="stop streaming" i]',
  ));
  return controls.some(visibleControl);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateBytes(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (byteLength(value) <= maximum) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maximum) low = middle;
    else high = middle - 1;
  }
  const end = low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]) ? low - 1 : low;
  return value.slice(0, end);
}

export function assistantTurnHasCompletionAction(turn: HTMLElement): boolean {
  let scope: HTMLElement | null = turn;
  for (let depth = 0; scope && depth < 5; depth += 1) {
    const actions = Array.from(scope.querySelectorAll<HTMLElement>(
      'button[aria-label="Copy response" i], button[aria-label="Good response" i], button[aria-label="Bad response" i]',
    ));
    if (actions.some(visibleControl)) return true;
    if (scope.matches('article[data-testid^="conversation-turn-"]')) break;
    scope = scope.parentElement;
  }
  return false;
}

export function responseTextLooksClosed(text: string): boolean {
  const candidate = jsonCandidate(text);
  if (!candidate.ok) return false;
  try {
    JSON.parse(candidate.value);
    return true;
  } catch {
    return false;
  }
}

export function assistantResponseReady(
  turn: HTMLElement,
  text: string,
  stableForMs: number,
  root: ParentNode = document,
): boolean {
  if (!text || responseGenerationActive(root)) return false;
  if (assistantTurnHasCompletionAction(turn)) return stableForMs >= ASSISTANT_RESPONSE_SETTLE_MS;
  return stableForMs >= ASSISTANT_RESPONSE_FALLBACK_MS && responseTextLooksClosed(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function failure(code: ResultParseErrorCode, ...details: string[]): ResultParseFailure {
  let remaining = CHAT_RESULT_REPAIR_DETAIL_MAX_BYTES;
  const boundedDetails: string[] = [];
  for (const detail of details.filter(Boolean).slice(0, CHAT_RESULT_MAX_ISSUES)) {
    const normalized = detail.replace(/[\r\n]+/g, " ").trim();
    if (!normalized || remaining <= 0) break;
    const bounded = truncateBytes(normalized, remaining);
    if (!bounded) break;
    boundedDetails.push(bounded);
    remaining -= byteLength(bounded);
  }
  return {
    ok: false,
    code,
    details: boundedDetails,
  };
}

function jsonCandidate(text: string): { ok: true; value: string } | ResultParseFailure {
  const trimmed = text.trim();
  if (!trimmed) return failure("EMPTY_RESPONSE", "The assistant response is empty.");
  if (byteLength(trimmed) > CHAT_RESULT_MAX_BYTES) {
    return failure("RESPONSE_TOO_LARGE", "The assistant response exceeds 1 MiB.");
  }

  if (trimmed.startsWith("{") || !trimmed.includes("```")) return { ok: true, value: trimmed };
  if ((trimmed.match(/```/g)?.length ?? 0) !== 2) {
    return failure("AMBIGUOUS_JSON_BLOCK", "Use exactly one standalone json fence.");
  }
  const standaloneFence = trimmed.match(/^```json[\t ]*\r?\n([\s\S]*?)\r?\n?```$/i);
  if (!standaloneFence) {
    return failure("AMBIGUOUS_JSON_BLOCK", "Use one standalone json fence with no surrounding text or additional fence.");
  }
  const candidate = standaloneFence[1].trim();
  if (!candidate) return failure("EMPTY_RESPONSE", "The json fence is empty.");
  if (byteLength(candidate) > CHAT_RESULT_MAX_BYTES) {
    return failure("RESPONSE_TOO_LARGE", "The JSON response exceeds 1 MiB.");
  }
  return { ok: true, value: candidate };
}

function schemaDetails(issues: Array<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.slice(0, CHAT_RESULT_MAX_ISSUES).map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join(".") : "result";
    return `${path}: ${issue.message}`;
  });
}

function validateCompletedResult(
  kind: ChatOperationKind,
  value: unknown,
  expectation: OperationExpectation,
): string[] {
  if (!isRecord(value)) return ["result must be an object."];
  if (kind === "create_lesson") {
    if (!hasExactKeys(value, ["lesson"])) return ["result must contain only lesson."];
    const parsed = lessonSchema.safeParse(value.lesson);
    if (!parsed.success) return schemaDetails(parsed.error.issues);
    return validateLessonForExpectation(parsed.data, expectation);
  }
  if (kind === "evaluate_answer") {
    if (!hasExactKeys(value, ["evaluation"])) return ["result must contain only evaluation."];
    const parsed = evaluationSchema.safeParse(value.evaluation);
    return parsed.success ? [] : schemaDetails(parsed.error.issues);
  }
  if (!hasExactKeys(value, ["coachingReply"])) return ["result must contain only coachingReply."];
  if (typeof value.coachingReply !== "string" || !value.coachingReply.trim()) return ["coachingReply must be a non-empty string."];
  if (byteLength(value.coachingReply) > 16 * 1024) return ["coachingReply exceeds 16 KiB."];
  return [];
}

export function resultParseFailureReason(parsed: ResultParseFailure): string {
  return truncateBytes([parsed.code, ...parsed.details].join(": "), CHAT_RESULT_REPAIR_DETAIL_MAX_BYTES);
}

export function parseChatOperationResult(
  text: string,
  expectedOperationId: string,
  expectedKind: ChatOperationKind,
  expectation: OperationExpectation,
): ResultParseResult {
  const candidate = jsonCandidate(text);
  if (!candidate.ok) return candidate;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.value);
  } catch {
    return failure("INVALID_JSON", "The response is not valid JSON.");
  }
  if (!isRecord(parsed)) return failure("INVALID_RESULT_SCHEMA", "The top-level value must be an object.");

  if (parsed.operationId !== expectedOperationId) {
    return failure("WRONG_OPERATION_ID", `operationId must equal ${expectedOperationId}.`);
  }
  if (parsed.kind !== expectedKind) return failure("WRONG_OPERATION_KIND", `kind must equal ${expectedKind}.`);
  if (
    parsed.type !== MEOI_CHAT_RESULT_TYPE
    || parsed.protocolVersion !== MEOI_EXTENSION_PROTOCOL_VERSION
    || !["completed", "needs_source", "failed"].includes(String(parsed.outcome))
  ) {
    return failure("INVALID_RESULT_SCHEMA", "type, protocolVersion, or outcome is invalid.");
  }

  if (parsed.outcome === "completed") {
    if (!hasExactKeys(parsed, ["type", "protocolVersion", "operationId", "kind", "outcome", "result"])) {
      return failure("INVALID_RESULT_SCHEMA", "The completed envelope has missing or extra fields.");
    }
    const details = validateCompletedResult(expectedKind, parsed.result, expectation);
    if (details.length) return failure("INVALID_RESULT_SCHEMA", ...details);
  } else if (parsed.outcome === "needs_source") {
    if (
      expectedKind !== "create_lesson"
      || !hasExactKeys(parsed, ["type", "protocolVersion", "operationId", "kind", "outcome", "result"])
      || !isRecord(parsed.result)
      || !hasExactKeys(parsed.result, ["sourceRequest"])
      || typeof parsed.result.sourceRequest !== "string"
      || parsed.result.sourceRequest.trim().length === 0
      || byteLength(parsed.result.sourceRequest) > 16 * 1024
    ) {
      return failure("INVALID_RESULT_SCHEMA", "needs_source is only valid for create_lesson with one non-empty sourceRequest under 16 KiB.");
    }
  } else if (
    !hasExactKeys(parsed, ["type", "protocolVersion", "operationId", "kind", "outcome", "error"])
    || !isRecord(parsed.error)
    || !hasExactKeys(parsed.error, ["code", "message"])
    || typeof parsed.error.code !== "string"
    || typeof parsed.error.message !== "string"
    || !parsed.error.code.trim()
    || !parsed.error.message.trim()
    || byteLength(parsed.error.code) > 1_024
    || byteLength(parsed.error.message) > 16 * 1024
  ) {
    return failure("INVALID_RESULT_SCHEMA", "The failed envelope must contain only non-empty code and message strings.");
  }

  return { ok: true, result: parsed as unknown as ChatOperationResult };
}
