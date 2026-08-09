// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionRail } from "./CollectionRail";

let root: Root | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function renderRail(createDisabled: boolean, onCreate: () => void) {
  document.body.innerHTML = '<div id="mount"></div>';
  root = createRoot(document.querySelector("#mount")!);
  return act(async () => root!.render(createElement(CollectionRail, {
    collections: [],
    activeId: "",
    createDisabled,
    onSelect: vi.fn(),
    onCreate,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  })));
}

describe("CollectionRail creation controls", () => {
  it("keeps collection creation disabled while the workspace is loading", async () => {
    const onCreate = vi.fn();
    await renderRail(true, onCreate);

    const add = document.querySelector<HTMLButtonElement>('[aria-label="Add collection"]');
    const mobileAdd = document.querySelector<HTMLButtonElement>('[aria-label="Create collection"]');
    expect(add?.disabled).toBe(true);
    expect(mobileAdd?.disabled).toBe(true);

    await act(async () => add!.click());
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("opens collection creation only after the add control is activated", async () => {
    const onCreate = vi.fn();
    await renderRail(false, onCreate);

    expect(onCreate).not.toHaveBeenCalled();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Add collection"]')!.click();
    });
    expect(onCreate).toHaveBeenCalledOnce();
  });
});
