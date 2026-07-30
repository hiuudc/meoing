import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./client";
import { readSettings, settingsValues, upsertSetting } from "./settings";

describe("cloud settings", () => {
  it("reads a scoped settings collection and exposes its values", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        items: [
          { key: "appearance", value: { accent: "#123456" }, revision: 2 },
        ],
      },
    });
    const api = { get } as unknown as ApiClient;

    const records = await readSettings(api, {
      scope: "collection",
      collectionId: "collection-id",
    });

    expect(get).toHaveBeenCalledWith(
      "/v1/settings?scope=collection&collectionId=collection-id",
    );
    expect(settingsValues(records)).toEqual({ appearance: { accent: "#123456" } });
  });

  it("sends the current revision when replacing a setting", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        items: [{ key: "theme", value: {}, revision: 4 }],
      },
    });
    const put = vi.fn().mockResolvedValue({
      data: { key: "theme", value: { base: "black" }, revision: 5 },
    });
    const api = { get, put } as unknown as ApiClient;

    await upsertSetting(api, { scope: "user" }, "theme", { base: "black" });

    expect(put).toHaveBeenCalledWith("/v1/settings", {
      scope: "user",
      key: "theme",
      value: { base: "black" },
      expectedRevision: 4,
    });
  });

  it("uses revision zero when creating a setting", async () => {
    const get = vi.fn().mockResolvedValue({ data: { items: [] } });
    const put = vi.fn().mockResolvedValue({
      data: { key: "unitOrder", value: [], revision: 1 },
    });
    const api = { get, put } as unknown as ApiClient;

    await upsertSetting(
      api,
      { scope: "collection_user", collectionId: "collection-id" },
      "unitOrder",
      [],
    );

    expect(put).toHaveBeenCalledWith("/v1/settings", {
      scope: "collection_user",
      collectionId: "collection-id",
      key: "unitOrder",
      value: [],
      expectedRevision: 0,
    });
  });
});
