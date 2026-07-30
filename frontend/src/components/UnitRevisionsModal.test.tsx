// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { Unit } from "../types";
import { UnitRevisionsModal } from "./UnitRevisionsModal";

const unit: Unit = {
  id: "11111111-1111-4111-8111-111111111111",
  collectionId: "22222222-2222-4222-8222-222222222222",
  name: "Greetings",
  description: "",
  revision: 4,
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

describe("UnitRevisionsModal", () => {
  it("lists retained revisions and restores with the current optimistic revision", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        items: [{
          id: "33333333-3333-4333-8333-333333333333",
          unitId: unit.id,
          revision: 2,
          createdBy: null,
          action: "updated",
          createdAt: "2026-07-30T10:00:00.000Z",
        }],
        nextCursor: null,
      },
    });
    const post = vi.fn().mockResolvedValue({ data: {} });
    const onRestored = vi.fn();
    const onClose = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);

    await act(async () => {
      root!.render(createElement(UnitRevisionsModal, {
        api: { get, post } as unknown as ApiClient,
        unit,
        canRestore: true,
        onClose,
        onRestored,
      }));
    });

    await vi.waitFor(() => expect(document.body.textContent).toContain("Revision 2"));
    const restoreButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Restore"));
    if (!restoreButton) throw new Error("Restore button was not rendered.");
    await act(async () => restoreButton.click());

    expect(post).toHaveBeenCalledWith(
      `/v1/units/${unit.id}/revisions/2/restore`,
      { expectedRevision: 4 },
    );
    expect(onRestored).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps revision history read-only without edit permission", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        items: [{
          id: "33333333-3333-4333-8333-333333333333",
          unitId: unit.id,
          revision: 2,
          createdBy: null,
          action: "created",
          createdAt: "2026-07-30T10:00:00.000Z",
        }],
        nextCursor: null,
      },
    });
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);

    await act(async () => {
      root!.render(createElement(UnitRevisionsModal, {
        api: { get } as unknown as ApiClient,
        unit,
        canRestore: false,
        onClose: vi.fn(),
        onRestored: vi.fn(),
      }));
    });

    await vi.waitFor(() => expect(document.body.textContent).toContain("Revision 2"));
    expect(document.body.textContent).toContain("View only");
    expect(Array.from(document.querySelectorAll("button"))
      .some((button) => button.textContent?.includes("Restore"))).toBe(false);
  });
});
