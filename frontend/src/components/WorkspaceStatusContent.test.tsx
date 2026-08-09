// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStatusContent } from "./WorkspaceStatusContent";

let root: Root | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  document.body.innerHTML = '<div id="mount"></div>';
  root = createRoot(document.querySelector("#mount")!);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("WorkspaceStatusContent", () => {
  it("shows loading inside the normal workspace main area", async () => {
    await act(async () => root!.render(createElement(WorkspaceStatusContent, {
      loading: true,
      error: null,
      onRetry: vi.fn(),
      onOpenMobileNavigation: vi.fn(),
    })));

    expect(document.querySelector("main.workspace-main")).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Loading your workspace");
  });

  it("keeps empty-workspace actions in the rail and account menu", async () => {
    await act(async () => root!.render(createElement(WorkspaceStatusContent, {
      loading: false,
      error: null,
      onRetry: vi.fn(),
      onOpenMobileNavigation: vi.fn(),
    })));

    expect(document.body.textContent).toContain("Use the + button");
    expect(document.body.textContent).not.toContain("New collection");
    expect(document.body.textContent).not.toContain("Sign out");
  });

  it("renders a retry action for workspace errors", async () => {
    const onRetry = vi.fn();
    await act(async () => root!.render(createElement(WorkspaceStatusContent, {
      loading: false,
      error: "Workspace unavailable",
      onRetry,
      onOpenMobileNavigation: vi.fn(),
    })));

    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Try again")?.click();
    });
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
