import {
  MEOI_EXTENSION_PROTOCOL_VERSION,
  MEOI_PAGE_SOURCE,
  MEOI_PROMPT_MAX_BYTES,
  type ChatOperationKind,
  type ChatOperationState,
  type ExtensionError,
  type ExtensionRequest,
  type IntegrationStatus,
  type OperationDispatchReceipt,
  type OperationExpectation,
  type SendOperationPayload,
  type UnitOperationLookup,
} from "../src/integration/protocol";
import { LESSON_QUESTION_FORMATS, type QuestionFormat } from "../src/learning/types";
import { isAllowedMeoiOrigin } from "./integration-policy";
import {
  canonicalConversationUrl,
  conversationIdFromUrl,
  isChatUrl,
  isConversationUrl,
  isProjectHomeUrl,
  sameConversation,
} from "./chatgpt-url";
import {
  OPERATION_DEADLINE_MS,
  MAX_OUTSTANDING_OPERATIONS,
  acknowledgeTerminalOperation,
  appendQueuedOperation,
  enqueueDecision,
  expiredActiveOperationIds,
  failOperationsForTabState,
  hasLegacyTransientState,
  isTerminalPhase,
  latestUnitOperation,
  pruneTerminalStates,
  publicOperationState,
  recoverOpeningOperations,
  removeQueuedOperation,
  retryDecision,
  transitionOperation,
} from "./operation-state";
import {
  extensionError,
  STORAGE_KEYS,
  type ChatCommandResponse,
  type ChatOperationEvent,
  type OperationStateMap,
  type PersistedOperationState,
  type QueueMap,
  type QueuedOperation,
  type UnitChatMap,
  type UnitTabMap,
} from "./shared";

const CHATGPT_NEW_CHAT = "https://chatgpt.com/";
const CONTENT_SCRIPT_CONTACT_MS = 8_000;
const LEGACY_TRANSIENT_KEYS = [
  "meoi.queues.v1",
  "meoi.operationStates.v1",
  "meoi.queues.v2.session",
  "meoi.operationStates.v2.session",
  "meoi.provisionalUnitTabs.v2.session",
  "meoi.pausedForQuota.v2.session",
  "meoi.lastError.v2.session",
  "meoi.queues.v3.session",
  "meoi.operationStates.v3.session",
  "meoi.provisionalUnitTabs.v3.session",
  "meoi.pausedForQuota.v3.session",
  "meoi.lastError.v3.session",
];

const processingUnits = new Set<string>();
let storageMutation: Promise<void> = Promise.resolve();
let legacyStateChecked = false;
let workerRecoveryStarted = false;

class RequestFailure extends Error {
  readonly extensionError: ExtensionError;

