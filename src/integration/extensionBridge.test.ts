// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ExtensionBridge } from "./extensionBridge";
import type { ChatOperationState, ExtensionCommand, SendOperationPayload } from "./protocol";
import { QUESTION_FORMATS } from "../learning/types";

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

  override async send<TResponse = unknown, TPayload = unknown>(command: ExtensionCommand, _payload: TPayload): Promise<TResponse> {
    this.commands.push(command);
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
    level: "elementary",
    questionCount: 10,
    speaking: false,
    allowedFormats: QUESTION_FORMATS.filter((format) => format !== "speakingRepeat" && format !== "speakingRoleplay"),
    requiredTemplates: [],
  },
};

describe("ExtensionBridge operation waiting", () => {
  it("reports session phases until a direct result is complete", async () => {
    const seen: string[] = [];
    const bridge = new StubBridge([
      state("queued"),
      state("repairing_response"),
      state("completed", {
        result: {
          type: "meoi.operation.result",
          protocolVersion: 3,
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
          protocolVersion: 3,
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
});
