// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { Collection } from "../types";
import { DeletedCollectionsModal } from "./DeletedCollectionsModal";

const deletedCollection: Collection = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Archived Japanese",
  icon: "AJ",
  accent: "#655bf5",
  revision: 6,
  deletedAt: "2026-07-30T10:00:00.000Z",
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

describe("DeletedCollectionsModal", () => {
  it("restores through expectedRevision and refreshes cloud state", async () => {
    const post = vi.fn().mockResolvedValue({ data: {} });
    const onRestored = vi.fn();
    const onClose = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);

    await act(async () => {
      root!.render(createElement(DeletedCollectionsModal, {
        api: { post } as unknown as ApiClient,
        collections: [deletedCollection],
        onClose,
        onRestored,
      }));
    });
    const restoreButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Restore"));
    if (!restoreButton) throw new Error("Restore button was not rendered.");
    await act(async () => restoreButton.click());

    expect(post).toHaveBeenCalledWith(
      `/v1/collections/${deletedCollection.id}/restore`,
      { expectedRevision: 6 },
    );
    expect(onRestored).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
