// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type {
  CollectionMember,
  CollectionPermission,
  CollectionRole,
  LessonSummary,
} from "../api/collectionAdmin";
import type { Collection } from "../types";
import { CollectionAdminModal } from "./CollectionAdminModal";

const collection: Collection = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Japanese Foundations",
  icon: "J",
  accent: "#655bf5",
};

const member: CollectionMember = {
  userId: "22222222-2222-4222-8222-222222222222",
  username: "meoi.teacher",
  displayName: "Meoi Teacher",
  avatarAssetId: null,
  bio: "Collection profile bio",
  profileRevision: 3,
  joinedAt: "2026-07-30T10:00:00.000Z",
  isOwner: false,
  roleIds: ["33333333-3333-4333-8333-333333333333"],
  collectionProfile: {
    displayName: "Teacher override",
    avatarAssetId: "77777777-7777-4777-8777-777777777777",
    bio: "Collection-only bio",
    revision: 3,
  },
};

const role: CollectionRole = {
  id: "33333333-3333-4333-8333-333333333333",
  collectionId: collection.id,
  name: "Teacher",
  color: "#655bf5",
  permissions: ["edit_content", "publish_lessons"],
  securityRank: 5,
  isManaged: false,
  revision: 2,
  createdAt: "2026-07-30T10:00:00.000Z",
  updatedAt: "2026-07-30T10:00:00.000Z",
};

const lesson: LessonSummary = {
  id: "44444444-4444-4444-8444-444444444444",
  collectionId: collection.id,
  unitId: "55555555-5555-4555-8555-555555555555",
  unitRevision: 3,
  ownerId: member.userId,
  status: "draft",
  schemaVersion: 8,
  title: "Greetings",
  languageCode: "ja",
  revision: 4,
  createdAt: "2026-07-30T10:00:00.000Z",
  updatedAt: "2026-07-30T10:00:00.000Z",
  deletedAt: null,
  publishedAt: null,
  publishedBy: null,
};

let root: Root | null = null;

