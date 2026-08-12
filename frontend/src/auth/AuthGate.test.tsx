// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./AuthGate";

const mocks = vi.hoisted(() => ({
  completeProfile: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    api: {},
    completeProfile: mocks.completeProfile,
    configurationError: null,
    currentUser: {
      profile: {
        displayName: "Meoing User",
        id: "11111111-1111-4111-8111-111111111111",
        revision: 0,
        username: null,
      },
    },
    loading: false,
    passwordRecovery: false,
    session: {
      user: {
        email: "meoi@example.test",
        email_confirmed_at: "2026-08-09T00:00:00.000Z",
        user_metadata: {},
      },
    },
    signOut: mocks.signOut,
  }),
}));

let root: Root | null = null;

function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  mocks.completeProfile.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("AuthGate profile onboarding", () => {
  it("requires Name and sends Name with Username in one completion request", async () => {
    document.body.innerHTML = '<div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);
    await act(async () => root!.render(createElement(AuthGate, null, createElement("div", null, "Workspace"))));

    const nameInput = document.querySelector<HTMLInputElement>('input[name="display-name"]');
    const usernameInput = document.querySelector<HTMLInputElement>('input[name="username"]');
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(nameInput).not.toBeNull();
    expect(nameInput?.value).toBe("");
    expect(submit?.disabled).toBe(true);

    await act(async () => {
      enter(nameInput!, "Meoi Learner");
      enter(usernameInput!, "meoi.user");
    });
    expect(submit?.disabled).toBe(false);

    await act(async () => submit!.click());
    expect(mocks.completeProfile).toHaveBeenCalledWith({
      displayName: "Meoi Learner",
      username: "meoi.user",
    });
  });
});
