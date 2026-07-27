import {
  MEOI_EXTENSION_MIN_VERSION,
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
const COMPATIBILITY_TIMEOUT_MS = 2_000;
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const OPERATION_POLL_MS = 1_000;
const SUPPORTED_STATUS_PROTOCOLS = [MEOI_EXTENSION_PROTOCOL_VERSION, 7, 6, 5, 4] as const;

export type ExtensionCompatibility =
  | { state: "ready"; version: typeof MEOI_EXTENSION_PROTOCOL_VERSION; integration: IntegrationStatus }
  | { state: "outdated"; version: 4 | 5 | 6 | 7 | 8; integration: IntegrationStatus }
  | { state: "unavailable" };

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

function isExtensionResponse(
  value: unknown,
  nonce: string,
  version: number,
): value is ExtensionResponse & { version: number } {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<ExtensionResponse>;
  return response.source === MEOI_EXTENSION_SOURCE
    && response.version === version
    && response.nonce === nonce
    && typeof response.requestId === "string"
    && typeof response.ok === "boolean";
}

function versionParts(value: string): number[] | null {
  if (!/^\d+(?:\.\d+){0,3}$/.test(value)) return null;
  return value.split(".").map(Number);
}

export function extensionVersionAtLeast(
  value: string | undefined,
  minimum = MEOI_EXTENSION_MIN_VERSION,
): boolean {
  if (!value) return false;
  const current = versionParts(value);
  const required = versionParts(minimum);
  if (!current || !required) return false;
  const length = Math.max(current.length, required.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (current[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
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
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: number;
    version: number;
  }>();
  private listening = false;

  private listen() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin || !event.data || typeof event.data !== "object") return;
      const requestId = (event.data as { requestId?: unknown }).requestId;
      if (typeof requestId !== "string") return;
      const pending = this.pending.get(requestId);
      if (!pending || !isExtensionResponse(event.data, this.nonce, pending.version)) return;
      window.clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      if (event.data.ok) pending.resolve(event.data.data);
      else pending.reject(new ExtensionBridgeError(
        event.data.error?.code ?? "SEND_FAILED",
        event.data.error?.message ?? "The extension could not process this request.",
      ));
    });
  }

  private async sendVersioned<TResponse = unknown, TPayload = unknown>(
    command: ExtensionCommand,
    payload: TPayload,
    version: number,
    timeoutMs: number,
  ): Promise<TResponse> {
    this.listen();
    const requestId = crypto.randomUUID();
    const request = {
      source: MEOI_PAGE_SOURCE,
      version,
      nonce: this.nonce,
      requestId,
      command,
      payload,
    } satisfies Omit<ExtensionRequest<TPayload>, "version"> & { version: number };
    return new Promise<TResponse>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ExtensionBridgeError("EXTENSION_NOT_READY", "Meoi Bridge was not found or did not respond."));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as TResponse),
        reject,
        timeout,
        version,
      });
      window.postMessage(request, window.location.origin);
    });
  }

  async send<TResponse = unknown, TPayload = unknown>(command: ExtensionCommand, payload: TPayload): Promise<TResponse> {
    return this.sendVersioned(command, payload, MEOI_EXTENSION_PROTOCOL_VERSION, REQUEST_TIMEOUT_MS);
  }

  getStatus(unitId?: string): Promise<IntegrationStatus> {
    return this.send<IntegrationStatus>("GET_INTEGRATION_STATUS", { unitId });
  }

  async detectCompatibility(unitId?: string): Promise<ExtensionCompatibility> {
    const probes = await Promise.all(SUPPORTED_STATUS_PROTOCOLS.map(async (version) => {
      try {
        const integration = await this.sendVersioned<IntegrationStatus>(
          "GET_INTEGRATION_STATUS",
          { unitId },
          version,
          COMPATIBILITY_TIMEOUT_MS,
        );
        return integration.installed ? { version, integration } : null;
      } catch {
        return null;
      }
    }));
    const detected = probes.find((probe) => probe?.version === MEOI_EXTENSION_PROTOCOL_VERSION)
      ?? probes.find((probe) => probe !== null);
    if (!detected) return { state: "unavailable" };
    if (
      detected.version === MEOI_EXTENSION_PROTOCOL_VERSION
      && extensionVersionAtLeast(detected.integration.extensionVersion)
    ) {
      return {
        state: "ready",
        version: MEOI_EXTENSION_PROTOCOL_VERSION,
        integration: detected.integration,
      };
    }
    return {
      state: "outdated",
      version: detected.version as 4 | 5 | 6 | 7 | 8,
      integration: detected.integration,
    };
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
