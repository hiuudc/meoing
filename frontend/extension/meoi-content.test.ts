import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEOI_EXTENSION_PROTOCOL_VERSION,
  MEOI_EXTENSION_SOURCE,
  MEOI_PAGE_SOURCE,
  type ExtensionRequest,
  type ExtensionResponse,
} from "../src/integration/protocol";

interface FakeWindow {
  location: { origin: string };
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("Meoi page content bridge", () => {
  it("forwards the unit-operation recovery query to the extension worker", async () => {
    let messageListener: ((event: MessageEvent) => void) | undefined;
    const fakeWindow: FakeWindow = {
      location: { origin: "http://127.0.0.1:5173" },
      addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => {
        messageListener = listener;
      }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    };
    const sendMessage = vi.fn((
      _message: unknown,
      callback: (result: unknown) => void,
    ) => callback({ ok: true, data: { operation: null } }));
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("chrome", { runtime: { sendMessage, lastError: undefined } });

    await import("./meoi-content");
    const request: ExtensionRequest = {
      source: MEOI_PAGE_SOURCE,
      version: MEOI_EXTENSION_PROTOCOL_VERSION,
      nonce: "nonce-123456",
      requestId: "request-recovery",
      command: "GET_UNIT_OPERATION",
      payload: { unitId: "unit-1", kind: "create_lesson" },
    };

    messageListener?.({
      source: fakeWindow,
      origin: fakeWindow.location.origin,
      data: request,
    } as unknown as MessageEvent);

    expect(sendMessage).toHaveBeenCalledWith(
      { kind: "MEOI_PAGE_REQUEST", request },
      expect.any(Function),
    );
    expect(fakeWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: request.requestId,
        ok: true,
        data: { operation: null },
      }),
      fakeWindow.location.origin,
    );
  });

  it("reports an invalidated extension context without throwing and removes the stale listener", async () => {
    let messageListener: ((event: MessageEvent) => void) | undefined;
    const fakeWindow: FakeWindow = {
      location: { origin: "http://127.0.0.1:5173" },
      addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => {
        messageListener = listener;
      }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    };
    const sendMessage = vi.fn(() => {
      throw new Error("Extension context invalidated.");
    });
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await import("./meoi-content");
    const request: ExtensionRequest = {
      source: MEOI_PAGE_SOURCE,
      version: MEOI_EXTENSION_PROTOCOL_VERSION,
      nonce: "nonce-123456",
      requestId: "request-1",
      command: "GET_INTEGRATION_STATUS",
      payload: {},
    };

    expect(() => messageListener?.({
      source: fakeWindow,
      origin: fakeWindow.location.origin,
      data: request,
    } as unknown as MessageEvent)).not.toThrow();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(fakeWindow.postMessage).toHaveBeenCalledOnce();
    const response = fakeWindow.postMessage.mock.calls[0][0] as ExtensionResponse;
    expect(response).toMatchObject({
      source: MEOI_EXTENSION_SOURCE,
      version: MEOI_EXTENSION_PROTOCOL_VERSION,
      nonce: request.nonce,
      requestId: request.requestId,
      ok: false,
      error: {
        code: "EXTENSION_NOT_READY",
        message: "Extension context invalidated.",
      },
    });
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith("message", messageListener);
  });
});
