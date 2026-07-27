// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionBridge } from "./extensionBridge";
import type {
  ChatOperationState,
  ExtensionCommand,
  IntegrationStatus,
  SendOperationPayload,
} from "./protocol";
import { LESSON_QUESTION_FORMATS } from "../learning/types";

function state(phase: ChatOperationState["phase"], patch: Partial<ChatOperationState> = {}): ChatOperationState {
  return {
    operationId: "op-1",
    unitId: "unit-1",
    phase,
    repairAttempt: phase === "repairing_response" ? 2 : 0,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

class StubBridge extends ExtensionBridge {
  private index = 0;

  constructor(private readonly states: ChatOperationState[]) {
    super();
  }

  override async getOperationState(): Promise<ChatOperationState> {
    const next = this.states[Math.min(this.index, this.states.length - 1)];
    this.index += 1;
    return next;
  }
}

class DispatchStubBridge extends StubBridge {
  readonly commands: ExtensionCommand[] = [];
  readonly payloads: unknown[] = [];

  override async send<TResponse = unknown, TPayload = unknown>(command: ExtensionCommand, payload: TPayload): Promise<TResponse> {
    this.commands.push(command);
    this.payloads.push(payload);
    if (command === "RESET_UNIT_CHAT") return { reset: true } as TResponse;
    return { operationId: "op-1", phase: "queued" } as TResponse;
  }
}

const payload: SendOperationPayload = {
  unitId: "unit-1",
  operationId: "op-1",
  kind: "coaching",
  prompt: "prompt",
  expectation: {
    unitId: "unit-1",
    targetLanguage: "English",
    sourceLanguage: "Vietnamese",
    level: "elementary",
    questionCount: 10,
    speaking: false,
    allowedFormats: LESSON_QUESTION_FORMATS.filter((format) => format !== "speakingRepeat" && format !== "speakingRoleplay"),
  },
};

const integrationStatus: IntegrationStatus = {
  installed: true,
  extensionVersion: "8.0.1",
  pausedForQuota: false,
  queueLength: 0,
};

function respondToStatusVersions(versions: number[]) {
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    const request = message as {
      command?: string;
      nonce?: string;
      requestId?: string;
      version?: number;
    };
    if (request.command !== "GET_INTEGRATION_STATUS" || !versions.includes(request.version ?? -1)) return;
    queueMicrotask(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          source: "meoi-extension",
          version: request.version,
          nonce: request.nonce,
          requestId: request.requestId,
          ok: true,
          data: integrationStatus,
        },
        origin: window.location.origin,
        source: window,
      }));
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ExtensionBridge operation waiting", () => {
  it("reports session phases until a direct result is complete", async () => {
    const seen: string[] = [];
    const bridge = new StubBridge([
      state("queued"),
      state("repairing_response"),
      state("completed", {
        result: {
          type: "meoi.operation.result",
          protocolVersion: 8,
          operationId: "op-1",
          kind: "coaching",
          outcome: "completed",
          result: { coachingReply: "Try a different example." },
        },
      }),
    ]);
    const result = await bridge.waitForOperation("op-1", { pollIntervalMs: 1, onState: (current) => seen.push(current.phase) });
    expect(seen).toEqual(["queued", "repairing_response", "completed"]);
    expect(result.result?.result?.coachingReply).toBe("Try a different example.");
  });

  it("surfaces the stored extension error", async () => {
    const bridge = new StubBridge([
      state("failed", { error: { code: "CHATGPT_TAB_CHANGED", message: "tab changed" } }),
    ]);
    await expect(bridge.waitForOperation("op-1", { pollIntervalMs: 1 })).rejects.toMatchObject({
      code: "CHATGPT_TAB_CHANGED",
      message: "tab changed",
    });
  });

  it("honors AbortSignal without acknowledging or retrying the operation", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    const bridge = new StubBridge([state("queued")]);
    await expect(bridge.waitForOperation("op-1", { signal: controller.signal, pollIntervalMs: 1 })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("enqueues once and then polls until the terminal result", async () => {
    const bridge = new DispatchStubBridge([
      state("queued"),
      state("completed", {
        result: {
          type: "meoi.operation.result",
          protocolVersion: 8,
          operationId: "op-1",
          kind: "coaching",
          outcome: "completed",
          result: { coachingReply: "A concise explanation." },
        },
      }),
    ]);
    const result = await bridge.dispatchAndWait(payload, { pollIntervalMs: 1 });
    expect(bridge.commands).toEqual(["SEND_OPERATION"]);
    expect(result.result?.result?.coachingReply).toBe("A concise explanation.");
  });

  it("does not enqueue when already aborted", async () => {
    const bridge = new DispatchStubBridge([state("queued")]);
    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(bridge.dispatchAndWait(payload, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge.commands).toEqual([]);
  });

  it("resets only the requested unit chat mapping", async () => {
    const bridge = new DispatchStubBridge([state("queued")]);
    await expect(bridge.resetUnitChat("unit-1")).resolves.toBe(true);
    expect(bridge.commands).toEqual(["RESET_UNIT_CHAT"]);
    expect(bridge.payloads).toEqual([{ unitId: "unit-1" }]);
  });
});

describe("ExtensionBridge compatibility detection", () => {
  it("prefers bridge v8 when current and older status responders coexist", async () => {
    vi.useFakeTimers();
    respondToStatusVersions([8, 7]);
    const result = new ExtensionBridge().detectCompatibility("unit-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({
      state: "ready",
      version: 8,
      integration: integrationStatus,
    });
  });

  it("identifies an older bridge without allowing it to become ready", async () => {
    vi.useFakeTimers();
    respondToStatusVersions([6]);
    const result = new ExtensionBridge().detectCompatibility("unit-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({
      state: "outdated",
      version: 6,
      integration: integrationStatus,
    });
  });

  it("locks protocol v8 when the extension patch is old or not reported", async () => {
    vi.useFakeTimers();
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
      const request = message as {
        command?: string;
        nonce?: string;
        requestId?: string;
        version?: number;
      };
      if (request.command !== "GET_INTEGRATION_STATUS" || request.version !== 8) return;
      queueMicrotask(() => {
        window.dispatchEvent(new MessageEvent("message", {
          data: {
            source: "meoi-extension",
            version: 8,
            nonce: request.nonce,
            requestId: request.requestId,
            ok: true,
            data: { ...integrationStatus, extensionVersion: "8.0.0" },
          },
          origin: window.location.origin,
          source: window,
        }));
      });
    });
    const oldPatch = new ExtensionBridge().detectCompatibility("unit-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(oldPatch).resolves.toMatchObject({
      state: "outdated",
      version: 8,
      integration: { extensionVersion: "8.0.0" },
    });

    postMessage.mockRestore();
    const { extensionVersion: _extensionVersion, ...statusWithoutPatch } = integrationStatus;
    vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
      const request = message as {
        command?: string;
        nonce?: string;
        requestId?: string;
        version?: number;
      };
      if (request.command !== "GET_INTEGRATION_STATUS" || request.version !== 8) return;
      queueMicrotask(() => {
        window.dispatchEvent(new MessageEvent("message", {
          data: {
            source: "meoi-extension",
            version: 8,
            nonce: request.nonce,
            requestId: request.requestId,
            ok: true,
            data: statusWithoutPatch,
          },
          origin: window.location.origin,
          source: window,
        }));
      });
    });
    const missingPatch = new ExtensionBridge().detectCompatibility("unit-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(missingPatch).resolves.toMatchObject({
      state: "outdated",
      version: 8,
    });
  });

  it("reports unavailable when no supported status responder answers", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    const result = new ExtensionBridge().detectCompatibility("unit-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ state: "unavailable" });
  });
});
