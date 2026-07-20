import { buildResultRepairPrompt, type ExtensionError } from "../src/integration/protocol";
import {
  MEOI_CHATGPT_PROJECT_NAME,
  placeCurrentConversationInProject,
} from "./chatgpt-project";
import type { ChatCommandResponse, ChatOperationEvent, QueuedOperation } from "./shared";
import { extensionError } from "./shared";
import {
  assistantTurnText,
  composerText,
  composerTextMatchesExpected,
  composerTextMismatchSummary,
  conversationIdFromUrl,
  currentComposer,
  findAssistantTurns,
  findComposer,
  findSendButton,
  parseChatOperationResult,
  quotaReached,
  repairAttemptNumbers,
  responseGenerationActive,
  resultParseFailureReason,
  visibleControl as visible,
  type Composer,
} from "./chatgpt-adapter";

const SELECTOR_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const RESPONSE_STABLE_MS = 1_200;
const OBSERVER_POLL_MS = 200;
const EVENT_DELIVERY_GRACE_MS = 10_000;
const PROJECT_PLACEMENT_TIMEOUT_MS = 8_000;
const COMPOSER_PAYLOAD_PREFIX = "meoi-composer-payload-";
const COMPOSER_READY_ATTRIBUTE = "data-meoi-main-bridge";
const COMPOSER_RESULT_ATTRIBUTE = "data-meoi-composer-result";

let lastMainWorldComposerResult = "not-ready";

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

function requestMainWorldComposerText(value: string) {
  const requestId = crypto.randomUUID();
  const payload = document.createElement("script");
  payload.id = `${COMPOSER_PAYLOAD_PREFIX}${requestId}`;
  payload.type = "application/json";
  payload.hidden = true;
  payload.dataset.meoiRequestId = requestId;
  payload.textContent = value;
  document.documentElement.append(payload);
  window.setTimeout(() => payload.remove(), 2_000);
  window.setTimeout(() => {
    const result = document.documentElement.getAttribute(COMPOSER_RESULT_ATTRIBUTE);
    if (result?.startsWith(`${requestId}:`)) {
      lastMainWorldComposerResult = result.slice(requestId.length + 1);
      document.documentElement.removeAttribute(COMPOSER_RESULT_ATTRIBUTE);
    } else {
      lastMainWorldComposerResult = document.documentElement.getAttribute(COMPOSER_READY_ATTRIBUTE) === "ready"
        ? "ready-no-result"
        : "not-ready";
    }
  }, 0);
}

function selectComposerContents(composer: HTMLElement) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function clearContentEditable(composer: HTMLElement) {
  composer.focus();
  selectComposerContents(composer);
  document.execCommand("delete", false);
}

function pasteContentEditable(composer: HTMLElement, value: string) {
  clearContentEditable(composer);
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", value);
  composer.dispatchEvent(new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData,
  }));
}

function insertContentEditable(composer: HTMLElement, value: string) {
  clearContentEditable(composer);
  selectComposerContents(composer);
  document.execCommand("insertText", false, value);
}

function replaceContentEditableDom(composer: HTMLElement, value: string) {
  composer.focus();
  const fragment = document.createDocumentFragment();
  const lines = value.split("\n");
  for (const line of lines.length ? lines : [""]) {
    const paragraph = document.createElement("p");
    if (line) {
      paragraph.textContent = line;
    } else {
      paragraph.dataset.emptyParagraph = "true";
      const lineBreak = document.createElement("br");
      lineBreak.className = "ProseMirror-trailingBreak";
      paragraph.append(lineBreak);
    }
    fragment.append(paragraph);
  }
  composer.replaceChildren(fragment);
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: value }));
}

async function composerContainingExactText(composer: Composer, value: string, deadline: number): Promise<Composer | null> {
  while (Date.now() < deadline) {
    const candidate = currentComposer(composer);
    if (candidate && composerTextMatchesExpected(composerText(candidate), value)) return candidate;
    await waitForMutationOrDelay(100);
  }
  return null;
}

async function fillComposerText(composer: Composer, value: string, deadline: number): Promise<Composer | null> {
  if (composer instanceof HTMLTextAreaElement) {
    composer.focus();
    setTextareaValue(composer, value);
    return composerContainingExactText(composer, value, deadline);
  }

  requestMainWorldComposerText(value);
  let matched = await composerContainingExactText(composer, value, Math.min(deadline, Date.now() + 800));
  if (matched) return matched;

  let candidate = currentComposer(composer);
  if (!candidate) return null;
  if (candidate instanceof HTMLTextAreaElement) setTextareaValue(candidate, value);
  else pasteContentEditable(candidate, value);
  matched = await composerContainingExactText(candidate, value, Math.min(deadline, Date.now() + 600));
  if (matched) return matched;

  candidate = currentComposer(candidate);
  if (!candidate) return null;
  if (candidate instanceof HTMLTextAreaElement) setTextareaValue(candidate, value);
  else insertContentEditable(candidate, value);
  matched = await composerContainingExactText(candidate, value, Math.min(deadline, Date.now() + 600));
  if (matched) return matched;

  candidate = currentComposer(candidate);
  if (!candidate) return null;
  if (candidate instanceof HTMLTextAreaElement) setTextareaValue(candidate, value);
  else replaceContentEditableDom(candidate, value);
  return composerContainingExactText(candidate, value, deadline);
}

