import type {
  ChatOperationState,
  ExtensionRequest,
  IntegrationStatus,
  OperationDispatchReceipt,
} from "../src/integration/protocol";
import { isAllowedMeoiOrigin } from "./integration-policy";
import {
  OPERATION_DEADLINE_MS,
  appendQueuedOperation,
  expiredActiveOperationIds,
  isTerminalPhase,
  pruneTerminalStates,
  publicOperationState,
  removeQueuedOperation,
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
} from "./shared";

const CHATGPT_NEW_CHAT = "https://chatgpt.com/";
const processingUnits = new Set<string>();
let storageMutation: Promise<void> = Promise.resolve();

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

function isChatUrl(value?: string): value is string {
  return Boolean(value && /^https:\/\/chatgpt\.com\/(?:c\/[A-Za-z0-9-]+)?(?:[?#].*)?$/.test(value));
}

function isConversationUrl(value?: string): value is string {
  return Boolean(value && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/.test(value));
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
  const url = chats[unitId];
  if (url) {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const existing = tabs.find((tab) => tab.url === url);
    if (existing?.id) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
      return { tab: await waitForTab(existing.id), newChat: false };
    }
    const tab = await chrome.tabs.create({ url, active: true });
    return { tab: await waitForTab(tab.id!), newChat: false };
  }
  const tab = await chrome.tabs.create({ url: CHATGPT_NEW_CHAT, active: true });
  return { tab: await waitForTab(tab.id!), newChat: true };
}

async function storeUnitChat(unitId: string, url?: string): Promise<void> {
  if (!isConversationUrl(url)) return;
  const chats = await getLocal<UnitChatMap>(STORAGE_KEYS.unitChats, {});
  if (chats[unitId] === url) return;
  await setLocal(STORAGE_KEYS.unitChats, { ...chats, [unitId]: url });
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

async function sendToChat(tabId: number, operation: QueuedOperation): Promise<ChatCommandResponse> {
  try {
    return await chrome.tabs.sendMessage(tabId, { kind: "MEOI_CHAT_COMMAND", operation }) as ChatCommandResponse;
  } catch (error) {
    return { ok: false, error: extensionError("SEND_FAILED", error instanceof Error ? error.message : "Cannot reach ChatGPT content script.") };
  }
}

function queuedOperation(request: ExtensionRequest<Record<string, unknown>>): QueuedOperation {
  const payload = request.payload;
  return {
    id: crypto.randomUUID(),
    command: "SEND_OPERATION",
    unitId: String(payload.unitId),
    operationId: String(payload.operationId),
    kind: payload.kind as QueuedOperation["kind"],
    prompt: String(payload.prompt),
    queuedAt: new Date().toISOString(),
  };
}

async function enqueueTracked(request: ExtensionRequest<Record<string, unknown>>): Promise<ChatOperationState> {
  const operation = queuedOperation(request);
  const state = await withStorageMutation(async () => {
    let states = pruneTerminalStates(await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {}));
    const existing = states[operation.operationId];
    if (existing) return publicOperationState(existing);
    const queues = appendQueuedOperation(await getSession<QueueMap>(STORAGE_KEYS.queues, {}), operation);
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

async function failOperation(operationId: string, error: ReturnType<typeof extensionError>, keepQueued = false): Promise<string | null> {
  return withStorageMutation(async () => {
    const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    const state = states[operationId];
    if (!state || isTerminalPhase(state.phase)) return null;
    let queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
    const next = keepQueued
      ? transitionOperation(state, "queued", new Date().toISOString(), { error, tabId: undefined, deadlineAt: undefined })
      : transitionOperation(state, "failed", new Date().toISOString(), { error, tabId: undefined, deadlineAt: undefined });
    if (!keepQueued) queues = removeQueuedOperation(queues, state.unitId, operationId);
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
    const operation = await withStorageMutation(async () => {
      const queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
      const next = queues[unitId]?.[0];
      if (!next) return null;
      const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
      const state = states[next.operationId];
      if (!state || state.phase !== "queued") return null;
      const opening = transitionOperation(state, "opening_chat", new Date().toISOString(), {
        error: undefined,
        result: undefined,
        repairAttempt: 0,
        deadlineAt: Date.now() + OPERATION_DEADLINE_MS,
      });
      await setSession(STORAGE_KEYS.operationStates, { ...states, [next.operationId]: opening });
      return next;
    });
    if (!operation) return;

    try {
      const { tab, newChat } = await openUnitChat(unitId);
      if (!tab.id) throw new Error("ChatGPT tab has no ID.");
      await withStorageMutation(async () => {
        const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
        const state = states[operation.operationId];
        if (!state || state.phase !== "opening_chat") return;
        await setSession(STORAGE_KEYS.operationStates, {
          ...states,
          [operation.operationId]: transitionOperation(state, "sending", new Date().toISOString(), { tabId: tab.id }),
        });
      });
      await setSession(STORAGE_KEYS.lastError, null);
      const response = await sendToChat(tab.id, operation);
      if (!response.ok || !response.accepted) {
        await failOperation(operation.operationId, response.error ?? extensionError("SEND_FAILED", "ChatGPT did not accept the operation."));
        dispatchNext = true;
        return;
      }
      if (newChat) void captureCreatedChat(unitId, tab.id);
      else await storeUnitChat(unitId, response.currentUrl ?? tab.url);
    } catch (error) {
      await failOperation(operation.operationId, extensionError("SEND_FAILED", error instanceof Error ? error.message : "Queue processing failed."));
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
    if (!current) throw new Error("OPERATION_STATE_NOT_FOUND");
    if (!isTerminalPhase(current.phase)) return publicOperationState(current);
    const queues = appendQueuedOperation(await getSession<QueueMap>(STORAGE_KEYS.queues, {}), current.operation);
    const queued = transitionOperation(current, "queued", new Date().toISOString(), {
      error: undefined,
      result: undefined,
      repairAttempt: 0,
      tabId: undefined,
      deadlineAt: undefined,
    });
    await chrome.storage.session.set({ [STORAGE_KEYS.queues]: queues, [STORAGE_KEYS.operationStates]: { ...states, [operationId]: queued } });
    return publicOperationState(queued);
  });
  void dispatchUnit(state.unitId);
  return state;
}

async function acknowledgeOperation(operationId: string): Promise<boolean> {
  return withStorageMutation(async () => {
    const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    const current = states[operationId];
    if (!current || !isTerminalPhase(current.phase)) return false;
    const next = { ...states };
    delete next[operationId];
    await setSession(STORAGE_KEYS.operationStates, next);
    return true;
  });
}

async function reconcileStoredState(): Promise<void> {
  const units = await withStorageMutation(async () => {
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
    if (states !== storedStates || expiredIds.length) {
      await chrome.storage.session.set({ [STORAGE_KEYS.queues]: queues, [STORAGE_KEYS.operationStates]: states });
    }
    return Object.entries(queues)
      .filter(([, queue]) => queue[0] && states[queue[0].operationId]?.phase === "queued")
      .map(([unitId]) => unitId);
  });
  await Promise.all(units.map(dispatchUnit));
}

async function handleChatOperationEvent(event: ChatOperationEvent, sender: chrome.runtime.MessageSender): Promise<void> {
  if (!chatSenderAllowed(sender)) return;
  const transition = await withStorageMutation(async () => {
    const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    const state = states[event.operationId];
    if (!state || isTerminalPhase(state.phase) || state.unitId !== event.unitId || state.tabId !== sender.tab?.id) return null;
    let queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
    let next: PersistedOperationState;
    if (event.phase === "completed") {
      if (!event.result) {
        next = transitionOperation(state, "failed", new Date().toISOString(), {
          error: extensionError("INVALID_CHATGPT_RESPONSE", "ChatGPT completed without a structured result."),
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
      if (error.code === "CHATGPT_LIMIT_REACHED") {
        next = transitionOperation(state, "queued", new Date().toISOString(), { error, tabId: undefined, deadlineAt: undefined });
      } else {
        next = transitionOperation(state, "failed", new Date().toISOString(), { error, tabId: undefined, deadlineAt: undefined });
        queues = removeQueuedOperation(queues, state.unitId, state.operationId);
      }
      await chrome.storage.session.set({
        [STORAGE_KEYS.lastError]: error,
        ...(error.code === "CHATGPT_LIMIT_REACHED" ? { [STORAGE_KEYS.paused]: true } : {}),
      });
    } else {
      next = transitionOperation(state, event.phase, new Date().toISOString(), { repairAttempt: event.repairAttempt ?? state.repairAttempt });
    }
    await chrome.storage.session.set({ [STORAGE_KEYS.queues]: queues, [STORAGE_KEYS.operationStates]: { ...states, [state.operationId]: next } });
    return { unitId: state.unitId, terminal: isTerminalPhase(next.phase), currentUrl: event.currentUrl };
  });
  if (!transition) return;
  await storeUnitChat(transition.unitId, transition.currentUrl);
  if (transition.terminal) void dispatchUnit(transition.unitId);
}

async function failOperationsForTab(tabId: number): Promise<void> {
  const units = await withStorageMutation(async () => {
    const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
    let queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
    const next = { ...states };
    const affected = new Set<string>();
    Object.values(states).forEach((state) => {
      if (state.tabId !== tabId || isTerminalPhase(state.phase)) return;
      const error = extensionError("CHATGPT_TAB_CHANGED", "The ChatGPT tab closed or navigated away before Meoi received its result.");
      next[state.operationId] = transitionOperation(state, "failed", new Date().toISOString(), { error, tabId: undefined, deadlineAt: undefined });
      queues = removeQueuedOperation(queues, state.unitId, state.operationId);
      affected.add(state.unitId);
    });
    await chrome.storage.session.set({ [STORAGE_KEYS.queues]: queues, [STORAGE_KEYS.operationStates]: next });
    return [...affected];
  });
  units.forEach((unitId) => void dispatchUnit(unitId));
}

async function storeConversationForTab(tabId: number, url: string): Promise<void> {
  if (!isConversationUrl(url)) return;
  const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
  const state = Object.values(states).find((candidate) => candidate.tabId === tabId && !isTerminalPhase(candidate.phase));
  if (state) await storeUnitChat(state.unitId, url);
}

async function handlePageRequest(request: ExtensionRequest<Record<string, unknown>>) {
  const payload = request.payload;
  switch (request.command) {
    case "SEND_OPERATION": {
      const state = await enqueueTracked(request);
      return { ok: true, data: { operationId: state.operationId, phase: "queued" } satisfies OperationDispatchReceipt };
    }
    case "GET_OPERATION_STATE": {
      const states = await getSession<OperationStateMap>(STORAGE_KEYS.operationStates, {});
      const state = states[String(payload.operationId)];
      return state
        ? { ok: true, data: publicOperationState(state) }
        : { ok: false, error: extensionError("OPERATION_STATE_NOT_FOUND", "The requested extension operation state was not found.") };
    }
    case "RETRY_OPERATION": {
      try {
        return { ok: true, data: await retryOperation(String(payload.operationId)) };
      } catch {
        return { ok: false, error: extensionError("OPERATION_STATE_NOT_FOUND", "The requested extension operation cannot be retried.") };
      }
    }
    case "ACK_OPERATION_RESULT":
      return { ok: true, data: { acknowledged: await acknowledgeOperation(String(payload.operationId)) } };
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
    void handleChatOperationEvent(message as ChatOperationEvent, sender).then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: extensionError("SEND_FAILED", error instanceof Error ? error.message : "Cannot store ChatGPT operation event.") });
    });
    return true;
  }

  if (kind === "MEOI_RETRY_CHATGPT" && chatSenderAllowed(sender)) {
    void (async () => {
      await setSession(STORAGE_KEYS.paused, false);
      await setSession(STORAGE_KEYS.lastError, null);
      const queues = await getSession<QueueMap>(STORAGE_KEYS.queues, {});
      await Promise.all(Object.keys(queues).map(dispatchUnit));
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (kind !== "MEOI_PAGE_REQUEST" || !senderAllowed(sender)) return false;
  const request = (message as { request: ExtensionRequest<Record<string, unknown>> }).request;
  void (async () => {
    await reconcileStoredState();
    return handlePageRequest(request);
  })().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: extensionError("SEND_FAILED", error instanceof Error ? error.message : "Extension command failed.") });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void failOperationsForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (isChatUrl(changeInfo.url)) void storeConversationForTab(tabId, changeInfo.url);
  else void failOperationsForTab(tabId);
});

chrome.runtime.onStartup.addListener(() => {
  void reconcileStoredState();
});

chrome.runtime.onInstalled.addListener(() => {
  void reconcileStoredState();
});
