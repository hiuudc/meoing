// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LandingPage } from "./LandingPage";

let root: Root | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  document.body.innerHTML = '<div id="mount"></div>';
  root = createRoot(document.querySelector("#mount")!);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("LandingPage", () => {
  it("sets clear early-access expectations without offering public sign-up", async () => {
    await act(async () => root!.render(createElement(LandingPage)));

    expect(document.querySelector("h1")?.textContent).toContain("turn study material into practice");
    expect(document.body.textContent).toContain("Early access is not open yet.");
    expect(document.body.textContent).not.toContain("Create account");
    expect(document.querySelector<HTMLAnchorElement>('a[href="/app"]')?.textContent).toContain("Existing account");
  });
});
