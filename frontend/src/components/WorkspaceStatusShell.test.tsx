// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME } from "../store";
import { WorkspaceStatusShell } from "./WorkspaceStatusShell";

let root: Root | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("WorkspaceStatusShell", () => {
  it("provides the app theme scope before a collection exists", async () => {
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);

    await act(async () => {
      root!.render(
        <WorkspaceStatusShell theme={DEFAULT_THEME} sidebarWidth={280}>
          <main>Create a collection</main>
        </WorkspaceStatusShell>,
      );
    });

    const shell = document.querySelector<HTMLElement>(".app-shell.app-shell-status");
    expect(shell).not.toBeNull();
    expect(shell?.style.getPropertyValue("--bg-sidebar")).not.toBe("");
    expect(shell?.style.getPropertyValue("--bg-main")).not.toBe("");
    expect(shell?.style.getPropertyValue("--border")).not.toBe("");
    expect(shell?.style.getPropertyValue("--sidebar-width")).toBe("280px");
    expect(shell?.textContent).toContain("Create a collection");
  });
});
