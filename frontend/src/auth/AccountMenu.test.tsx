// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

const mocks = vi.hoisted(() => ({
  clearProgressOutboxForUser: vi.fn(),
  post: vi.fn(),
  refreshCurrentUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../api/progressOutbox", () => ({
  clearProgressOutboxForUser: mocks.clearProgressOutboxForUser,
}));

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    api: { post: mocks.post },
    currentUser: {
      profile: {
        id: "11111111-1111-4111-8111-111111111111",
        username: "meoi.user",
        displayName: "Meoi User",
      },
      email: "meoi@example.test",
    },
    refreshCurrentUser: mocks.refreshCurrentUser,
    hasPassword: true,
    signOut: mocks.signOut,
  }),
}));

let root: Root | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  mocks.clearProgressOutboxForUser.mockResolvedValue(2);
  mocks.post.mockResolvedValue({ data: {} });
  mocks.refreshCurrentUser.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("AccountMenu", () => {
  it("opens account settings directly from the sidebar profile row without a menu", async () => {
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);
    await act(async () => root!.render(createElement(AccountMenu)));

    const accountButton = document.querySelector<HTMLButtonElement>(".app-account-button");
    expect(accountButton?.classList.contains("profile-row")).toBe(true);
    expect(accountButton?.textContent).toContain("Meoi User");
    expect(accountButton?.textContent).toContain("@meoi.user");

    await act(async () => accountButton!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.textContent).toContain("Main Profile");

    const signOutButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.trim() === "Log out");
    await act(async () => signOutButton!.click());
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it("clears only that user's pending progress after account deletion is accepted", async () => {
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);
    await act(async () => root!.render(createElement(AccountMenu)));

    const accountButton = document.querySelector<HTMLButtonElement>(".app-account-button");
    if (!accountButton) throw new Error("Account menu button was not rendered.");
    await act(async () => accountButton.click());

    const privacyButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("Data & Privacy"));
    await act(async () => privacyButton!.click());

    const deleteButton = document.querySelector<HTMLButtonElement>(".account-danger-zone .danger-button");
    if (!deleteButton) throw new Error("Delete account button was not rendered.");
    await act(async () => deleteButton.click());

    const confirmation = document.querySelector<HTMLInputElement>('.account-action-modal input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(confirmation, "DELETE");
      confirmation?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirmDelete = document.querySelector<HTMLButtonElement>(".account-action-modal .danger-button");
    await act(async () => confirmDelete!.click());

    expect(mocks.post).toHaveBeenCalledWith("/v1/me/deletion", { confirmation: "DELETE" });
    expect(mocks.clearProgressOutboxForUser).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.refreshCurrentUser).toHaveBeenCalledOnce();
  });

  it("still enters the server deletion lock when local IndexedDB cleanup fails", async () => {
    mocks.clearProgressOutboxForUser.mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);
    await act(async () => root!.render(createElement(AccountMenu)));

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".app-account-button")?.click();
    });
    const privacyButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("Data & Privacy"));
    await act(async () => privacyButton!.click());
    const deleteButton = document.querySelector<HTMLButtonElement>(".account-danger-zone .danger-button");
    if (!deleteButton) throw new Error("Delete account button was not rendered.");
    await act(async () => deleteButton.click());
    const confirmation = document.querySelector<HTMLInputElement>('.account-action-modal input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(confirmation, "DELETE");
      confirmation?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirmDelete = document.querySelector<HTMLButtonElement>(".account-action-modal .danger-button");
    await act(async () => confirmDelete!.click());

    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.refreshCurrentUser).toHaveBeenCalledOnce();
  });
});
