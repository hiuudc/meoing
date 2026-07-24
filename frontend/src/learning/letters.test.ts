import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LETTERS_STORAGE_KEY,
  INTERNAL_CHARACTER_READINGS,
  createLettersProgressStore,
  getCharacterWindow,
  getLettersLanguageProgress,
  loadLettersProgress,
  matchesCharacterQuery,
  normalizeLettersProgressStore,
  saveLettersProgress,
  scriptForCharacter,
  scriptsForLanguage,
  unicodeLabel,
  updateLettersLanguageProgress,
} from "./letters";
import {
  BASIC_HANGUL_JAMO,
  clearStrokeDataCache,
  loadStrokeCatalog,
  loadStrokeCharacterData,
} from "./strokeData";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(LETTERS_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

afterEach(() => {
  clearStrokeDataCache();
  vi.unstubAllGlobals();
});

describe("letters progress", () => {
  it("normalizes sparse progress and isolates it by Collection and language", () => {
    const normalized = normalizeLettersProgressStore({
      version: 1,
      collections: {
        collectionA: {
          Japanese: {
            requireStrokeOrder: false,
            characters: { "水": "mastered", "日": "practicing", word: "mastered", "火": "unknown" },
          },
        },
      },
    });
    expect(getLettersLanguageProgress(normalized, "collectionA", "Japanese")).toEqual({
      requireStrokeOrder: false,
      characters: { "水": "mastered", "日": "practicing" },
    });
    expect(getLettersLanguageProgress(normalized, "collectionB", "Japanese")).toEqual({
      requireStrokeOrder: true,
      characters: {},
    });

    const updated = updateLettersLanguageProgress(
      createLettersProgressStore(),
      "collectionB",
      "Korean",
      (progress) => ({ ...progress, characters: { "가": "practicing" } }),
    );
    const storage = memoryStorage();
    expect(saveLettersProgress(updated, storage)).toBe(true);
    expect(loadLettersProgress(storage).collections.collectionB.Korean.characters).toEqual({ "가": "practicing" });
  });

  it("falls back safely for invalid or future storage", () => {
    expect(loadLettersProgress(memoryStorage("{"))).toEqual(createLettersProgressStore());
    expect(loadLettersProgress(memoryStorage(JSON.stringify({ version: 2, collections: {} }))))
      .toEqual(createLettersProgressStore());
  });
});

describe("letters catalog helpers", () => {
  it("classifies scripts and searches characters, metadata, and Unicode codes", () => {
    expect(scriptsForLanguage("Japanese").map((script) => script.id)).toEqual(["hiragana", "katakana", "kanji", "other"]);
    expect(scriptsForLanguage("Chinese").map((script) => script.id)).toEqual(["hanzi", "other"]);
    expect(scriptsForLanguage("Korean").map((script) => script.id)).toEqual(["jamo", "syllables"]);
    expect(scriptsForLanguage("German")).toEqual([]);
    expect(scriptForCharacter("Japanese", "あ")).toBe("hiragana");
    expect(scriptForCharacter("Japanese", "ア")).toBe("katakana");
    expect(scriptForCharacter("Japanese", "水")).toBe("kanji");
    expect(scriptForCharacter("Chinese", "水")).toBe("hanzi");
    expect(scriptForCharacter("Korean", "ㄱ")).toBe("jamo");
    expect(scriptForCharacter("Korean", "가")).toBe("syllables");
    expect([...INTERNAL_CHARACTER_READINGS].filter(([character]) => scriptForCharacter("Japanese", character) === "hiragana"))
      .toHaveLength(86);
    expect([...INTERNAL_CHARACTER_READINGS].filter(([character]) => scriptForCharacter("Japanese", character) === "katakana"))
      .toHaveLength(90);
    expect(INTERNAL_CHARACTER_READINGS.get("が")).toBe("ga");
    expect(INTERNAL_CHARACTER_READINGS.get("ヷ")).toBe("va");
    expect(INTERNAL_CHARACTER_READINGS.get("ㄱ")).toBe("g/k");
    expect(unicodeLabel("水")).toBe("U+6C34");
    expect(matchesCharacterQuery("水", "U+6C34")).toBe(true);
    expect(matchesCharacterQuery("水", "6c34")).toBe(true);
    expect(matchesCharacterQuery("水", "water", "mizu water")).toBe(true);
    expect(matchesCharacterQuery("水", "fire", "mizu water")).toBe(false);
  });

  it("calculates a bounded window instead of rendering the full catalog", () => {
    expect(getCharacterWindow({
      characterCount: 1_000,
      columns: 10,
      scrollTop: 1_000,
      viewportHeight: 300,
      rowHeight: 100,
      overscanRows: 2,
    })).toEqual({
      rowCount: 100,
      startRow: 8,
      endRow: 15,
      startIndex: 80,
      endIndex: 150,
    });
  });

  it("lazy-loads the shared CJK manifest and creates the complete internal Hangul catalog", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ zh: ["水", "火"], ja: ["日", "本"] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadStrokeCatalog("Chinese")).toEqual(["水", "火"]);
    expect(await loadStrokeCatalog("Japanese")).toEqual(["日", "本"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const korean = await loadStrokeCatalog("Korean");
    expect(korean).toHaveLength(BASIC_HANGUL_JAMO.length + 11_172);
    expect(korean).toContain("ㄱ");
    expect(korean).toContain("가");
    expect(korean).toContain("힣");
    const jamo = await loadStrokeCharacterData("Korean", "ㄱ");
    expect(jamo.strokes.length).toBeGreaterThan(0);
    expect(jamo.medians).toHaveLength(jamo.strokes.length);
  });
});
