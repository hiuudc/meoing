import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./client";
import {
  hydrateLexicalDocumentForEditing,
  prepareLexicalDocumentForStorage,
  uploadProfileImage,
} from "./files";

function apiWithPost(post: ReturnType<typeof vi.fn>): ApiClient {
  return { post } as unknown as ApiClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Lexical file assets", () => {
  it("keeps an existing asset reference and removes its temporary signed URL", async () => {
    const post = vi.fn();
    const content = JSON.stringify({
      root: {
        children: [{
          type: "meoi-image",
          assetId: "asset-existing",
          src: "https://signed.example/temporary",
        }],
      },
    });

    const stored = JSON.parse(await prepareLexicalDocumentForStorage(
      apiWithPost(post),
      content,
      "collection-1",
    )) as { root: { children: Array<Record<string, unknown>> } };

    expect(stored.root.children[0]).toMatchObject({
      type: "meoi-image",
      assetId: "asset-existing",
      src: "",
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("uploads a data image as a collection-scoped private asset", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({
        data: {
          assetId: "asset-new",
          uploadUrl: "https://r2.example/upload",
          headers: { "x-upload-token": "signed" },
        },
      })
      .mockResolvedValueOnce({ data: { status: "ready" } });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("data:")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
      }
      expect(String(input)).toBe("https://r2.example/upload");
      expect(init?.method).toBe("PUT");
      expect(new Headers(init?.headers).get("x-upload-token")).toBe("signed");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onUploaded = vi.fn();

    const stored = JSON.parse(await prepareLexicalDocumentForStorage(
      apiWithPost(post),
      JSON.stringify({
        root: {
          children: [{
            type: "meoi-image",
            src: "data:image/png;base64,iVBORw==",
          }],
        },
      }),
      "collection-1",
      onUploaded,
    )) as { root: { children: Array<Record<string, unknown>> } };

    expect(post).toHaveBeenNthCalledWith(
      1,
      "/v1/files/uploads",
      expect.objectContaining({
        collectionId: "collection-1",
        filename: "embedded-image.png",
        mimeType: "image/png",
        size: 4,
      }),
      expect.any(String),
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/v1/files/asset-new/finalize",
      expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.any(String),
    );
    expect(stored.root.children[0]).toMatchObject({
      type: "meoi-image",
      assetId: "asset-new",
      src: "",
    });
    expect(onUploaded).toHaveBeenCalledWith("asset-new");
  });

  it("hydrates one signed URL per asset even when the document reuses it", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { downloadUrl: "https://r2.example/download" },
    });

    const hydrated = JSON.parse(await hydrateLexicalDocumentForEditing(
      apiWithPost(post),
      {
        root: {
          children: [
            { type: "meoi-image", assetId: "asset-1", src: "" },
            { type: "meoi-image", assetId: "asset-1", src: "" },
          ],
        },
      },
    )) as { root: { children: Array<Record<string, unknown>> } };

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/v1/files/asset-1/download");
    expect(hydrated.root.children.map((node) => node.src)).toEqual([
      "https://r2.example/download",
      "https://r2.example/download",
    ]);
  });

  it("uploads a selected profile image through the same private R2 flow", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({
        data: {
          assetId: "avatar-asset",
          uploadUrl: "https://r2.example/avatar-upload",
          headers: {},
        },
      })
      .mockResolvedValueOnce({ data: { status: "ready" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    const assetId = await uploadProfileImage(
      apiWithPost(post),
      new File([new Uint8Array([137, 80, 78, 71])], "avatar.png", { type: "image/png" }),
      "collection-1",
    );

    expect(assetId).toBe("avatar-asset");
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/v1/files/uploads",
      expect.objectContaining({
        collectionId: "collection-1",
        filename: "avatar.png",
        mimeType: "image/png",
        size: 4,
      }),
      expect.any(String),
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/v1/files/avatar-asset/finalize",
      expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.any(String),
    );
  });
});
