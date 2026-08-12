// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from "react";
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
  accountMenu?: ReactNode;
  onSelectUnit?: (id: string) => void;
  onOpenLessons?: (id: string) => void;
  onOpenCollectionAdmin?: () => void;
  onOpenUnitSettings?: (unit: Unit) => void;
  profileDisplayName?: string;
  profileUsername?: string;
  readOnly?: boolean;
}

function SidebarHarness({
  accountMenu,
  onSelectUnit,
  onOpenLessons,
  onOpenCollectionAdmin,
  onOpenUnitSettings,
  profileDisplayName,
  profileUsername,
  readOnly = false,
}: SidebarHarnessProps) {
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
    onOpenUnitSettings,
    onDeleteUnit: vi.fn(),
    onMoveUnit: vi.fn(),
    onOpenCollectionAdmin,
    accountMenu,
    profileDisplayName,
    profileUsername,
    canCreateUnit: !readOnly,
    canEditUnit: !readOnly,
    canDeleteUnit: !readOnly,
    canManageCollection: !readOnly,
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
  it("renders a composed account menu in the profile footer", async () => {
    await renderSidebar({
      accountMenu: createElement("button", { type: "button", id: "account-slot" }, "Account menu"),
      profileDisplayName: "Fallback Profile",
    });

    expect(document.querySelector("#account-slot")?.closest(".sidebar-footer")).not.toBeNull();
    expect(document.querySelector(".profile-row")).toBeNull();
  });

  it("renders the authenticated profile instead of demo identity", async () => {
    await renderSidebar({
      profileDisplayName: "Meoi Teacher",
      profileUsername: "meoi.teacher",
    });

    const profile = document.querySelector(".profile-row");
    expect(profile?.textContent).toContain("Meoi Teacher");
    expect(profile?.textContent).toContain("@meoi.teacher");
    expect(profile?.textContent).not.toContain("Mina");
  });

  it("opens collection administration from the collection heading gear", async () => {
    const onOpenCollectionAdmin = vi.fn();
    await renderSidebar({ onOpenCollectionAdmin });

    const settingsButton = document.querySelector<HTMLButtonElement>(
      '[aria-label="Open collection administration for Test Collection"]',
    );
    expect(settingsButton).not.toBeNull();

    await act(async () => settingsButton!.click());
    expect(onOpenCollectionAdmin).toHaveBeenCalledOnce();
  });

  it("keeps collection administration and deleted units out of the sidebar footer", async () => {
    await renderSidebar();
    expect(document.body.textContent).not.toContain("Collection settings");
    expect(document.body.textContent).not.toContain("Recently deleted units");
  });

  it("opens Unit Settings from the trailing gear without selecting or dragging the unit", async () => {
    const onOpenUnitSettings = vi.fn();
    await renderSidebar({ onOpenUnitSettings });
    const settings = document.querySelector<HTMLButtonElement>('[aria-label="Open settings for Daily Rhythm"]');
    expect(settings).not.toBeNull();
    await act(async () => settings!.click());
    expect(onOpenUnitSettings).toHaveBeenCalledWith(units[0]);
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

  it("uses effective-permission flags to hide collection and unit mutations", async () => {
    await renderSidebar({ readOnly: true });

    expect(document.querySelector('[aria-label="Add unit"]')).toBeNull();
    expect(document.querySelector('[aria-label="Open question settings for Test Collection"]')).toBeNull();
    expect(document.querySelector('[aria-label="Open actions for Daily Rhythm"]')).toBeNull();
    expect(Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "Appearance",
    )).toBe(false);
    expect(unitButton("Daily Rhythm")).not.toBeNull();
  });
});
