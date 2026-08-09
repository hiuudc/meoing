// @vitest-environment jsdom
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmailDialog,
  PasswordDialog,
  UsernameDialog,
} from "./AccountSettingsDialogs";

const mocks = vi.hoisted(() => ({
  changeEmail: vi.fn(),
  changePassword: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  refreshCurrentUser: vi.fn(),
  sendReauthenticationCode: vi.fn(),
  sendEmailOtp: vi.fn(),
  setPasswordWithCode: vi.fn(),
  verifyCurrentPassword: vi.fn(),
  verifyEmailOtp: vi.fn(),
}));

let hasPassword = true;

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    api: { get: mocks.get, post: mocks.post },
    changeEmail: mocks.changeEmail,
    changePassword: mocks.changePassword,
    currentUser: {
      email: "meoi@example.test",
      profile: {
        id: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        username: "meoi.user",
        usernameChangedAt: null,
      },
    },
    hasPassword,
    refreshCurrentUser: mocks.refreshCurrentUser,
    sendReauthenticationCode: mocks.sendReauthenticationCode,
    sendEmailOtp: mocks.sendEmailOtp,
    setPasswordWithCode: mocks.setPasswordWithCode,
    verifyCurrentPassword: mocks.verifyCurrentPassword,
    verifyEmailOtp: mocks.verifyEmailOtp,
  }),
}));

let root: Root | null = null;

function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

async function render(Dialog: ComponentType<{ onClose: () => void; onSuccess: (message: string) => void }>) {
  document.body.innerHTML = '<div id="mount"></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => root!.render(createElement(Dialog, { onClose: vi.fn(), onSuccess: vi.fn() })));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  hasPassword = true;
  mocks.get.mockResolvedValue({ data: { available: true, username: "new.user" } });
  mocks.post.mockResolvedValue({ data: {} });
  mocks.refreshCurrentUser.mockResolvedValue(undefined);
  mocks.sendReauthenticationCode.mockResolvedValue(undefined);
  mocks.sendEmailOtp.mockResolvedValue(undefined);
  mocks.verifyCurrentPassword.mockResolvedValue(undefined);
  mocks.verifyEmailOtp.mockResolvedValue(undefined);
  mocks.changeEmail.mockResolvedValue(undefined);
  mocks.changePassword.mockResolvedValue(undefined);
  mocks.setPasswordWithCode.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Account settings security dialogs", () => {
  it("uses a structured action footer and autofocuses the verification action", async () => {
    await render(EmailDialog);
    const sendCode = button("Send verification code");
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close Change your email"]');

    expect(document.querySelector(".account-action-body")).not.toBeNull();
    expect(document.querySelector(".account-action-footer")).not.toBeNull();
    expect(sendCode.hasAttribute("data-modal-autofocus")).toBe(true);
    expect(sendCode.classList.contains("primary-button")).toBe(true);
    expect(close?.hasAttribute("data-modal-autofocus")).toBe(false);
  });

  it("verifies the current password before changing a username", async () => {
    await render(UsernameDialog);
    const inputs = document.querySelectorAll<HTMLInputElement>("input");
    await act(async () => enter(inputs[0], "new.user"));
    await act(async () => button("Check availability").click());
    await act(async () => enter(inputs[1], "current-secret"));
    await act(async () => button("Done").click());

    expect(mocks.verifyCurrentPassword).toHaveBeenCalledWith("current-secret");
    expect(mocks.post).toHaveBeenCalledWith("/v1/me/username", { username: "new.user" });
  });

  it("uses email reauthentication for username changes without a password", async () => {
    hasPassword = false;
    await render(UsernameDialog);
    let inputs = document.querySelectorAll<HTMLInputElement>("input");
    await act(async () => enter(inputs[0], "new.user"));
    await act(async () => button("Send verification code").click());
    await act(async () => button("Check availability").click());
    inputs = document.querySelectorAll<HTMLInputElement>("input");
    await act(async () => enter(inputs[1], "123456"));
    await act(async () => button("Done").click());

    expect(mocks.sendEmailOtp).toHaveBeenCalledOnce();
    expect(mocks.verifyEmailOtp).toHaveBeenCalledWith("123456");
  });

  it("verifies the old email before requesting a secure email change", async () => {
    await render(EmailDialog);
    await act(async () => button("Send verification code").click());
    const inputs = document.querySelectorAll<HTMLInputElement>("input");
    await act(async () => {
      enter(inputs[0], "654321");
      enter(inputs[1], "new@example.test");
    });
    await act(async () => button("Done").click());

    expect(mocks.sendEmailOtp).toHaveBeenCalledOnce();
    expect(mocks.verifyEmailOtp).toHaveBeenCalledWith("654321");
    expect(mocks.changeEmail).toHaveBeenCalledWith("new@example.test");
  });

  it("shows Current, New and Confirm only for an existing password account", async () => {
    await render(PasswordDialog);
    expect(document.body.textContent).toContain("Current Password");
    expect(document.body.textContent).toContain("New Password");
    expect(document.body.textContent).toContain("Confirm New Password");
    const inputs = document.querySelectorAll<HTMLInputElement>("input");
    await act(async () => {
      enter(inputs[0], "current-secret");
      enter(inputs[1], "new-secret-123");
      enter(inputs[2], "new-secret-123");
    });
    await act(async () => button("Done").click());
    expect(mocks.changePassword).toHaveBeenCalledWith("current-secret", "new-secret-123");
  });

  it("uses an email code to create the first password for an OAuth account", async () => {
    hasPassword = false;
    await render(PasswordDialog);
    expect(document.body.textContent).not.toContain("Current Password");
    await act(async () => button("Send verification code").click());
    const inputs = document.querySelectorAll<HTMLInputElement>("input");
    await act(async () => {
      enter(inputs[0], "123456");
      enter(inputs[1], "new-secret-123");
      enter(inputs[2], "new-secret-123");
    });
    await act(async () => button("Done").click());
    expect(mocks.setPasswordWithCode).toHaveBeenCalledWith("new-secret-123", "123456");
  });
});