  constructor(error: ExtensionError) {
    super(error.message);
    this.name = "RequestFailure";
    this.extensionError = error;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 120;
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 120
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validExpectation(value: unknown, unitId: string): value is OperationExpectation {
  if (!isRecord(value) || !exactKeys(value, [
    "unitId",
    "targetLanguage",
    "sourceLanguage",
    "level",
    "questionCount",
    "speaking",
    "allowedFormats",
  ])) return false;
  if (!Array.isArray(value.allowedFormats)) return false;
  const formatSet = new Set<string>(LESSON_QUESTION_FORMATS);
  const allowedFormats = value.allowedFormats.filter((format): format is QuestionFormat => typeof format === "string" && formatSet.has(format));
  if (allowedFormats.length !== value.allowedFormats.length || new Set(allowedFormats).size !== allowedFormats.length || allowedFormats.length < 5) return false;
  const aiFormats = new Set<QuestionFormat>(["translation", "shortAnswer", "freeWriting", "speakingRepeat", "speakingRoleplay"]);
  if (!allowedFormats.some((format) => aiFormats.has(format)) || !allowedFormats.some((format) => !aiFormats.has(format))) return false;
  return value.unitId === unitId
    && validId(value.unitId)
    && typeof value.targetLanguage === "string"
    && value.targetLanguage.trim().length > 0
    && value.targetLanguage.length <= 100
    && typeof value.sourceLanguage === "string"
    && value.sourceLanguage.trim().length > 0
    && value.sourceLanguage.length <= 100
    && ["beginner", "elementary", "intermediate", "upperIntermediate", "advanced"].includes(String(value.level))
    && Number.isInteger(value.questionCount)
    && Number(value.questionCount) >= 8
    && Number(value.questionCount) <= 15
    && typeof value.speaking === "boolean"
    && (value.speaking || !allowedFormats.some((format) => format === "speakingRepeat" || format === "speakingRoleplay"));
}

function validateSendPayload(value: unknown): SendOperationPayload {
  if (!isRecord(value) || !exactKeys(value, ["unitId", "operationId", "kind", "prompt", "expectation"])) {
    throw new RequestFailure(extensionError("INVALID_COMMAND", "SEND_OPERATION has an invalid payload shape."));
  }
  if (!validId(value.unitId) || !validOperationId(value.operationId)) {
    throw new RequestFailure(extensionError("INVALID_COMMAND", "The unit ID or operation ID is invalid."));
  }
  if (!["create_lesson", "evaluate_answer", "coaching"].includes(String(value.kind))) {
    throw new RequestFailure(extensionError("INVALID_COMMAND", "The operation kind is invalid."));
  }
  if (typeof value.prompt !== "string" || !value.prompt.trim()) {
    throw new RequestFailure(extensionError("INVALID_COMMAND", "The operation prompt is empty."));
  }
  if (byteLength(value.prompt) > MEOI_PROMPT_MAX_BYTES) {
    throw new RequestFailure(extensionError("PAYLOAD_TOO_LARGE", "The operation prompt exceeds the 640 KiB limit."));
  }
  if (!validExpectation(value.expectation, value.unitId)) {
    throw new RequestFailure(extensionError("INVALID_COMMAND", "The operation expectation is invalid or does not match the unit."));
  }
  return value as unknown as SendOperationPayload;
}

function validatePageRequest(value: unknown): ExtensionRequest<Record<string, unknown>> {
  if (!isRecord(value)
    || value.source !== MEOI_PAGE_SOURCE
    || value.version !== MEOI_EXTENSION_PROTOCOL_VERSION
    || typeof value.nonce !== "string"
    || value.nonce.length < 10
    || typeof value.requestId !== "string"
    || !validOperationId(value.requestId)
    || typeof value.command !== "string"
    || !["SEND_OPERATION", "OPEN_VOICE", "GET_INTEGRATION_STATUS", "GET_UNIT_OPERATION", "GET_OPERATION_STATE", "RETRY_OPERATION", "ACK_OPERATION_RESULT", "RESET_UNIT_CHAT"].includes(value.command)
    || !isRecord(value.payload)) {
    throw new RequestFailure(extensionError("INVALID_COMMAND", "The page request is invalid."));
  }
  if (value.command === "SEND_OPERATION") validateSendPayload(value.payload);
  if (["OPEN_VOICE", "RESET_UNIT_CHAT"].includes(value.command) && !validId(value.payload.unitId)) {
    throw new RequestFailure(extensionError("INVALID_COMMAND", `${value.command} requires a valid unit ID.`));
  }
  if (value.command === "GET_UNIT_OPERATION"
    && (!validId(value.payload.unitId)
      || (value.payload.kind !== undefined
        && !["create_lesson", "evaluate_answer", "coaching"].includes(String(value.payload.kind))))) {
    throw new RequestFailure(extensionError("INVALID_COMMAND", "GET_UNIT_OPERATION requires a valid unit ID and operation kind."));
  }
  if (["GET_OPERATION_STATE", "RETRY_OPERATION", "ACK_OPERATION_RESULT"].includes(value.command)
    && !validOperationId(value.payload.operationId)) {
    throw new RequestFailure(extensionError("INVALID_COMMAND", `${value.command} requires a valid operation ID.`));
  }
  return value as unknown as ExtensionRequest<Record<string, unknown>>;
}

async function getSession<T>(key: string, fallback: T): Promise<T> {
  const value = await chrome.storage.session.get(key);
  return (value[key] as T | undefined) ?? fallback;
}

async function setSession(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const value = await chrome.storage.local.get(key);
  return (value[key] as T | undefined) ?? fallback;
}

async function setLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

function withStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageMutation.then(operation, operation);
  storageMutation = result.then(() => undefined, () => undefined);
  return result;
}

function senderAllowed(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.url) return false;
  try { return isAllowedMeoiOrigin(new URL(sender.url).origin); } catch { return false; }
}