function button(label: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => (
      candidate.textContent?.trim().includes(label)
      || candidate.getAttribute("aria-label") === label
    ));
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Native input value setter is unavailable.");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function createApi() {
  const get = vi.fn(async (path: string) => {
    if (path.includes("/members?")) {
      return { data: { items: [member], nextCursor: null } };
    }
    if (path.includes("/roles?")) {
      return { data: { items: [role], nextCursor: null } };
    }
    if (path.startsWith("/v1/lessons?")) {
      return { data: { items: [lesson], nextCursor: null } };
    }
    if (path.startsWith("/v1/progress?")) {
      return {
        data: {
          items: [{
            id: "66666666-6666-4666-8666-666666666666",
            lessonId: lesson.id,
            collectionId: collection.id,
            userId: member.userId,
            languageCode: "ja",
            status: "completed",
            summary: { correctCount: 7, masteryPercent: 88 },
            revision: 2,
            startedAt: "2026-07-30T10:00:00.000Z",
            completedAt: "2026-07-30T10:10:00.000Z",
            updatedAt: "2026-07-30T10:10:00.000Z",
          }],
          nextCursor: null,
        },
      };
    }
    if (path === "/v1/progress/66666666-6666-4666-8666-666666666666") {
      return {
        data: {
          id: "66666666-6666-4666-8666-666666666666",
          lessonId: lesson.id,
          collectionId: collection.id,
          userId: member.userId,
          languageCode: "ja",
          status: "completed",
          summary: { correctCount: 7, masteryPercent: 88 },
          attempts: [{
              questionId: "question-1",
              answer: "secret answer",
              status: "correct",
              evaluationSource: "client_extension",
          }],
          revision: 2,
          startedAt: "2026-07-30T10:00:00.000Z",
          completedAt: "2026-07-30T10:10:00.000Z",
          updatedAt: "2026-07-30T10:10:00.000Z",
        },
      };
    }
    if (path.startsWith(`/v1/collections/${collection.id}/stats?`)) {
      return {
        data: {
          collectionId: collection.id,
          userId: member.userId,
          languageCode: "ja",
          words: { neko: { encounterCount: 3 } },
          phrases: {},
          sentences: {},
          aggregate: { encounterCount: 3 },
          revision: 1,
          updatedAt: "2026-07-30T10:10:00.000Z",
        },
      };
    }
    if (path.includes("/invites?") || path.includes("/audit?")) {
      return { data: { items: [], nextCursor: null } };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  const post = vi.fn().mockResolvedValue({ data: { ...lesson, status: "published", revision: 5 } });
  const put = vi.fn().mockResolvedValue({ data: {} });
  return {
    api: {
      get,
      post,
      put,
      patch: vi.fn().mockResolvedValue({ data: {} }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
      request: vi.fn().mockResolvedValue({ data: {} }),
    } as unknown as ApiClient,
    get,
    post,
    put,
  };
}

async function renderModal(
  effectivePermissions: readonly CollectionPermission[],
  onChanged = vi.fn(),
  currentUserId = "88888888-8888-4888-8888-888888888888",
  selectedCollection = collection,
) {
  const { api, get, post, put } = createApi();
  document.body.innerHTML = '<button id="opener">Open admin</button><div id="mount"></div>';
  document.querySelector<HTMLButtonElement>("#opener")!.focus();
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => {
    root!.render(createElement(CollectionAdminModal, {
      collection: selectedCollection,
      api,
      currentUserId,
      effectivePermissions,
      onClose: vi.fn(),
      onChanged,
    }));
  });
  await vi.waitFor(() => expect(document.body.textContent).toContain("Meoi Teacher"));
  return { get, post, put, onChanged };
}

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

describe("CollectionAdminModal", () => {
  it("uses effective permissions as the sole gate for privileged tabs and actions", async () => {
    await renderModal([]);

    expect(document.querySelector('[role="tablist"]')?.textContent).toContain("Members");
    expect(document.querySelector('[role="tablist"]')?.textContent).toContain("Roles");
    expect(document.querySelector('[role="tablist"]')?.textContent).toContain("Lessons");
    expect(document.querySelector('[role="tablist"]')?.textContent).not.toContain("Invites");
    expect(document.querySelector('[role="tablist"]')?.textContent).not.toContain("Audit log");
    expect(document.body.textContent).not.toContain("Progress");
    expect(document.body.textContent).not.toContain("Remove");
    expect(document.body.textContent).toContain("Save profile");

    await act(async () => button("Roles").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Collection roles"));
    expect(document.body.textContent).toContain("inspect roles");
    expect(document.body.textContent).not.toContain("New role");
  });

  it("shows member summaries without rendering raw answers when that permission is absent", async () => {
    const { get } = await renderModal(["view_member_progress"]);

    await act(async () => button("Progress").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("masteryPercent"));

    expect(get).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/progress?limit=50&collectionId=${collection.id}&userId=${member.userId}`),
      undefined,
    );
    expect(document.body.textContent).toContain("Raw answers require a separate permission");
    expect(document.body.textContent).not.toContain("secret answer");
  });

  it("sends an explicit target only when an authorized manager edits a member profile", async () => {
    const { put } = await renderModal(["manage_collection_profiles"]);
    const target = document.querySelector<HTMLSelectElement>(".collection-admin-profile-form select");
    const displayName = document.querySelector<HTMLInputElement>(
      '.collection-admin-profile-form input[placeholder="Collection display name"]',
    );
    if (!target || !displayName) throw new Error("Profile manager fields were not rendered.");

    await act(async () => {
      target.value = member.userId;
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(displayName.value).toBe("Teacher override"));
    await act(async () => changeInput(displayName, "Sensei"));
    await act(async () => button("Save profile").click());

    expect(put).toHaveBeenCalledWith(
      `/v1/collections/${collection.id}/profile`,
      {
        userId: member.userId,
        displayName: "Sensei",
        avatarAssetId: "77777777-7777-4777-8777-777777777777",
        bio: "Collection-only bio",
        expectedRevision: 3,
      },
    );
  });

  it("renders authorized raw answers and publishes lessons with optimistic revision", async () => {
    const onChanged = vi.fn();
    const { post } = await renderModal(
      ["view_member_progress", "view_member_answers", "publish_lessons", "manage_invites", "view_audit_log"],
      onChanged,
    );

    expect(document.querySelector('[role="tablist"]')?.textContent).toContain("Invites");
    expect(document.querySelector('[role="tablist"]')?.textContent).toContain("Audit log");

    await act(async () => button("Progress").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("JA term statistics"));
    expect(document.body.textContent).toContain("encounterCount");
    const rawAnswers = Array.from(document.querySelectorAll("summary"))
      .find((summary) => summary.textContent?.includes("Raw answers"));
    if (!rawAnswers) throw new Error("Raw answers disclosure was not rendered.");
    await act(async () => rawAnswers.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Raw answers (1)"));
    expect(document.body.textContent).toContain("secret answer");

    await act(async () => button("Lessons").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Greetings"));
    await act(async () => button("Publish").click());

    expect(post).toHaveBeenCalledWith(
      `/v1/lessons/${lesson.id}/publish`,
      { expectedRevision: lesson.revision },
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("lets the owner transfer ownership to an existing member", async () => {
    const ownerId = "88888888-8888-4888-8888-888888888888";
    const { post } = await renderModal(
      [],
      vi.fn(),
      ownerId,
      { ...collection, ownerId, revision: 9 },
    );
    const target = document.querySelector<HTMLSelectElement>(".collection-ownership-actions select");
    if (!target) throw new Error("Ownership target was not rendered.");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await act(async () => {
      target.value = member.userId;
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Transfer ownership").click());

    expect(post).toHaveBeenCalledWith(
      `/v1/collections/${collection.id}/transfer`,
      { newOwnerId: member.userId, expectedRevision: 9 },
    );
  });

  it("lets a non-owner leave the collection", async () => {
    const { post } = await renderModal([]);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await act(async () => button("Leave collection").click());

    expect(post).toHaveBeenCalledWith(`/v1/collections/${collection.id}/leave`);
  });
});
