// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { ProfileAvatar } from "./ProfileAvatar";

const mocks = vi.hoisted(() => ({
  authorizeFileDownload: vi.fn(),
}));

vi.mock("../api/files", () => ({
  authorizeFileDownload: mocks.authorizeFileDownload,
}));

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
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("ProfileAvatar", () => {
  it("renders an existing avatar through an authorized signed URL", async () => {
    mocks.authorizeFileDownload.mockResolvedValue("https://assets.example.test/avatar.png");
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);

    await act(async () => {
      root!.render(createElement(ProfileAvatar, {
        api: {} as ApiClient,
        assetId: "asset-1",
        displayName: "Meoi Learner",
      }));
      await Promise.resolve();
    });

    expect(mocks.authorizeFileDownload).toHaveBeenCalledWith(expect.anything(), "asset-1");
    expect(document.querySelector<HTMLImageElement>("img")?.src).toBe("https://assets.example.test/avatar.png");
  });

  it("revokes a temporary preview URL when the selected file changes", async () => {
    const createObjectURL = vi.fn(() => "blob:avatar-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);

    await act(async () => {
      root!.render(createElement(ProfileAvatar, { api: null, displayName: "Meoi Learner", file }));
    });
    expect(document.querySelector<HTMLImageElement>("img")?.src).toBe("blob:avatar-preview");

    await act(async () => {
      root!.render(createElement(ProfileAvatar, { api: null, displayName: "Meoi Learner", file: null }));
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:avatar-preview");
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("M");
  });
});
