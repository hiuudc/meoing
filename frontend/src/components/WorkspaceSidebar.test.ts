// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Collection, ContentKind, Unit } from "../types";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import type { WorkspaceMode } from "./WorkspaceModeSwitch";

const collection: Collection = {
  id: "collection-test",
  name: "Test Collection",
  icon: "T",
  accent: "#655BF5",
};

const units: Unit[] = [
  {
    id: "unit-daily",
    collectionId: collection.id,
    name: "Daily Rhythm",
    description: "Daily routines.",
  },
  {
    id: "unit-town",
    collectionId: collection.id,
    name: "Around Town",
    description: "Places and directions.",
  },
];

interface SidebarHarnessProps {
  onSelectUnit?: (id: string) => void;
  onOpenLessons?: (id: string) => void;
  onOpenCollectionQuestions?: () => void;
}

function SidebarHarness({ onSelectUnit, onOpenLessons, onOpenCollectionQuestions }: SidebarHarnessProps) {
  const [activeUnitId, setActiveUnitId] = useState(units[0].id);
  const [activeKind, setActiveKind] = useState<ContentKind>("document");
  const [mode, setMode] = useState<WorkspaceMode>("library");

  return createElement(WorkspaceSidebar, {
    collection,
    units,
    activeUnitId,
    activeKind,
    mode,
    sidebarWidth: 280,
    openOnMobile: false,
    onCloseMobile: vi.fn(),
    onSelectKind: (kind) => {
      setActiveKind(kind);
      setMode("library");
    },
    onSelectUnit: (id) => {
      setActiveUnitId(id);
      onSelectUnit?.(id);
    },
    onOpenLessons: (id) => {
      setActiveUnitId(id);
      setMode("learn");
      onOpenLessons?.(id);
    },
    onCreateUnit: vi.fn(),
    onEditUnit: vi.fn(),
    onOpenCollectionQuestions: onOpenCollectionQuestions ?? vi.fn(),
    onDeleteUnit: vi.fn(),
    onMoveUnit: vi.fn(),
    onOpenAppearance: vi.fn(),
    onSidebarResize: vi.fn(),
    onSidebarResizeEnd: vi.fn(),
  });
}

let root: Root | null = null;

function unitButton(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>(".unit-row"))
    .find((button) => button.textContent?.trim() === label);
  if (!match) throw new Error(`Unit button not found: ${label}`);
  return match;
}

function subnavButton(unitId: string, label: string): HTMLButtonElement {
  const subnav = document.querySelector(`#unit-subnav-${encodeURIComponent(unitId)}`);
  const match = Array.from(subnav?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((button) => button.textContent?.trim() === label);
  if (!match) throw new Error(`Subnavigation button not found: ${label}`);
  return match;
}

async function renderSidebar(props: SidebarHarnessProps = {}) {
  document.body.innerHTML = '<div id="mount"></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => root!.render(createElement(SidebarHarness, props)));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("workspace unit navigation", () => {
  it("opens collection question settings from the collection heading only", async () => {
    const onOpenCollectionQuestions = vi.fn();
    await renderSidebar({ onOpenCollectionQuestions });

    const settingsButton = document.querySelector<HTMLButtonElement>(
      '[aria-label="Open question settings for Test Collection"]',
    );
    expect(settingsButton).not.toBeNull();
    expect(document.querySelector('[aria-label="Open question settings for Daily Rhythm"]')).toBeNull();

    await act(async () => settingsButton!.click());
    expect(onOpenCollectionQuestions).toHaveBeenCalledOnce();
  });

  it("keeps the unit name and disclosure button in sync while toggling the active unit", async () => {
    const onSelectUnit = vi.fn();
    await renderSidebar({ onSelectUnit });

    const name = unitButton("Daily Rhythm");
    expect(name.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[aria-label="Collapse Daily Rhythm"]')?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => name.click());
    expect(onSelectUnit).toHaveBeenLastCalledWith("unit-daily");
    expect(name.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[aria-label="Expand Daily Rhythm"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("#unit-subnav-unit-daily")).toBeNull();

    await act(async () => name.click());
    expect(name.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("#unit-subnav-unit-daily")).not.toBeNull();
  });

  it("does not reopen an inactive expanded unit when its name selects and collapses it", async () => {
    const onSelectUnit = vi.fn();
    await renderSidebar({ onSelectUnit });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Expand Around Town"]')!.click();
    });
    const name = unitButton("Around Town");
    expect(name.getAttribute("aria-expanded")).toBe("true");

    await act(async () => name.click());
    expect(onSelectUnit).toHaveBeenLastCalledWith("unit-town");
    expect(name.getAttribute("aria-expanded")).toBe("false");
    expect(name.closest(".unit-row-wrap")?.classList.contains("is-current")).toBe(true);
    expect(document.querySelector("#unit-subnav-unit-town")).toBeNull();
  });

  it("opens Lessons in learn mode without leaving a Library item selected", async () => {
    const onOpenLessons = vi.fn();
    await renderSidebar({ onOpenLessons });

    const documents = subnavButton("unit-daily", "Documents");
    const lessons = subnavButton("unit-daily", "Lessons");
    expect(documents.classList.contains("is-current")).toBe(true);
    expect(lessons.classList.contains("is-current")).toBe(false);

    await act(async () => lessons.click());
    expect(onOpenLessons).toHaveBeenCalledWith("unit-daily");
    expect(lessons.classList.contains("is-current")).toBe(true);
    expect(documents.classList.contains("is-current")).toBe(false);
    expect(document.querySelector(".sidebar-nav-row.is-current")).toBeNull();

    const words = subnavButton("unit-daily", "Words");
    await act(async () => words.click());
    expect(words.classList.contains("is-current")).toBe(true);
    expect(lessons.classList.contains("is-current")).toBe(false);
  });
});
