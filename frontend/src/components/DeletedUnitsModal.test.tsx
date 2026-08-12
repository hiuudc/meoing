// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { Collection } from "../types";
import { DeletedUnitsModal } from "./DeletedUnitsModal";

const collection: Collection = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Japanese",
  icon: "JA",
  accent: "#655bf5",
};

let root: Root | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("DeletedUnitsModal", () => {
  it("loads deleted units and restores one through expectedRevision before refreshing", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        items: [{
          id: "22222222-2222-4222-8222-222222222222",
          collectionId: collection.id,
          name: "Travel basics",
          description: "Retained content",
          revision: 6,
          deletedAt: "2026-07-30T10:00:00.000Z",
        }],
        nextCursor: null,
      },
    });
    const post = vi.fn().mockResolvedValue({ data: {} });
    let resolveRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const onRestored = vi.fn(() => refresh);
    const onClose = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);

    await act(async () => {
      root!.render(createElement(DeletedUnitsModal, {
        api: { get, post } as unknown as ApiClient,
        collection,
        onClose,
        onRestored,
      }));
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Travel basics");
    });

    expect(get).toHaveBeenCalledWith(
      `/v1/collections/${collection.id}/units?includeDeleted=true`,
      expect.any(AbortSignal),
    );
    const restoreButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Restore"));
    if (!restoreButton) throw new Error("Restore button was not rendered.");
    await act(async () => {
      restoreButton.click();
      await Promise.resolve();
    });

    expect(post).toHaveBeenCalledWith(
      "/v1/units/22222222-2222-4222-8222-222222222222/restore",
      { expectedRevision: 6 },
    );
    expect(onRestored).toHaveBeenCalledWith(expect.objectContaining({
      id: "22222222-2222-4222-8222-222222222222",
      revision: 6,
    }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveRefresh();
      await refresh;
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