async function clearComposerText(composer: Composer): Promise<void> {
  let candidate = currentComposer(composer);
  if (!candidate) return;
  if (candidate instanceof HTMLTextAreaElement) {
    setTextareaValue(candidate, "");
    return;
  }
  requestMainWorldComposerText("");
  const mainWorldDeadline = Date.now() + 400;
  while (Date.now() < mainWorldDeadline) {
    candidate = currentComposer(candidate);
    if (!candidate || !composerText(candidate).trim()) return;
    await waitForMutationOrDelay(50);
  }
  candidate = currentComposer(candidate);
  if (!candidate) return;
  if (candidate instanceof HTMLTextAreaElement) setTextareaValue(candidate, "");
  else {
    clearContentEditable(candidate);
    if (composerText(candidate).trim()) replaceContentEditableDom(candidate, "");
  }
}

async function waitForEnabledSend(composer: Composer, deadline: number): Promise<HTMLButtonElement | null> {
  while (Date.now() < deadline) {
    const candidate = currentComposer(composer);
    const button = candidate ? findSendButton(candidate) : null;
    if (button) return button;
    await waitForMutationOrDelay(100);
  }
  return null;
}

async function submitText(prompt: string, unsupportedMessage: string, deadline: number): Promise<ChatCommandResponse> {
  if (quotaReached()) {
    return { ok: false, error: extensionError("CHATGPT_LIMIT_REACHED", "ChatGPT quota was reached. Nothing was sent.") };
  }
  const selectorDeadline = Math.min(deadline, Date.now() + SELECTOR_TIMEOUT_MS);
  const composer = await waitForComposer(selectorDeadline);
  if (!composer) return { ok: false, error: extensionError("UNSUPPORTED_CHATGPT_UI", unsupportedMessage) };
  const readyComposer = await fillComposerText(composer, prompt, selectorDeadline);
  if (!readyComposer) {
    const latestComposer = currentComposer(composer);
    const mismatch = composerTextMismatchSummary(latestComposer ? composerText(latestComposer) : "", prompt);
    await clearComposerText(latestComposer ?? composer);
    return { ok: false, error: extensionError("SEND_FAILED", `The ChatGPT composer did not contain the exact Meoi prompt (${mismatch}; main bridge ${lastMainWorldComposerResult}). Nothing was sent.`) };
  }
  if (quotaReached()) {
    await clearComposerText(readyComposer);
    return { ok: false, error: extensionError("CHATGPT_LIMIT_REACHED", "ChatGPT quota was reached before send. Nothing was sent.") };
  }
  const sendButton = await waitForEnabledSend(readyComposer, selectorDeadline);
  if (!sendButton) {
    await clearComposerText(readyComposer);
    return { ok: false, error: extensionError("UNSUPPORTED_CHATGPT_UI", "Meoi cannot find an enabled Send control. Nothing was sent.") };
  }
  sendButton.click();
  return { ok: true, currentUrl: window.location.href };
}

function submitOperation(operation: QueuedOperation, deadline: number): Promise<ChatCommandResponse> {
  return submitText(operation.prompt, "Meoi cannot find a supported ChatGPT composer. Nothing was sent.", deadline);
}

function submitRepair(operation: QueuedOperation, reason: string, deadline: number): Promise<ChatCommandResponse> {
  return submitText(
    buildResultRepairPrompt(operation.operationId, operation.kind, reason),
    "Meoi cannot find the ChatGPT composer for JSON result repair.",
    deadline,
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
    throw new ChatFlowFailure(extensionError("CHATGPT_TAB_CHANGED", "The tab left chatgpt.com before Meoi received a response."));
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

function sendEventOnce(event: ChatOperationEvent): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(event, (response?: { ok?: boolean }) => {
      const runtimeError = chrome.runtime.lastError;
      resolve(!runtimeError && response?.ok === true);
    });
  });
}

async function emitOperationEvent(event: Omit<ChatOperationEvent, "kind">, deadline: number): Promise<void> {
  const now = Date.now();
  const deliveryDeadline = deadline > now
    ? Math.min(deadline, now + EVENT_DELIVERY_GRACE_MS)
    : now + EVENT_DELIVERY_GRACE_MS;
  const message = { kind: "MEOI_CHAT_OPERATION_EVENT", ...event } satisfies ChatOperationEvent;
  while (Date.now() < deliveryDeadline) {
    if (await sendEventOnce(message)) return;
    await wait(250);
  }
  throw new ChatFlowFailure(extensionError("SEND_FAILED", "Meoi could not deliver the ChatGPT operation state to the extension worker."));
}

