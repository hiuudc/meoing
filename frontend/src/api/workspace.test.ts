import { describe, expect, it, vi } from "vitest";
import { createEmptyWorkspaceState } from "../store";
import type { ApiClient } from "./client";
import {
  loadDeletedCollections,
  loadDeletedUnits,
  restoreDeletedUnit,
  serializeUnitContent,
} from "./workspace";

describe("cloud unit serialization", () => {
  it("sends embedded arrays without UI IDs and strips expiring asset URLs", () => {
    const state = createEmptyWorkspaceState();
    state.units.unit = {
      id: "unit",
      collectionId: "collection",
      name: "Unit",
      description: "",
      revision: 3,
    };
    state.studyItems.word = {
      id: "word",
      unitId: "unit",
      kind: "word",
      text: "猫",
      translation: "cat",
      notes: "NFC",
      updatedAt: "Synced",
    };
    state.studyItemOrder = ["word"];
    state.documents.document = {
      id: "document",
      unitId: "unit",
      title: "Notes",
      type: "Notes",
      body: "",
      content: JSON.stringify({
        root: {
          children: [{
            type: "meoi-image",
            assetId: "asset-1",
            src: "https://signed.example.test/temporary",
          }],
        },
      }),
      updatedAt: "Synced",
    };
    state.documentOrder = ["document"];

    const serialized = serializeUnitContent(state, "unit");

    expect(serialized.words).toEqual([{ text: "猫", translation: "cat", notes: "NFC" }]);
    expect(serialized.words[0]).not.toHaveProperty("id");
    expect(serialized.documents[0]).not.toHaveProperty("id");
    expect((serialized.documents[0].content as {
      root: { children: Array<{ src: string; assetId: string }> };
    }).root.children[0]).toEqual({ type: "meoi-image", assetId: "asset-1", src: "" });
  });

  it("loads only restorable collections through the includeDeleted contract", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        items: [
          {
            id: "active",
            name: "Active",
            deletedAt: null,
            effectivePermissions: [],
          },
          {
            id: "deleted",
            name: "Deleted",
            description: "recover me",
            revision: 3,
            deletedAt: "2026-07-30T10:00:00.000Z",
            effectivePermissions: ["manage_collection"],
          },
        ],
        nextCursor: null,
      },
    });

    const result = await loadDeletedCollections({ get } as unknown as ApiClient);

    expect(get).toHaveBeenCalledWith("/v1/collections?includeDeleted=true");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "deleted",
      name: "Deleted",
      revision: 3,
      deletedAt: "2026-07-30T10:00:00.000Z",
    });
  });

  it("paginates includeDeleted units and filters out active units", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "active-unit",
              collectionId: "collection/id",
              name: "Active",
              revision: 2,
              deletedAt: null,
            },
            {
              id: "deleted-unit",
              collectionId: "collection/id",
              name: "Recover me",
              description: "Recently removed",
              revision: 4,
              deletedAt: "2026-07-30T10:00:00.000Z",
            },
          ],
          nextCursor: "next page",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{
            id: "deleted-unit-2",
            collectionId: "collection/id",
            name: "Recover me too",
            revision: 7,
            deletedAt: "2026-07-31T10:00:00.000Z",
          }],
          nextCursor: null,
        },
      });

    const result = await loadDeletedUnits(
      { get } as unknown as ApiClient,
      "collection/id",
    );

    expect(get).toHaveBeenNthCalledWith(
      1,
      "/v1/collections/collection%2Fid/units?includeDeleted=true",
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/v1/collections/collection%2Fid/units?includeDeleted=true&cursor=next%20page",
    );
    expect(result.map((unit) => unit.id)).toEqual(["deleted-unit", "deleted-unit-2"]);
    expect(result[0]).toMatchObject({
      collectionId: "collection/id",
      revision: 4,
      deletedAt: "2026-07-30T10:00:00.000Z",
    });
  });

  it("restores a deleted unit at its expected revision", async () => {
    const post = vi.fn().mockResolvedValue({ data: {} });

    await restoreDeletedUnit(
      { post } as unknown as ApiClient,
      { id: "unit/id", revision: 8 },
    );

    expect(post).toHaveBeenCalledWith(
      "/v1/units/unit%2Fid/restore",
      { expectedRevision: 8 },
    );
  });
});
