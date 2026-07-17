import {
  MEOI_CHAT_RESULT_TYPE,
  MEOI_EXTENSION_PROTOCOL_VERSION,
  type ChatOperationKind,
  type ChatOperationResult,
} from "../src/integration/protocol";

export type Composer = HTMLTextAreaElement | HTMLElement;

export const CHAT_RESULT_MAX_BYTES = 1024 * 1024;

export type ResultParseErrorCode =
  | "EMPTY_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "AMBIGUOUS_JSON_BLOCK"
  | "INVALID_JSON"
  | "INVALID_RESULT_SCHEMA"
  | "WRONG_OPERATION_ID"
  | "WRONG_OPERATION_KIND";

export type ResultParseResult =
  | { ok: true; result: ChatOperationResult }
  | { ok: false; code: ResultParseErrorCode };

export function visibleControl(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

export function findComposer(root: ParentNode = document): Composer | null {
  const preferred = root.querySelector<Composer>('[data-testid="prompt-textarea"], textarea[data-testid="prompt-textarea"]');
  if (preferred && visibleControl(preferred)) return preferred;
  const accessible = root.querySelector<Composer>('[role="textbox"][contenteditable="true"][aria-label*="message" i], textarea[placeholder*="message" i]');
  if (accessible && visibleControl(accessible)) return accessible;
  const fallbacks = Array.from(root.querySelectorAll<HTMLElement>('form [contenteditable="true"], form textarea')).filter(visibleControl);
  return fallbacks.length === 1 ? fallbacks[0] : null;
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

export function findAssistantTurns(root: ParentNode = document): HTMLElement[] {
  const preferred = Array.from(root.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]')).filter(visibleControl);
  if (preferred.length) return [...new Set(preferred)];

  const explicitFallbacks = Array.from(root.querySelectorAll<HTMLElement>(
    'article[data-testid^="conversation-turn-"][data-turn="assistant"], article[data-testid^="conversation-turn-"][aria-label*="ChatGPT" i], article[data-testid^="conversation-turn-"][aria-label*="assistant" i]',
  )).filter(visibleControl);
  return [...new Set(explicitFallbacks)];
}

export function assistantTurnText(turn: HTMLElement): string {
  const codeBlocks = Array.from(turn.querySelectorAll<HTMLElement>("pre code"));
  if (codeBlocks.length === 1) return (codeBlocks[0].innerText || codeBlocks[0].textContent || "").trim();
  if (codeBlocks.length > 1) {
    return codeBlocks.map((block) => `\`\`\`json\n${(block.innerText || block.textContent || "").trim()}\n\`\`\``).join("\n");
  }
  return (turn.innerText || turn.textContent || "").trim();
}

export function responseGenerationActive(root: ParentNode = document): boolean {
  const controls = Array.from(root.querySelectorAll<HTMLElement>(
    'button[data-testid="stop-button"], button[aria-label*="stop generating" i], button[aria-label*="stop response" i]',
  ));
  return controls.some(visibleControl);
}

export function conversationIdFromUrl(value: string): string | null {
  try {
    const match = new URL(value).pathname.match(/^\/c\/([A-Za-z0-9-]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function jsonCandidate(text: string): { ok: true; value: string } | { ok: false; code: ResultParseErrorCode } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, code: "EMPTY_RESPONSE" };
  if (byteLength(trimmed) > CHAT_RESULT_MAX_BYTES) return { ok: false, code: "RESPONSE_TOO_LARGE" };

  const fenceCount = trimmed.match(/```/g)?.length ?? 0;
  if (!fenceCount) return { ok: true, value: trimmed };
  const jsonBlocks = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (fenceCount !== 2 || jsonBlocks.length !== 1) return { ok: false, code: "AMBIGUOUS_JSON_BLOCK" };
  const candidate = jsonBlocks[0][1].trim();
  if (!candidate || byteLength(candidate) > CHAT_RESULT_MAX_BYTES) {
    return { ok: false, code: candidate ? "RESPONSE_TOO_LARGE" : "EMPTY_RESPONSE" };
  }
  return { ok: true, value: candidate };
}

function validCompletedResult(kind: ChatOperationKind, value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (kind === "create_lesson") return hasExactKeys(value, ["lesson"]) && isRecord(value.lesson);
  if (kind === "evaluate_answer") return hasExactKeys(value, ["evaluation"]) && isRecord(value.evaluation);
  return hasExactKeys(value, ["coachingReply"])
    && typeof value.coachingReply === "string"
    && value.coachingReply.trim().length > 0
    && byteLength(value.coachingReply) <= 16 * 1024;
}

export function parseChatOperationResult(
  text: string,
  expectedOperationId: string,
  expectedKind: ChatOperationKind,
): ResultParseResult {
  const candidate = jsonCandidate(text);
  if (!candidate.ok) return candidate;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.value);
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, code: "INVALID_RESULT_SCHEMA" };

  if (parsed.operationId !== expectedOperationId) return { ok: false, code: "WRONG_OPERATION_ID" };
  if (parsed.kind !== expectedKind) return { ok: false, code: "WRONG_OPERATION_KIND" };
  if (
    parsed.type !== MEOI_CHAT_RESULT_TYPE
    || parsed.protocolVersion !== MEOI_EXTENSION_PROTOCOL_VERSION
    || !["completed", "needs_source", "failed"].includes(String(parsed.outcome))
  ) {
    return { ok: false, code: "INVALID_RESULT_SCHEMA" };
  }

  if (parsed.outcome === "completed") {
    if (!hasExactKeys(parsed, ["type", "protocolVersion", "operationId", "kind", "outcome", "result"])) {
      return { ok: false, code: "INVALID_RESULT_SCHEMA" };
    }
    if (!validCompletedResult(expectedKind, parsed.result)) return { ok: false, code: "INVALID_RESULT_SCHEMA" };
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
      return { ok: false, code: "INVALID_RESULT_SCHEMA" };
    }
  } else {
    if (
      !hasExactKeys(parsed, ["type", "protocolVersion", "operationId", "kind", "outcome", "error"])
      || !isRecord(parsed.error)
      || !hasExactKeys(parsed.error, ["code", "message"])
      || typeof parsed.error.code !== "string"
      || typeof parsed.error.message !== "string"
      || !parsed.error.code
      || !parsed.error.message
    ) {
      return { ok: false, code: "INVALID_RESULT_SCHEMA" };
    }
  }

  return { ok: true, result: parsed as unknown as ChatOperationResult };
}
