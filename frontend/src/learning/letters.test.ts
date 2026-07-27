import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LETTERS_STORAGE_KEY,
  INTERNAL_CHARACTER_DISPLAY_LABELS,
  INTERNAL_CHARACTER_READINGS,
  createLettersProgressStore,
  getCharacterWindow,
  getLettersLanguageProgress,
  loadLettersProgress,
  matchesCharacterQuery,
  normalizeLettersPracticeQuestionCount,
  normalizeLettersProgressStore,
  normalizeStrokeTolerance,
  saveLettersProgress,
  scriptForCharacter,
  scriptsForLanguage,
  strokeToleranceForKey,
  strokeToleranceFromPosition,
  strokeToleranceLabel,
  strokeTolerancePosition,
  unicodeLabel,
  updateLettersLanguageProgress,
} from "./letters";
import {
  BASIC_HANGUL_JAMO,
  JAPANESE_STROKE_GROUPS,
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
            strokeTolerance: 1.36,
            showStrokeGuide: false,
            practiceQuestionCount: 9.7,
            characters: { "水": "mastered", "日": "practicing", word: "mastered", "火": "unknown" },
          },
        },
      },
    });
    expect(getLettersLanguageProgress(normalized, "collectionA", "Japanese")).toEqual({
      requireStrokeOrder: false,
      strokeTolerance: 1.4,
      showStrokeGuide: false,
      practiceQuestionCount: 10,
      characters: { "水": "mastered", "日": "practicing" },
    });
    expect(getLettersLanguageProgress(normalized, "collectionB", "Japanese")).toEqual({
      requireStrokeOrder: true,
      strokeTolerance: 1,
      showStrokeGuide: true,
      practiceQuestionCount: 5,
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

  it("clamps and defaults stroke tolerance without changing the storage version", () => {
    expect(normalizeStrokeTolerance(undefined)).toBe(1);
    expect(normalizeStrokeTolerance(Number.NaN)).toBe(1);
    expect(normalizeStrokeTolerance(0.01)).toBe(0.1);
    expect(normalizeStrokeTolerance(0.1)).toBe(0.1);
    expect(normalizeStrokeTolerance(1.26)).toBe(1.3);
    expect(normalizeStrokeTolerance(4)).toBe(2);
    expect(strokeToleranceLabel(1)).toBe("Standard 1.0x");
    expect(strokeToleranceLabel(1.2)).toBe("Custom 1.2x");
    expect(strokeTolerancePosition(0.1)).toBe(0);
    expect(strokeTolerancePosition(0.5)).toBeCloseTo(22.22, 1);
    expect(strokeTolerancePosition(1)).toBe(50);
    expect(strokeTolerancePosition(1.2)).toBe(60);
    expect(strokeTolerancePosition(2)).toBe(100);
    expect(strokeToleranceFromPosition(0)).toBe(0.1);
    expect(strokeToleranceFromPosition(50)).toBe(1);
    expect(strokeToleranceFromPosition(60)).toBe(1.2);
    expect(strokeToleranceFromPosition(100)).toBe(2);
    expect(strokeToleranceForKey(1, "ArrowLeft")).toBe(0.9);
    expect(strokeToleranceForKey(1, "ArrowRight")).toBe(1.1);
    expect(strokeToleranceForKey(1.2, "Home")).toBe(0.1);
    expect(strokeToleranceForKey(1.2, "End")).toBe(2);
    expect(strokeToleranceForKey(1.2, "Tab")).toBeNull();
    expect(normalizeLettersPracticeQuestionCount(undefined)).toBe(5);
    expect(normalizeLettersPracticeQuestionCount(0)).toBe(1);
    expect(normalizeLettersPracticeQuestionCount(7.6)).toBe(8);
    expect(normalizeLettersPracticeQuestionCount(99)).toBe(20);

    const legacy = normalizeLettersProgressStore({
      version: 1,
      collections: {
        collectionA: {
          Japanese: {
            requireStrokeOrder: true,
            characters: {},
          },
        },
      },
    });
    expect(legacy.version).toBe(1);
    expect(legacy.collections.collectionA.Japanese.strokeTolerance).toBe(1);
    expect(legacy.collections.collectionA.Japanese.showStrokeGuide).toBe(true);
    expect(legacy.collections.collectionA.Japanese.practiceQuestionCount).toBe(5);
  });

  it("falls back safely for invalid or future storage", () => {
    expect(loadLettersProgress(memoryStorage("{"))).toEqual(createLettersProgressStore());
    expect(loadLettersProgress(memoryStorage(JSON.stringify({ version: 2, collections: {} }))))
      .toEqual(createLettersProgressStore());
  });
});

