import { describe, expect, it, vi } from "vitest";
import { ExtensionBridgeError } from "./extensionBridge";
import { runWithUnitChatRecovery } from "./unitChatRecovery";

describe("unit chat recovery", () => {
  it("resets and retries the same operation once after the mapped ChatGPT tab changes", async () => {
    const initial = vi.fn(async () => {
      throw new ExtensionBridgeError("CHATGPT_TAB_CHANGED", "The mapped chat was deleted.");
    });
    const resetAndRetry = vi.fn(async () => "completed");

    await expect(runWithUnitChatRecovery(initial, resetAndRetry)).resolves.toBe("completed");
    expect(initial).toHaveBeenCalledTimes(1);
    expect(resetAndRetry).toHaveBeenCalledTimes(1);
  });

  it("does not run recovery twice when the retry also fails", async () => {
    const initial = vi.fn(async () => {
      throw new ExtensionBridgeError("CHATGPT_TAB_CHANGED", "The mapped chat was deleted.");
    });
    const retryError = new ExtensionBridgeError("CHATGPT_TAB_CHANGED", "The replacement chat changed too.");
    const resetAndRetry = vi.fn(async () => {
      throw retryError;
    });

    await expect(runWithUnitChatRecovery(initial, resetAndRetry)).rejects.toBe(retryError);
    expect(initial).toHaveBeenCalledTimes(1);
    expect(resetAndRetry).toHaveBeenCalledTimes(1);
  });

  it("does not reset a unit chat for unrelated extension failures", async () => {
    const initialError = new ExtensionBridgeError("CHATGPT_LIMIT_REACHED", "Quota reached.");
    const initial = vi.fn(async () => {
      throw initialError;
    });
    const resetAndRetry = vi.fn(async () => "unexpected");

    await expect(runWithUnitChatRecovery(initial, resetAndRetry)).rejects.toBe(initialError);
    expect(resetAndRetry).not.toHaveBeenCalled();
  });
});