function operationFailure(error: unknown): ExtensionError {
  if (error instanceof ChatFlowFailure) return error.extensionError;
  return extensionError("SEND_FAILED", error instanceof Error ? error.message : "ChatGPT operation failed.");
}

async function projectPlacementWarning(deadline: number): Promise<ExtensionError | undefined> {
  if (!conversationIdFromUrl(window.location.href)) return undefined;
  const placementDeadline = Math.min(deadline, Date.now() + PROJECT_PLACEMENT_TIMEOUT_MS);
  try {
    await placeCurrentConversationInProject(MEOI_CHATGPT_PROJECT_NAME, placementDeadline, {
      root: document,
      currentUrl: () => window.location.href,
      now: () => Date.now(),
      wait: waitForMutationOrDelay,
    });
    return undefined;
  } catch (error) {
    return extensionError(
      "UNSUPPORTED_CHATGPT_UI",
      error instanceof Error
        ? `${error.message} The ChatGPT result was still returned to Meoi.`
        : `Meoi could not move this chat into the ChatGPT project "${MEOI_CHATGPT_PROJECT_NAME}". The result was still returned.`,
    );
  }
}

async function runTrackedOperation(operation: QueuedOperation): Promise<void> {
  const deadline = operation.deadlineAt ?? Date.now() + OPERATION_TIMEOUT_MS;
  const conversation: ConversationLock = { id: conversationIdFromUrl(window.location.href) };
  try {
    await emitOperationEvent({ operationId: operation.operationId, unitId: operation.unitId, phase: "sending", repairAttempt: 0, currentUrl: window.location.href }, deadline);
    const baseline = snapshotAssistantTurns();
    const sent = await submitOperation(operation, deadline);
    if (!sent.ok) throw new ChatFlowFailure(sent.error ?? extensionError("SEND_FAILED", "ChatGPT send failed."));
    await emitOperationEvent({ operationId: operation.operationId, unitId: operation.unitId, phase: "awaiting_response", repairAttempt: 0, currentUrl: sent.currentUrl }, deadline);

    let response = await waitForAssistantResponse(baseline, deadline, conversation);
    let parsed = parseChatOperationResult(response, operation.operationId, operation.kind, operation.expectation);
    let completedRepairAttempt = 0;
    for (const repairAttempt of repairAttemptNumbers()) {
      if (parsed.ok) break;
      completedRepairAttempt = repairAttempt;
      await emitOperationEvent({ operationId: operation.operationId, unitId: operation.unitId, phase: "repairing_response", repairAttempt, currentUrl: window.location.href }, deadline);
      const repairBaseline = snapshotAssistantTurns();
      const repaired = await submitRepair(operation, resultParseFailureReason(parsed), deadline);
      if (!repaired.ok) throw new ChatFlowFailure(repaired.error ?? extensionError("SEND_FAILED", "JSON result repair send failed."));
      response = await waitForAssistantResponse(repairBaseline, deadline, conversation);
      parsed = parseChatOperationResult(response, operation.operationId, operation.kind, operation.expectation);
    }

    if (!parsed.ok) {
      throw new ChatFlowFailure(extensionError(
        "INVALID_CHATGPT_RESPONSE",
        `ChatGPT did not return a valid Meoi result after ${repairAttemptNumbers().length} repair attempts (${resultParseFailureReason(parsed)}).`,
      ));
    }
    const projectWarning = await projectPlacementWarning(deadline);
    await emitOperationEvent({
      operationId: operation.operationId,
      unitId: operation.unitId,
      phase: "completed",
      repairAttempt: completedRepairAttempt,
      result: parsed.result,
      projectWarning,
      currentUrl: window.location.href,
    }, deadline);
  } catch (error) {
    try {
      await emitOperationEvent({
        operationId: operation.operationId,
        unitId: operation.unitId,
        phase: "failed",
        repairAttempt: 0,
        error: operationFailure(error),
        currentUrl: window.location.href,
      }, deadline);
    } catch {
      // A closed or invalidated tab is finalized by the worker's tab lifecycle listener.
    }
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

function validOperation(value: unknown): value is QueuedOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<QueuedOperation>;
  return typeof operation.operationId === "string"
    && typeof operation.unitId === "string"
    && typeof operation.prompt === "string"
    && ["create_lesson", "evaluate_answer", "coaching"].includes(String(operation.kind))
    && Boolean(operation.expectation)
    && typeof operation.deadlineAt === "number";
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
  const operation = (message as { operation?: unknown }).operation;
  if (!validOperation(operation)) {
    sendResponse({ ok: false, error: extensionError("INVALID_COMMAND", "The ChatGPT operation payload is invalid.") });
    return false;
  }
  if (activeOperationId) {
    sendResponse({ ok: false, error: extensionError("SEND_FAILED", `This ChatGPT tab is already processing operation ${activeOperationId}.`) });
    return false;
  }
  activeOperationId = operation.operationId;
  sendResponse({ ok: true, accepted: true, currentUrl: window.location.href } satisfies ChatCommandResponse);
  void runTrackedOperation(operation);
  return false;
});
