import { buildResultRepairPrompt, type ExtensionError } from "../src/integration/protocol";
import type { ChatCommandResponse, ChatOperationEvent, QueuedOperation } from "./shared";
import { extensionError } from "./shared";
import {
  assistantTurnText,
  conversationIdFromUrl,
  findAssistantTurns,
  findComposer,
  findSendButton,
  parseChatOperationResult,
  quotaReached,
  responseGenerationActive,
  visibleControl as visible,
  type Composer,
  type ResultParseErrorCode,
} from "./chatgpt-adapter";

const SELECTOR_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const RESPONSE_STABLE_MS = 1_200;
const OBSERVER_POLL_MS = 200;
const MAX_REPAIR_ATTEMPTS = 3;

interface AssistantBaseline {
  count: number;
  elements: Set<HTMLElement>;
  keys: Set<string>;
}

interface ConversationLock {
  id: string | null;
}

class ChatFlowFailure extends Error {
  readonly extensionError: ExtensionError;

  constructor(error: ExtensionError) {
    super(error.message);
    this.name = "ChatFlowFailure";
    this.extensionError = error;
  }
}

let activeOperationId: string | null = null;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function waitForMutationOrDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const observer = new MutationObserver(finish);
    const timeout = window.setTimeout(finish, milliseconds);
    function finish() {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve();
    }
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  });
}

async function waitForComposer(deadline = Date.now() + SELECTOR_TIMEOUT_MS): Promise<Composer | null> {
  while (Date.now() < deadline) {
    const composer = findComposer();
    if (composer) return composer;
    await waitForMutationOrDelay(OBSERVER_POLL_MS);
  }
  return null;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function replaceComposerText(composer: Composer, value: string) {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    setTextareaValue(composer, value);
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertText", false, value);
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

async function submitText(prompt: string, unsupportedMessage: string): Promise<ChatCommandResponse> {
  if (quotaReached()) {
    return { ok: false, error: extensionError("CHATGPT_LIMIT_REACHED", "ChatGPT Free quota reached. Click Retry in ChatGPT to resume Meoi.") };
  }
  const composer = await waitForComposer();
  if (!composer) return { ok: false, error: extensionError("UNSUPPORTED_CHATGPT_UI", unsupportedMessage) };
  replaceComposerText(composer, prompt);
  await wait(250);
  if (quotaReached()) {
    replaceComposerText(composer, "");
    return { ok: false, error: extensionError("CHATGPT_LIMIT_REACHED", "ChatGPT Free quota reached before send. Nothing was sent.") };
  }
  const sendButton = findSendButton(composer);
  if (!sendButton) {
    replaceComposerText(composer, "");
    return { ok: false, error: extensionError("UNSUPPORTED_CHATGPT_UI", "Meoi cannot find an enabled Send prompt control. Nothing was sent.") };
  }
  sendButton.click();
  return { ok: true, currentUrl: window.location.href };
}

function submitOperation(operation: QueuedOperation): Promise<ChatCommandResponse> {
  return submitText(operation.prompt, "Meoi cannot find a supported ChatGPT composer. Nothing was sent.");
}

function submitRepair(
  operation: QueuedOperation,
  reason: ResultParseErrorCode,
): Promise<ChatCommandResponse> {
  return submitText(
    buildResultRepairPrompt(operation.operationId, operation.kind, reason),
    "Meoi cannot find the ChatGPT composer for JSON result repair.",
  );
}

function assistantTurnKey(turn: HTMLElement): string | null {
  const direct = turn.getAttribute("data-message-id");
  if (direct) return `message:${direct}`;
  const article = turn.closest<HTMLElement>('article[data-testid^="conversation-turn-"]');
  const testId = article?.getAttribute("data-testid");
  return testId ? `turn:${testId}` : null;
}

function snapshotAssistantTurns(): AssistantBaseline {
  const turns = findAssistantTurns();
  return {
    count: turns.length,
    elements: new Set(turns),
    keys: new Set(turns.map(assistantTurnKey).filter((key): key is string => Boolean(key))),
  };
}

function newestAssistantTurn(baseline: AssistantBaseline): HTMLElement | null {
  const turns = findAssistantTurns();
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const key = assistantTurnKey(turn);
    if (key && !baseline.keys.has(key)) return turn;
    if (turns.length > baseline.count && index >= baseline.count && !baseline.elements.has(turn)) return turn;
  }
  return null;
}

function validateConversation(lock: ConversationLock) {
  if (window.location.origin !== "https://chatgpt.com") {
    throw new ChatFlowFailure(extensionError("CHATGPT_TAB_CHANGED", "The active tab left chatgpt.com before Meoi received a response."));
  }
  const currentId = conversationIdFromUrl(window.location.href);
  if (!lock.id && currentId) lock.id = currentId;
  else if (lock.id && currentId !== lock.id) {
    throw new ChatFlowFailure(extensionError("CHATGPT_TAB_CHANGED", "The ChatGPT conversation changed before Meoi received its result."));
  }
}

async function waitForAssistantResponse(baseline: AssistantBaseline, deadline: number, conversation: ConversationLock): Promise<string> {
  let lastText = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    validateConversation(conversation);
    if (quotaReached()) throw new ChatFlowFailure(extensionError("CHATGPT_LIMIT_REACHED", "ChatGPT quota was reached while Meoi was waiting for a response."));
    const turn = newestAssistantTurn(baseline);
    if (turn) {
      const text = assistantTurnText(turn);
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      } else if (text && !responseGenerationActive() && Date.now() - stableSince >= RESPONSE_STABLE_MS) {
        return text;
      }
    }
    await waitForMutationOrDelay(OBSERVER_POLL_MS);
  }
  throw new ChatFlowFailure(extensionError("CHATGPT_RESPONSE_TIMEOUT", "ChatGPT did not return a readable Meoi result within ten minutes."));
}