function chatSenderAllowed(sender: chrome.runtime.MessageSender): boolean {
  return Boolean(sender.url?.startsWith("https://chatgpt.com/") && sender.tab?.id);
}

function operationFromPayload(payload: SendOperationPayload): QueuedOperation {
  return { ...payload, queuedAt: new Date().toISOString() };
}

async function waitForTab(tabId: number): Promise<chrome.tabs.Tab> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return current;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("ChatGPT tab load timed out."));
    }, 20_000);
    function listener(updatedId: number, change: { status?: string }, tab: chrome.tabs.Tab) {
      if (updatedId !== tabId || change.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function openUnitChat(unitId: string): Promise<{ tab: chrome.tabs.Tab; newChat: boolean }> {
  const chats = await getLocal<UnitChatMap>(STORAGE_KEYS.unitChats, {});
  const url = canonicalConversationUrl(chats[unitId]);
  if (url) {
    const conversationId = conversationIdFromUrl(url);
    await clearProvisionalUnitTab(unitId);
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const existing = tabs.find((tab) => conversationId && conversationIdFromUrl(tab.url) === conversationId);
    if (existing?.id) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
      return { tab: await waitForTab(existing.id), newChat: false };
    }
    const tab = await chrome.tabs.create({ url, active: true });
    return { tab: await waitForTab(tab.id!), newChat: false };
  }

  const provisionalTabs = await getSession<UnitTabMap>(STORAGE_KEYS.provisionalTabs, {});
  const provisionalTabId = provisionalTabs[unitId];
  if (provisionalTabId) {
    const provisional = await chrome.tabs.get(provisionalTabId).catch(() => null);
    if (provisional?.id && isChatUrl(provisional.url)) {
      await chrome.tabs.update(provisional.id, { active: true });
      if (provisional.windowId) await chrome.windows.update(provisional.windowId, { focused: true });
      if (isConversationUrl(provisional.url)) {
        await storeUnitChat(unitId, provisional.url);
        return { tab: await waitForTab(provisional.id), newChat: false };
      }
      return { tab: await waitForTab(provisional.id), newChat: true };
    }
    await clearProvisionalUnitTab(unitId);
  }

  const tab = await chrome.tabs.create({ url: CHATGPT_NEW_CHAT, active: true });
  await setProvisionalUnitTab(unitId, tab.id!);
  return { tab: await waitForTab(tab.id!), newChat: true };
}

async function setProvisionalUnitTab(unitId: string, tabId: number): Promise<void> {
  await withStorageMutation(async () => {
    const tabs = await getSession<UnitTabMap>(STORAGE_KEYS.provisionalTabs, {});
    await setSession(STORAGE_KEYS.provisionalTabs, { ...tabs, [unitId]: tabId });
  });
}

async function clearProvisionalUnitTab(unitId: string): Promise<void> {
  await withStorageMutation(async () => {
    const tabs = await getSession<UnitTabMap>(STORAGE_KEYS.provisionalTabs, {});
    if (!(unitId in tabs)) return;
    const next = { ...tabs };
    delete next[unitId];
    await setSession(STORAGE_KEYS.provisionalTabs, next);
  });
}

async function clearProvisionalTabId(tabId: number): Promise<void> {
  await withStorageMutation(async () => {
    const tabs = await getSession<UnitTabMap>(STORAGE_KEYS.provisionalTabs, {});
    const next = Object.fromEntries(Object.entries(tabs).filter(([, mappedTabId]) => mappedTabId !== tabId));
    if (Object.keys(next).length === Object.keys(tabs).length) return;
    await setSession(STORAGE_KEYS.provisionalTabs, next);
  });
}

async function storeUnitChat(unitId: string, url?: string): Promise<void> {
  const canonicalUrl = canonicalConversationUrl(url);
  if (!canonicalUrl) return;
  const conversationId = conversationIdFromUrl(canonicalUrl);
  if (!conversationId) return;
  const chats = await getLocal<UnitChatMap>(STORAGE_KEYS.unitChats, {});
  const next = Object.fromEntries(Object.entries(chats).filter(([mappedUnitId, mappedUrl]) => (
    mappedUnitId === unitId || conversationIdFromUrl(mappedUrl) !== conversationId
  )));
  if (next[unitId] === canonicalUrl && Object.keys(next).length === Object.keys(chats).length) {
    await clearProvisionalUnitTab(unitId);
    return;
  }
  await setLocal(STORAGE_KEYS.unitChats, { ...next, [unitId]: canonicalUrl });
  await clearProvisionalUnitTab(unitId);
}

async function resetUnitChat(unitId: string): Promise<void> {
  await withStorageMutation(async () => {
    const chats = await getLocal<UnitChatMap>(STORAGE_KEYS.unitChats, {});
    const provisionalTabs = await getSession<UnitTabMap>(STORAGE_KEYS.provisionalTabs, {});
    const nextChats = { ...chats };
    const nextProvisionalTabs = { ...provisionalTabs };
    delete nextChats[unitId];
    delete nextProvisionalTabs[unitId];
    await chrome.storage.local.set({ [STORAGE_KEYS.unitChats]: nextChats });
    await chrome.storage.session.set({ [STORAGE_KEYS.provisionalTabs]: nextProvisionalTabs });
    await chrome.storage.session.remove(STORAGE_KEYS.lastError);
  });
}

async function captureCreatedChat(unitId: string, tabId: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (isConversationUrl(tab.url)) {
      await storeUnitChat(unitId, tab.url);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function sendToChat(tabId: number, operation: QueuedOperation, deadlineAt: number): Promise<ChatCommandResponse> {
  const contactDeadline = Math.min(deadlineAt, Date.now() + CONTENT_SCRIPT_CONTACT_MS);
  let lastMessage = "Cannot reach the ChatGPT content script.";
  while (Date.now() < contactDeadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !isChatUrl(tab.url)) {
      return { ok: false, error: extensionError("CHATGPT_TAB_CHANGED", "The ChatGPT tab closed or navigated away before the operation was sent.") };
    }
    try {
      return await chrome.tabs.sendMessage(tabId, {
        kind: "MEOI_CHAT_COMMAND",
        operation: { ...operation, deadlineAt },
      }) as ChatCommandResponse;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : lastMessage;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return { ok: false, error: extensionError("SEND_FAILED", lastMessage) };
}

async function enqueueTracked(payload: SendOperationPayload): Promise<ChatOperationState> {
  const operation = operationFromPayload(payload);
  const state = await withStorageMutation(async () => {
    let states = pruneTerminalStates(await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {}));
    const decision = enqueueDecision(states, operation);
    if (decision === "existing") return publicOperationState(states[operation.operationId]);
    if (decision === "conflict") {
      throw new RequestFailure(extensionError("OPERATION_ID_CONFLICT", "This operation ID is already attached to different input."));
    }
    if (decision === "full") {
      throw new RequestFailure(extensionError("QUEUE_FULL", "Meoi Bridge already has four outstanding operations. Wait for one to finish before sending another."));
    }
    const queues = appendQueuedOperation(await getSession<QueueMap>(STORAGE_KEYS.queues, {}), operation.unitId, operation.operationId);
    const now = new Date().toISOString();
    const created: PersistedOperationState = {
      operationId: operation.operationId,
      unitId: operation.unitId,
      phase: "queued",
      repairAttempt: 0,
      updatedAt: now,
      operation,
    };
    states = { ...states, [operation.operationId]: created };
    await chrome.storage.session.set({ [STORAGE_KEYS.queues]: queues, [STORAGE_KEYS.operationStates]: states });
    return publicOperationState(created);
  });
  void dispatchUnit(operation.unitId);
  return state;
}

async function failOperation(operationId: string, error: ExtensionError): Promise<string | null> {
  return withStorageMutation(async () => {
    const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    const state = states[operationId];
    if (!state || isTerminalPhase(state.phase)) return null;
    const queues = removeQueuedOperation(await getSession<QueueMap>(STORAGE_KEYS.queues, {}), state.unitId, operationId);
    const next = transitionOperation(state, "failed", new Date().toISOString(), {
      error,
      tabId: undefined,
      deadlineAt: undefined,
    });
    await chrome.storage.session.set({
      [STORAGE_KEYS.queues]: queues,
      [STORAGE_KEYS.operationStates]: { ...states, [operationId]: next },
      [STORAGE_KEYS.lastError]: error,
      ...(error.code === "CHATGPT_LIMIT_REACHED" ? { [STORAGE_KEYS.paused]: true } : {}),
    });
    return state.unitId;
  });
}

async function dispatchUnit(unitId: string): Promise<void> {
  if (processingUnits.has(unitId) || await getSession(STORAGE_KEYS.paused, false)) return;
  processingUnits.add(unitId);
  let dispatchNext = false;
  try {
    const pending = await withStorageMutation(async () => {
      const queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
      const operationId = queues[unitId]?.[0];
      if (!operationId) return null;
      const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
      const state = states[operationId];
      if (!state || state.phase !== "queued") return null;
      const deadlineAt = Date.now() + OPERATION_DEADLINE_MS;
      const opening = transitionOperation(state, "opening_chat", new Date().toISOString(), {
        error: undefined,
        result: undefined,
        repairAttempt: 0,
        deadlineAt,
      });
      await setSession(STORAGE_KEYS.operationStates, { ...states, [operationId]: opening });
      return { operation: state.operation, deadlineAt };
    });
    if (!pending) return;

    try {
      const { tab, newChat } = await openUnitChat(unitId);
      if (!tab.id) throw new Error("ChatGPT tab has no ID.");
      const claimed = await withStorageMutation(async () => {
        const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
        const state = states[pending.operation.operationId];
        if (!state || state.phase !== "opening_chat") return false;
        await setSession(STORAGE_KEYS.operationStates, {
          ...states,
          [state.operationId]: transitionOperation(state, "sending", new Date().toISOString(), { tabId: tab.id }),
        });
        return true;
      });
      if (!claimed) return;
      await setSession(STORAGE_KEYS.lastError, null);
      const response = await sendToChat(tab.id, pending.operation, pending.deadlineAt);
      if (!response.ok || !response.accepted) {
        await failOperation(pending.operation.operationId, response.error ?? extensionError("SEND_FAILED", "ChatGPT did not accept the operation."));
        dispatchNext = true;
        return;
      }
      if (newChat) void captureCreatedChat(unitId, tab.id);
      else await storeUnitChat(unitId, response.currentUrl ?? tab.url);
    } catch (error) {
      await failOperation(pending.operation.operationId, extensionError("SEND_FAILED", error instanceof Error ? error.message : "Queue processing failed."));
      dispatchNext = true;
    }
  } finally {
    processingUnits.delete(unitId);
    if (dispatchNext) void dispatchUnit(unitId);
  }
}

async function integrationStatus(unitId?: string): Promise<IntegrationStatus> {
  const [chats, queues, paused, lastError, states] = await Promise.all([
    getLocal<UnitChatMap>(STORAGE_KEYS.unitChats, {}),
    getSession<QueueMap>(STORAGE_KEYS.queues, {}),
    getSession(STORAGE_KEYS.paused, false),
    getSession<IntegrationStatus["lastError"]>(STORAGE_KEYS.lastError, undefined),
    getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {}),
  ]);
  const operationStates = Object.values(states);
  return {
    installed: true,
    extensionVersion: chrome.runtime.getManifest().version,
    pausedForQuota: paused,
    unitChatUrl: unitId ? chats[unitId] : undefined,
    queueLength: Object.values(queues).reduce((total, queue) => total + queue.length, 0),
    activeOperationCount: operationStates.filter((state) => !isTerminalPhase(state.phase)).length,
    completedOperationCount: operationStates.filter((state) => state.phase === "completed").length,
    lastError,
  };
}

async function retryOperation(operationId: string): Promise<ChatOperationState> {
  const state = await withStorageMutation(async () => {
    const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    const current = states[operationId];
    const decision = retryDecision(current);
    if (decision === "missing") throw new RequestFailure(extensionError("OPERATION_STATE_NOT_FOUND", "The requested operation was not found."));
    if (!current) throw new Error("Unreachable retry state.");
    if (decision === "completed" || decision === "existing") return publicOperationState(current);
    const outstanding = Object.values(states).filter((candidate) => !isTerminalPhase(candidate.phase)).length;
    if (outstanding >= MAX_OUTSTANDING_OPERATIONS) {
      throw new RequestFailure(extensionError("QUEUE_FULL", "Meoi Bridge already has four outstanding operations."));
    }
    const queues = appendQueuedOperation(await getSession<QueueMap>(STORAGE_KEYS.queues, {}), current.unitId, current.operationId);
    const queued = transitionOperation(current, "queued", new Date().toISOString(), {
      error: undefined,
      result: undefined,
      repairAttempt: 0,
      tabId: undefined,
      deadlineAt: undefined,
    });
    await chrome.storage.session.set({
      [STORAGE_KEYS.queues]: queues,
      [STORAGE_KEYS.operationStates]: { ...states, [operationId]: queued },
      [STORAGE_KEYS.paused]: false,
    });
    await chrome.storage.session.remove(STORAGE_KEYS.lastError);
    return publicOperationState(queued);
  });
  void dispatchUnit(state.unitId);
  return state;
}

async function acknowledgeOperation(operationId: string): Promise<boolean> {
  return withStorageMutation(async () => {
    const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    const queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
    const acknowledged = acknowledgeTerminalOperation(states, queues, operationId);
    if (!acknowledged.acknowledged) return false;
    await chrome.storage.session.set({
      [STORAGE_KEYS.operationStates]: acknowledged.states,
      [STORAGE_KEYS.queues]: acknowledged.queues,
    });
    return true;
  });
}

async function discardLegacyTransientState(): Promise<void> {
  if (legacyStateChecked) return;
  legacyStateChecked = true;
  const legacy = await chrome.storage.session.get(LEGACY_TRANSIENT_KEYS);
  if (!hasLegacyTransientState(legacy, LEGACY_TRANSIENT_KEYS)) return;
  await chrome.storage.session.remove(LEGACY_TRANSIENT_KEYS);
  await setSession(STORAGE_KEYS.lastError, extensionError(
    "OPERATION_STATE_NOT_FOUND",
    "An unfinished queue from an older bridge version was not replayed. Retry the action from Meoi.",
  ));
}

async function reconcileStoredState(): Promise<void> {
  const recoverInterruptedWork = !workerRecoveryStarted;
  workerRecoveryStarted = true;
  await discardLegacyTransientState();
  const [units, inFlight] = await withStorageMutation(async () => {
    const storedStates = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    let states = pruneTerminalStates(storedStates);
    let queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
    const expiredIds = expiredActiveOperationIds(states);
    expiredIds.forEach((operationId) => {
      const state = states[operationId];
      queues = removeQueuedOperation(queues, state.unitId, operationId);
      states = {
        ...states,
        [operationId]: transitionOperation(state, "failed", new Date().toISOString(), {
          error: extensionError("CHATGPT_RESPONSE_TIMEOUT", "ChatGPT operation expired before a result was received."),
          tabId: undefined,
          deadlineAt: undefined,
        }),
      };
    });
    Object.entries(queues).forEach(([unitId, operationIds]) => {
      const valid = operationIds.filter((operationId) => states[operationId]?.unitId === unitId && states[operationId]?.phase === "queued");
      if (valid.length) queues = { ...queues, [unitId]: valid };
      else if (operationIds.length) {
        queues = { ...queues };
        delete queues[unitId];
      }
    });
    if (recoverInterruptedWork) {
      const recovered = recoverOpeningOperations(states, queues);
      states = recovered.states;
      queues = recovered.queues;
    }
    await chrome.storage.session.set({ [STORAGE_KEYS.queues]: queues, [STORAGE_KEYS.operationStates]: states });
    return [
      Object.entries(queues).filter(([, ids]) => ids.length > 0).map(([unitId]) => unitId),
      recoverInterruptedWork
        ? Object.values(states).filter((state) => ["sending", "awaiting_response", "repairing_response"].includes(state.phase))
        : [],
    ] as const;
  });

  await Promise.all(inFlight.map(async (state) => {
    if (!state.tabId) {
      await failOperation(state.operationId, extensionError("SEND_FAILED", "The extension restarted before it could confirm the ChatGPT tab. Retry this operation."));
      return;
    }
    try {
      const status = await chrome.tabs.sendMessage(state.tabId, { kind: "MEOI_GET_CHAT_OPERATION_STATUS" }) as { activeOperationId?: string };
      if (status.activeOperationId !== state.operationId) {
        await failOperation(state.operationId, extensionError("SEND_FAILED", "The extension restarted and could not confirm the in-flight operation. Retry it from Meoi."));
      }
    } catch {
      await failOperation(state.operationId, extensionError("SEND_FAILED", "The extension restarted and lost contact with the in-flight ChatGPT tab. Retry it from Meoi."));
    }
  }));
  await Promise.all(units.map(dispatchUnit));
}

async function handleChatOperationEvent(event: ChatOperationEvent, sender: chrome.runtime.MessageSender): Promise<void> {
  const transition = await withStorageMutation(async () => {
    const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    const state = states[event.operationId];
    if (!state || isTerminalPhase(state.phase)) return null;
    if (state.unitId !== event.unitId || state.tabId !== sender.tab?.id) {
      throw new RequestFailure(extensionError("INVALID_COMMAND", "The ChatGPT operation event does not match its stored operation."));
    }
    let queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
    let next: PersistedOperationState;
    if (event.phase === "completed") {
      if (!event.result || event.result.operationId !== state.operationId || event.result.kind !== state.operation.kind) {
        next = transitionOperation(state, "failed", new Date().toISOString(), {
          error: extensionError("INVALID_CHATGPT_RESPONSE", "ChatGPT completed without a matching structured result."),
          tabId: undefined,
          deadlineAt: undefined,
        });
      } else {
        next = transitionOperation(state, "completed", new Date().toISOString(), {
          result: event.result,
          error: undefined,
          repairAttempt: event.repairAttempt ?? state.repairAttempt,
          tabId: undefined,
          deadlineAt: undefined,
        });
      }
      queues = removeQueuedOperation(queues, state.unitId, state.operationId);
    } else if (event.phase === "failed") {
      const error = event.error ?? extensionError("SEND_FAILED", "ChatGPT operation failed.");
      next = transitionOperation(state, "failed", new Date().toISOString(), { error, tabId: undefined, deadlineAt: undefined });
      queues = removeQueuedOperation(queues, state.unitId, state.operationId);
      await chrome.storage.session.set({
        [STORAGE_KEYS.lastError]: error,
        ...(error.code === "CHATGPT_LIMIT_REACHED" ? { [STORAGE_KEYS.paused]: true } : {}),
      });
    } else {
      next = transitionOperation(state, event.phase, new Date().toISOString(), { repairAttempt: event.repairAttempt ?? state.repairAttempt });
    }
    await chrome.storage.session.set({
      [STORAGE_KEYS.queues]: queues,
      [STORAGE_KEYS.operationStates]: { ...states, [state.operationId]: next },
      ...(event.projectWarning ? { [STORAGE_KEYS.lastError]: event.projectWarning } : {}),
    });
    return { unitId: state.unitId, terminal: isTerminalPhase(next.phase), currentUrl: event.currentUrl };
  });
  if (!transition) return;
  await storeUnitChat(transition.unitId, transition.currentUrl);
  if (transition.terminal) void dispatchUnit(transition.unitId);
}

async function failOperationsForTab(tabId: number): Promise<void> {
  const affectedUnitIds = await withStorageMutation(async () => {
    const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    const queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
    const error = extensionError("CHATGPT_TAB_CHANGED", "The ChatGPT tab closed or navigated away before Meoi received its result.");
    const failed = failOperationsForTabState(states, queues, tabId, error);
    if (!failed.affectedUnitIds.length) return [];
    await chrome.storage.session.set({
      [STORAGE_KEYS.operationStates]: failed.states,
      [STORAGE_KEYS.queues]: failed.queues,
      [STORAGE_KEYS.lastError]: error,
    });
    return failed.affectedUnitIds;
  });
  affectedUnitIds.forEach((unitId) => void dispatchUnit(unitId));
}

async function handleChatTabUrlChange(tabId: number, url: string): Promise<void> {
  const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
  const state = Object.values(states).find((candidate) => candidate.tabId === tabId && !isTerminalPhase(candidate.phase));
  if (!state) return;
  if (isProjectHomeUrl(url)) return;
  if (!isChatUrl(url)) {
    await failOperationsForTab(tabId);
    return;
  }
  if (!isConversationUrl(url)) return;
  const chats = await getLocal<UnitChatMap>(STORAGE_KEYS.unitChats, {});
  const mappedUrl = canonicalConversationUrl(chats[state.unitId]);
  if (mappedUrl && !sameConversation(mappedUrl, url)) {
    await failOperation(state.operationId, extensionError("CHATGPT_TAB_CHANGED", "The ChatGPT conversation changed before Meoi received its result."));
    return;
  }
  await storeUnitChat(state.unitId, url);
}

async function handlePageRequest(request: ExtensionRequest<Record<string, unknown>>) {
  const payload = request.payload;
  switch (request.command) {
    case "SEND_OPERATION": {
      const state = await enqueueTracked(validateSendPayload(payload));
      return { ok: true, data: { operationId: state.operationId, phase: "queued" } satisfies OperationDispatchReceipt };
    }
    case "GET_OPERATION_STATE": {
      const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
      const state = states[String(payload.operationId)];
      return state
        ? { ok: true, data: publicOperationState(state) }
        : { ok: false, error: extensionError("OPERATION_STATE_NOT_FOUND", "The requested extension operation state was not found.") };
    }
    case "GET_UNIT_OPERATION": {
      const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
      const kind = typeof payload.kind === "string"
        ? payload.kind as ChatOperationKind
        : undefined;
      const state = latestUnitOperation(states, String(payload.unitId), kind);
      return {
        ok: true,
        data: {
          operation: state ? publicOperationState(state) : null,
        } satisfies UnitOperationLookup,
      };
    }
    case "RETRY_OPERATION":
      return { ok: true, data: await retryOperation(String(payload.operationId)) };
    case "ACK_OPERATION_RESULT":
      return { ok: true, data: { acknowledged: await acknowledgeOperation(String(payload.operationId)) } };
    case "RESET_UNIT_CHAT":
      await resetUnitChat(String(payload.unitId));
      return { ok: true, data: { reset: true } };
    case "OPEN_VOICE": {
      const opened = await openUnitChat(String(payload.unitId));
      const response = await chrome.tabs.sendMessage(opened.tab.id!, { kind: "MEOI_OPEN_VOICE" }) as ChatCommandResponse;
      return response.ok ? { ok: true, data: { opened: true } } : { ok: false, error: response.error };
    }
    case "GET_INTEGRATION_STATUS":
      return { ok: true, data: await integrationStatus(typeof payload.unitId === "string" ? payload.unitId : undefined) };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const kind = (message as { kind?: string }).kind;

  if (kind === "MEOI_CHAT_OPERATION_EVENT" && chatSenderAllowed(sender)) {
    void handleChatOperationEvent(message as ChatOperationEvent, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof RequestFailure
          ? error.extensionError
          : extensionError("SEND_FAILED", error instanceof Error ? error.message : "Cannot store ChatGPT operation event."),
      }));
    return true;
  }

  if (kind !== "MEOI_PAGE_REQUEST" || !senderAllowed(sender)) return false;
  void (async () => {
    const request = validatePageRequest((message as { request?: unknown }).request);
    await reconcileStoredState();
    return handlePageRequest(request);
  })().then(sendResponse).catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof RequestFailure
        ? error.extensionError
        : extensionError("SEND_FAILED", error instanceof Error ? error.message : "Extension command failed."),
    });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void failOperationsForTab(tabId);
  void clearProvisionalTabId(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) void handleChatTabUrlChange(tabId, changeInfo.url);
});

chrome.runtime.onStartup.addListener(() => {
  void reconcileStoredState();
});

chrome.runtime.onInstalled.addListener(() => {
  void reconcileStoredState();
});
