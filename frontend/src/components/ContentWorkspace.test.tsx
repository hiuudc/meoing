// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Unit } from "../types";
import { ContentWorkspace } from "./ContentWorkspace";

let root: Root | null = null;

const unit: Unit = {
  id: "unit-1",
  collectionId: "collection-1",
  name: "First unit",
  description: "Start here.",
};

function renderWorkspace({
  selectedUnit,
  canCreateUnit = true,
}: {
  selectedUnit?: Unit;
  canCreateUnit?: boolean;
}) {
  const onCreate = vi.fn();
  const onCreateUnit = vi.fn();
  document.body.innerHTML = '<div id="mount"></div>';
  root = createRoot(document.querySelector("#mount")!);
  act(() => {
    root!.render(
      <ContentWorkspace
        collectionName="Japanese"
        unit={selectedUnit}
        activeKind="document"
        documents={[]}
        studyItems={[]}
        onOpenMobileNavigation={vi.fn()}
        onSelectKind={vi.fn()}
        onCreate={onCreate}
        onCreateUnit={onCreateUnit}
        canCreate
        canCreateUnit={canCreateUnit}
        onEditDocument={vi.fn()}
        onDeleteDocument={vi.fn()}
        onEditStudyItem={vi.fn()}
        onDeleteStudyItem={vi.fn()}
        mode="library"
        onModeChange={vi.fn()}
      />,
    );
  });
  return { onCreate, onCreateUnit };
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("ContentWorkspace creation guidance", () => {
  it("offers Create unit instead of a disabled document action when creation is allowed", async () => {
    const { onCreateUnit } = renderWorkspace({});
    expect(button("New document")).toBeUndefined();
    await act(async () => button("Create unit")!.click());
    expect(onCreateUnit).toHaveBeenCalledOnce();
  });

  it("explains the disabled content action when the member cannot create units", () => {
    renderWorkspace({ canCreateUnit: false });
    const create = button("New document");
    expect(create?.disabled).toBe(true);
    expect(create?.getAttribute("aria-describedby")).toBe("content-create-requirement");
    expect(document.querySelector("#content-create-requirement")?.textContent).toContain("Select an existing unit");
  });

  it("enables New document after a unit is selected", async () => {
    const { onCreate } = renderWorkspace({ selectedUnit: unit });
    await act(async () => button("New document")!.click());
    expect(onCreate).toHaveBeenCalledOnce();
  });
});
