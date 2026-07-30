import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./client";
import {
  acceptCollectionInvite,
  createCollectionRole,
  getCollectionMemberLanguageStats,
  getProgressDetail,
  leaveCollection,
  listCollectionMembers,
  listMemberProgress,
  previewCollectionInvite,
  transferCollectionOwnership,
} from "./collectionAdmin";

function apiWith(methods: Partial<ApiClient>): ApiClient {
  return methods as ApiClient;
}

describe("collection administration API", () => {
  it("encodes collection cursors and teacher progress filters", async () => {
    const signal = new AbortController().signal;
    const get = vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } });
    const api = apiWith({ get });

    await listCollectionMembers(api, "collection/one", "cursor + /", signal);
    await listMemberProgress(api, "collection/one", "user/two", null, signal);

    expect(get).toHaveBeenNthCalledWith(
      1,
      "/v1/collections/collection%2Fone/members?limit=50&cursor=cursor+%2B+%2F",
      signal,
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/v1/progress?limit=50&collectionId=collection%2Fone&userId=user%2Ftwo",
      signal,
    );
  });

  it("uses an idempotency key when creating roles", async () => {
    const post = vi.fn().mockResolvedValue({ data: {} });
    const api = apiWith({ post });

    await createCollectionRole(api, "collection-id", {
      name: "Teacher",
      color: "#655bf5",
      permissions: ["edit_content", "publish_lessons"],
      securityRank: 5,
    });

    expect(post).toHaveBeenCalledWith(
      "/v1/collections/collection-id/roles",
      {
        name: "Teacher",
        color: "#655bf5",
        permissions: ["edit_content", "publish_lessons"],
        securityRank: 5,
      },
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
  });

  it("passes Turnstile and idempotency headers through the shared client", async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    const api = apiWith({ request });

    await previewCollectionInvite(api, "invite-token", "turnstile-preview");
    await acceptCollectionInvite(api, "invite-token", "turnstile-accept");

    expect(request).toHaveBeenNthCalledWith(1, "/v1/invites/preview", {
      method: "POST",
      headers: { "x-turnstile-token": "turnstile-preview" },
      body: { token: "invite-token" },
    });
    expect(request).toHaveBeenNthCalledWith(2, "/v1/invites/accept", {
      method: "POST",
      headers: { "x-turnstile-token": "turnstile-accept" },
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      body: { token: "invite-token" },
    });
  });

  it("loads sensitive progress separately and addresses collection member stats", async () => {
    const signal = new AbortController().signal;
    const get = vi.fn().mockResolvedValue({ data: {} });
    const api = apiWith({ get });

    await getProgressDetail(api, "progress/id", signal);
    await getCollectionMemberLanguageStats(
      api,
      "collection/id",
      "user/id",
      "ja-JP",
      signal,
    );

    expect(get).toHaveBeenNthCalledWith(1, "/v1/progress/progress%2Fid", signal);
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/v1/collections/collection%2Fid/stats?languageCode=ja-JP&userId=user%2Fid",
      signal,
    );
  });

  it("uses dedicated ownership and leave mutations", async () => {
    const post = vi.fn().mockResolvedValue({ data: {} });
    const api = apiWith({ post });

    await transferCollectionOwnership(api, "collection/id", "user/id", 7);
    await leaveCollection(api, "collection/id");

    expect(post).toHaveBeenNthCalledWith(
      1,
      "/v1/collections/collection%2Fid/transfer",
      { newOwnerId: "user/id", expectedRevision: 7 },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/v1/collections/collection%2Fid/leave",
    );
  });
});
