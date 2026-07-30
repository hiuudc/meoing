// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { InviteAcceptanceModal } from "./InviteAcceptanceModal";

let root: Root | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("InviteAcceptanceModal", () => {
  it("previews and accepts a URL invite through the authenticated API", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/v1/invites/preview") {
        return {
          data: {
            inviteId: "11111111-1111-4111-8111-111111111111",
            collection: {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Japanese study group",
              description: "Learn together.",
            },
            expiresAt: null,
            remainingUses: 4,
          },
        };
      }
      if (path === "/v1/invites/accept") {
        return {
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Japanese study group",
            description: "Learn together.",
            ownerId: "33333333-3333-4333-8333-333333333333",
            deletedAt: null,
            deleteAfter: null,
            revision: 1,
            effectivePermissions: [],
          },
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const onAccepted = vi.fn();
    const api = { request } as unknown as ApiClient;
    document.body.innerHTML = '<button id="opener">Open</button><div id="mount"></div>';
    root = createRoot(document.querySelector("#mount")!);

    await act(async () => {
      root!.render(createElement(InviteAcceptanceModal, {
        api,
        token: "secret-invite-token-with-at-least-32-characters",
        onAccepted,
        onClose: vi.fn(),
      }));
    });

    await vi.waitFor(() => expect(document.body.textContent).toContain("Japanese study group"));
    expect(request).toHaveBeenNthCalledWith(1, "/v1/invites/preview", expect.objectContaining({
      method: "POST",
      body: { token: "secret-invite-token-with-at-least-32-characters" },
    }));

    const accept = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Accept invitation"));
    expect(accept).toBeDefined();
    await act(async () => accept!.click());

    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
    expect(request).toHaveBeenNthCalledWith(2, "/v1/invites/accept", expect.objectContaining({
      method: "POST",
      body: { token: "secret-invite-token-with-at-least-32-characters" },
    }));
  });
});
