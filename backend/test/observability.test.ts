import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/observability";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured Worker logs", () => {
  it("emits indexed object fields instead of a JSON string", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    log("info", {
      databaseDurationMs: 12,
      durationMs: 18,
      event: "http_request",
      path: "/v1/me",
      status: 200,
    });

    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      databaseDurationMs: 12,
      durationMs: 18,
      event: "http_request",
      level: "info",
      path: "/v1/me",
      status: 200,
      timestamp: expect.any(String),
    }));
    expect(typeof consoleLog.mock.calls[0]?.[0]).toBe("object");
  });
});
