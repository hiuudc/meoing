import { describe, expect, it } from "vitest";
import { normalizeStudyList, normalizeStudyText } from "../src/domain/normalize";
import { ApiError } from "../src/http/errors";
import { UnitDocumentSchema, UsernameSchema } from "../src/http/schemas";

describe("study content normalization", () => {
  it("normalizes Unicode, surrounding whitespace, and repeated whitespace", () => {
    expect(normalizeStudyText("  cafe\u0301 \n  au lait  ")).toBe("café au lait");
  });

  it("rejects duplicates after normalization while preserving case distinctions", () => {
    expect(() => normalizeStudyList(["go", " go  "], "words")).toThrow(ApiError);
    expect(normalizeStudyList(["go", "Go"], "words")).toEqual(["go", "Go"]);
  });

  it("preserves object metadata, removes no ids, and deduplicates by normalized text", () => {
    expect(normalizeStudyList([
      { text: " cafe\u0301  au lait ", translation: "  coffee  with milk ", notes: " noun " },
    ], "phrases")).toEqual([
      { text: "caf\u00e9 au lait", translation: "coffee with milk", notes: "noun" },
    ]);
    expect(() => normalizeStudyList(["go", { text: " go " }], "words")).toThrow(ApiError);
    expect(() => normalizeStudyList([{ id: "word-1", text: "go" }], "words")).toThrow(ApiError);
  });
});

describe("Discord-like usernames", () => {
  it("accepts 3-32 lowercase characters and rejects consecutive periods", () => {
    expect(UsernameSchema.safeParse("meo.ing_1").success).toBe(true);
    expect(UsernameSchema.safeParse("ab").success).toBe(false);
    expect(UsernameSchema.safeParse("Meoing").success).toBe(false);
    expect(UsernameSchema.safeParse("meo..ing").success).toBe(false);
  });
});

describe("persisted unit document images", () => {
  const validAssetId = "1b26fe98-1f4d-4306-a620-454059304cf5";

  it("accepts a private asset reference with an empty or omitted download URL", () => {
    for (const image of [
      { type: "meoi-image", assetId: validAssetId, src: "" },
      { type: "meoi-image", assetId: validAssetId },
    ]) {
      expect(UnitDocumentSchema.safeParse({
        title: "Private image",
        content: {
          root: {
            children: [image],
          },
        },
      }).success).toBe(true);
    }
  });

  it("rejects external image URLs and image nodes without an asset reference", () => {
    for (const image of [
      { type: "meoi-image", src: "https://tracker.example/pixel.png" },
      { type: "meoi-image", assetId: validAssetId, src: "https://signed.example/temporary" },
      { type: "meoi-image", assetId: "not-a-uuid", src: "" },
    ]) {
      expect(UnitDocumentSchema.safeParse({
        title: "Unsafe image",
        content: { root: { children: [image] } },
      }).success).toBe(false);
    }
  });
});
