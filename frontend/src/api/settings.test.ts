import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "./client";
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

  it("coalesces queued writes for the same setting so the latest value wins", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [{ key: "sidebarWidth", value: 280, revision: 1 }] } });
    const put = vi.fn()
      .mockImplementationOnce(async () => {
        await firstWrite;
        return { data: { key: "sidebarWidth", value: 280, revision: 1 } };
      })
      .mockResolvedValueOnce({ data: { key: "sidebarWidth", value: 340, revision: 2 } });
    const api = { get, put } as unknown as ApiClient;

    const first = upsertSetting(api, { scope: "user" }, "sidebarWidth", 280);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const superseded = upsertSetting(api, { scope: "user" }, "sidebarWidth", 320);
    const latest = upsertSetting(api, { scope: "user" }, "sidebarWidth", 340);
    releaseFirstWrite?.();

    await expect(first).resolves.toMatchObject({ value: 280 });
    await expect(superseded).resolves.toMatchObject({ value: 340 });
    await expect(latest).resolves.toMatchObject({ value: 340 });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith("/v1/settings", expect.objectContaining({
      value: 340,
      expectedRevision: 1,
    }));
  });

  it("re-reads the revision and retries a conflict once", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { items: [{ key: "unitOrder", value: [], revision: 2 }] } })
      .mockResolvedValueOnce({ data: { items: [{ key: "unitOrder", value: [], revision: 3 }] } });
    const put = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, {
        code: "REVISION_CONFLICT",
        message: "The setting changed.",
      }))
      .mockResolvedValueOnce({ data: { key: "unitOrder", value: ["unit-id"], revision: 4 } });
    const api = { get, put } as unknown as ApiClient;

    await expect(upsertSetting(
      api,
      { scope: "collection_user", collectionId: "collection-id" },
      "unitOrder",
      ["unit-id"],
    )).resolves.toMatchObject({ revision: 4 });

    expect(get).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenNthCalledWith(1, "/v1/settings", expect.objectContaining({ expectedRevision: 2 }));
    expect(put).toHaveBeenNthCalledWith(2, "/v1/settings", expect.objectContaining({ expectedRevision: 3 }));
  });
});
