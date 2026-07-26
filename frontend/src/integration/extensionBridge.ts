import {
  MEOI_EXTENSION_PROTOCOL_VERSION,
  MEOI_EXTENSION_SOURCE,
  MEOI_PAGE_SOURCE,
  type ChatOperationState,
  type ExtensionCommand,
  type ExtensionErrorCode,
  type ExtensionRequest,
  type ExtensionResponse,
  type IntegrationStatus,
  type OperationDispatchReceipt,
  type OperationStatePayload,
  type SendOperationPayload,
} from "./protocol";

const REQUEST_TIMEOUT_MS = 20_000;
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const OPERATION_POLL_MS = 1_000;

export interface WaitForOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onState?: (state: ChatOperationState) => void;
}

export class ExtensionBridgeError extends Error {
  readonly code: ExtensionErrorCode;
  readonly state?: ChatOperationState;

  constructor(code: ExtensionErrorCode, message: string, state?: ChatOperationState) {
    super(message);
    this.name = "ExtensionBridgeError";
    this.code = code;
    this.state = state;
  }
}

function isExtensionResponse(value: unknown, nonce: string): value is ExtensionResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<ExtensionResponse>;
  return response.source === MEOI_EXTENSION_SOURCE
    && response.version === MEOI_EXTENSION_PROTOCOL_VERSION
    && response.nonce === nonce
    && typeof response.requestId === "string"
    && typeof response.ok === "boolean";
}

function abortReason(signal?: AbortSignal): unknown {
  if (!signal?.aborted) return null;
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const reason = abortReason(signal);
  if (reason) return Promise.reject(reason);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      window.clearTimeout(timeout);
      reject(abortReason(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  const reason = abortReason(signal);
  if (reason) return Promise.reject(reason);
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    function onAbort() {
      reject(abortReason(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class ExtensionBridge {
  private readonly nonce = crypto.randomUUID();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: number }>();
  private listening = false;

  private listen() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin || !isExtensionResponse(event.data, this.nonce)) return;
      const pending = this.pending.get(event.data.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      this.pending.delete(event.data.requestId);
      if (event.data.ok) pending.resolve(event.data.data);
      else pending.reject(new ExtensionBridgeError(
        event.data.error?.code ?? "SEND_FAILED",
        event.data.error?.message ?? "The extension could not process this request.",
      ));
    });
  }

  async send<TResponse = unknown, TPayload = unknown>(command: ExtensionCommand, payload: TPayload): Promise<TResponse> {
    this.listen();
    const requestId = crypto.randomUUID();
    const request: ExtensionRequest<TPayload> = {
      source: MEOI_PAGE_SOURCE,
      version: MEOI_EXTENSION_PROTOCOL_VERSION,
      nonce: this.nonce,
      requestId,
      command,
      payload,
    };
    return new Promise<TResponse>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ExtensionBridgeError("EXTENSION_NOT_READY", "Meoi Bridge was not found or did not respond."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve: (value) => resolve(value as TResponse), reject, timeout });
      window.postMessage(request, window.location.origin);
    });
  }

  getStatus(unitId?: string): Promise<IntegrationStatus> {
    return this.send<IntegrationStatus>("GET_INTEGRATION_STATUS", { unitId });
  }

  getOperationState(operationId: string): Promise<ChatOperationState> {
    return this.send<ChatOperationState, OperationStatePayload>("GET_OPERATION_STATE", { operationId });
  }

  async waitForOperation(operationId: string, options: WaitForOperationOptions = {}): Promise<ChatOperationState> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? OPERATION_POLL_MS;
    while (Date.now() - startedAt < timeoutMs) {
      const reason = abortReason(options.signal);
      if (reason) throw reason;
      const state = await withAbort(this.getOperationState(operationId), options.signal);
      options.onState?.(state);
      if (state.phase === "completed") {
        if (!state.result) throw new ExtensionBridgeError("INVALID_CHATGPT_RESPONSE", "Extension completed without a ChatGPT result.", state);
        return state;
      }
      if (state.phase === "failed") {
        throw new ExtensionBridgeError(state.error?.code ?? "SEND_FAILED", state.error?.message ?? "ChatGPT operation failed.", state);
      }
      await wait(pollIntervalMs, options.signal);
    }
    throw new ExtensionBridgeError("CHATGPT_RESPONSE_TIMEOUT", "Extension did not receive a ChatGPT result within ten minutes.");
  }

  async dispatchAndWait(payload: SendOperationPayload, options: WaitForOperationOptions = {}): Promise<ChatOperationState> {
    const reason = abortReason(options.signal);
    if (reason) throw reason;
    await withAbort(this.send<OperationDispatchReceipt, SendOperationPayload>("SEND_OPERATION", payload), options.signal);
    const postDispatchReason = abortReason(options.signal);
    if (postDispatchReason) throw postDispatchReason;
    return this.waitForOperation(payload.operationId, options);
  }

  async retryAndWait(operationId: string, options: WaitForOperationOptions = {}): Promise<ChatOperationState> {
    await withAbort(this.send<ChatOperationState, OperationStatePayload>("RETRY_OPERATION", { operationId }), options.signal);
    return this.waitForOperation(operationId, options);
  }

  async resetUnitChat(unitId: string): Promise<boolean> {
    const result = await this.send<{ reset: boolean }, { unitId: string }>("RESET_UNIT_CHAT", { unitId });
    return result.reset;
  }

  async acknowledgeOperation(operationId: string): Promise<boolean> {
    const result = await this.send<{ acknowledged: boolean }, OperationStatePayload>("ACK_OPERATION_RESULT", { operationId });
    return result.acknowledged;
  }
}

export const extensionBridge = new ExtensionBridge();
