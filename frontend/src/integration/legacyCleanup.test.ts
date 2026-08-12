import { describe, expect, it, vi } from "vitest";
import { removeLegacyApplicationData } from "./legacyCleanup";
import { STORAGE_KEY } from "../store";
import { LEARNING_STORAGE_KEY } from "./learningStorage";
import { PENDING_LEARNING_OPERATIONS_KEY } from "./pendingLearningOperations";

describe("legacy application cleanup", () => {
  it("removes old application stores without clearing the Supabase session", () => {
    const removeItem = vi.fn();
    removeLegacyApplicationData({ removeItem });

    expect(removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(removeItem).toHaveBeenCalledWith(LEARNING_STORAGE_KEY);
    expect(removeItem).toHaveBeenCalledWith(PENDING_LEARNING_OPERATIONS_KEY);
    expect(removeItem).not.toHaveBeenCalledWith("sb-project-auth-token");
  });
});