describe("letters catalog helpers", () => {
  it("classifies scripts and searches characters, metadata, and Unicode codes", () => {
    expect(INTERNAL_CHARACTER_DISPLAY_LABELS.get("\u3041")).toBe("small a");
    expect(INTERNAL_CHARACTER_DISPLAY_LABELS.get("\u3042")).toBeUndefined();
    expect(INTERNAL_CHARACTER_DISPLAY_LABELS.get("\u30c3")).toBe("small tsu");
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
    expect(jamo.logicalData.strokes.length).toBeGreaterThan(0);
    expect(jamo.logicalData.medians).toHaveLength(jamo.logicalData.strokes.length);
    expect(jamo.animationData).toBe(jamo.logicalData);
    expect(jamo.animationGroups).toEqual(jamo.logicalData.strokes.map((_, index) => [index]));
  });

  it("merges Japanese animation paths into logical handwriting strokes", async () => {
    expect(Object.keys(JAPANESE_STROKE_GROUPS)).toHaveLength(37);
    expect(JAPANESE_STROKE_GROUPS["\u3042"]).toEqual([[0], [1], [2, 3]]);
    expect(JAPANESE_STROKE_GROUPS["\u306c"]).toEqual([[0], [1, 2, 3]]);
    expect(JAPANESE_STROKE_GROUPS["\uff19"]).toEqual([[0, 1, 2]]);
    expect(JAPANESE_STROKE_GROUPS["\u9697"]).toHaveLength(12);
    expect(JAPANESE_STROKE_GROUPS["\u9706"]).toHaveLength(14);
    const canonicalMedian = [[570, 460], [610, 416], [460, 173], [200, 64], [181, 218]];
    const splitMedian = [[-170, 458], [-210, 416], [460, 173], [200, 64], [181, 218]];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        "\u3042": {
          strokes: ["first", "second", "third-a", "third-b"],
          medians: [
            [[174, 642], [697, 659]],
            [[331, 763], [431, 123]],
            canonicalMedian,
            splitMedian,
          ],
        },
        "\u306c": {
          strokes: ["first", "second-a", "second-b", "second-c"],
          medians: [
            [[174, 642], [697, 659]],
            canonicalMedian,
            splitMedian,
            [[-220, 458], [-240, 416], [460, 173], [200, 64], [181, 218]],
          ],
        },
        "\uff19": {
          strokes: ["digit-a", "digit-b", "digit-c"],
          medians: [
            canonicalMedian,
            splitMedian,
            [[2_140, -900], [2_400, -1_200], [460, 173]],
          ],
        },
        "0": {
          strokes: ["digit-main", "digit-animation-tail"],
          medians: [
            [[210, 720], [520, 810], [760, 500], [510, 80], [210, 280]],
            [[2_140, -900], [2_400, -1_200]],
          ],
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await loadStrokeCharacterData("Japanese", "\u3042");

    expect(data.logicalData.strokes).toEqual(["first", "second", "third-a third-b"]);
    expect(data.logicalData.medians).toEqual([
      [[174, 642], [697, 659]],
      [[331, 763], [431, 123]],
      canonicalMedian,
    ]);
    expect(data.animationData.strokes).toEqual(["first", "second", "third-a", "third-b"]);
    expect(data.animationGroups).toEqual([[0], [1], [2, 3]]);
    expect(fetchMock).toHaveBeenCalledWith("/stroke-data/ja/30.json", {
      credentials: "same-origin",
    });

    const digit = await loadStrokeCharacterData("Japanese", "0");
    expect(digit.logicalData.strokes).toEqual(["digit-main digit-animation-tail"]);
    expect(digit.logicalData.medians).toEqual([
      [[210, 720], [520, 810], [760, 500], [510, 80], [210, 280]],
    ]);
    expect(digit.animationGroups).toEqual([[0, 1]]);

    const nu = await loadStrokeCharacterData("Japanese", "\u306c");
    expect(nu.logicalData.strokes).toEqual(["first", "second-a second-b second-c"]);
    expect(nu.animationGroups).toEqual([[0], [1, 2, 3]]);

    const nine = await loadStrokeCharacterData("Japanese", "\uff19");
    expect(nine.logicalData.strokes).toEqual(["digit-a digit-b digit-c"]);
    expect(nine.animationGroups).toEqual([[0, 1, 2]]);
  });
});
