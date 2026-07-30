import { describe, expect, it } from "vitest";
import { normalizeStudyList, normalizeStudyText } from "../src/domain/normalize";
import { ApiError } from "../src/http/errors";
import { UsernameSchema } from "../src/http/schemas";

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
