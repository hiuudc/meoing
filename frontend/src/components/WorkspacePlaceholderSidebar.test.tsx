// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePlaceholderSidebar } from "./WorkspacePlaceholderSidebar";

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

describe("WorkspacePlaceholderSidebar", () => {
  it("keeps the composed account trigger in the footer while collections load", async () => {
    await act(async () => root!.render(createElement(WorkspacePlaceholderSidebar, {
      accountMenu: createElement("button", { id: "account-trigger", type: "button" }, "Account"),
      loading: true,
      openOnMobile: false,
      onCloseMobile: vi.fn(),
    })));

    expect(document.querySelector("#account-trigger")?.closest(".sidebar-footer")).not.toBeNull();
    expect(document.body.textContent).toContain("Loading your collections");
  });

  it("opens as the normal mobile drawer after loading", async () => {
    await act(async () => root!.render(createElement(WorkspacePlaceholderSidebar, {
      accountMenu: createElement("button", { type: "button" }, "Account"),
      loading: false,
      openOnMobile: true,
      onCloseMobile: vi.fn(),
    })));

    expect(document.querySelector(".workspace-sidebar")?.classList.contains("is-mobile-open")).toBe(true);
    expect(document.body.textContent).toContain("Create a collection from the + button");
  });
});