function emitOperationEvent(event: Omit<ChatOperationEvent, "kind">) {
  chrome.runtime.sendMessage({ kind: "MEOI_CHAT_OPERATION_EVENT", ...event } satisfies ChatOperationEvent, () => {
    void chrome.runtime.lastError;
  });
}

function operationFailure(error: unknown): ExtensionError {
  if (error instanceof ChatFlowFailure) return error.extensionError;
  return extensionError("SEND_FAILED", error instanceof Error ? error.message : "ChatGPT operation failed.");
}

async function runTrackedOperation(operation: QueuedOperation): Promise<void> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  const conversation: ConversationLock = { id: conversationIdFromUrl(window.location.href) };
  try {
    emitOperationEvent({ operationId: operation.operationId, unitId: operation.unitId, phase: "sending", repairAttempt: 0, currentUrl: window.location.href });
    const baseline = snapshotAssistantTurns();
    const sent = await submitOperation(operation);
    if (!sent.ok) throw new ChatFlowFailure(sent.error ?? extensionError("SEND_FAILED", "ChatGPT send failed."));
    emitOperationEvent({ operationId: operation.operationId, unitId: operation.unitId, phase: "awaiting_response", repairAttempt: 0, currentUrl: sent.currentUrl });

    let response = await waitForAssistantResponse(baseline, deadline, conversation);
    let parsed = parseChatOperationResult(response, operation.operationId, operation.kind);
    let completedRepairAttempt = 0;
    for (let repairAttempt = 1; !parsed.ok && repairAttempt <= MAX_REPAIR_ATTEMPTS; repairAttempt += 1) {
      completedRepairAttempt = repairAttempt;
      emitOperationEvent({ operationId: operation.operationId, unitId: operation.unitId, phase: "repairing_response", repairAttempt, currentUrl: window.location.href });
      const repairBaseline = snapshotAssistantTurns();
      const repaired = await submitRepair(operation, parsed.code);
      if (!repaired.ok) throw new ChatFlowFailure(repaired.error ?? extensionError("SEND_FAILED", "JSON result repair send failed."));
      response = await waitForAssistantResponse(repairBaseline, deadline, conversation);
      parsed = parseChatOperationResult(response, operation.operationId, operation.kind);
    }

    if (!parsed.ok) {
      throw new ChatFlowFailure(extensionError("INVALID_CHATGPT_RESPONSE", `ChatGPT did not return a valid Meoi result after ${MAX_REPAIR_ATTEMPTS} repair attempts (${parsed.code}).`));
    }
    emitOperationEvent({
      operationId: operation.operationId,
      unitId: operation.unitId,
      phase: "completed",
      repairAttempt: completedRepairAttempt,
      result: parsed.result,
      currentUrl: window.location.href,
    });
  } catch (error) {
    emitOperationEvent({
      operationId: operation.operationId,
      unitId: operation.unitId,
      phase: "failed",
      repairAttempt: 0,
      error: operationFailure(error),
      currentUrl: window.location.href,
    });
  } finally {
    activeOperationId = null;
  }
}

function openVoice(): ChatCommandResponse {
  const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>(
    'button[data-testid*="voice" i], button[aria-label*="voice" i], button[aria-label*="start voice" i]',
  ));
  const button = candidates.find(visible);
  if (!button) return { ok: false, error: extensionError("UNSUPPORTED_CHATGPT_UI", "ChatGPT Voice control was not found. Nothing was clicked.") };
  button.click();
  return { ok: true, currentUrl: window.location.href };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const kind = (message as { kind?: string }).kind;
  if (kind === "MEOI_OPEN_VOICE") {
    sendResponse(openVoice());
    return false;
  }
  if (kind === "MEOI_GET_CHAT_OPERATION_STATUS") {
    sendResponse({ ok: true, activeOperationId, currentUrl: window.location.href });
    return false;
  }
  if (kind !== "MEOI_CHAT_COMMAND") return false;
  const operation = (message as { operation: QueuedOperation }).operation;
  if (activeOperationId) {
    sendResponse({ ok: false, error: extensionError("SEND_FAILED", `ChatGPT tab is already processing operation ${activeOperationId}.`) });
    return false;
  }
  activeOperationId = operation.operationId;
  sendResponse({ ok: true, accepted: true, currentUrl: window.location.href } satisfies ChatCommandResponse);
  void runTrackedOperation(operation);
  return false;
});

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  if (!button || !/^retry$/i.test(button.textContent?.trim() ?? "") || !quotaReached()) return;
  window.setTimeout(() => chrome.runtime.sendMessage({ kind: "MEOI_RETRY_CHATGPT" }), 300);
}, true);
