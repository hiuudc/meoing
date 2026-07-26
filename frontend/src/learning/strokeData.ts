import type { CharacterJson } from "hanzi-writer";
import { getSupportedLanguage } from "./languages";

type StrokeDataLanguage = "zh" | "ja" | "ko";
type Point = [number, number];

const shardCache = new Map<string, Promise<Record<string, CharacterJson>>>();
let catalogPromise: Promise<{ zh: string[]; ja: string[] }> | null = null;
const CHARACTER_BOUNDS = {
  minX: 0,
  maxX: 1_024,
  minY: -124,
  maxY: 900,
} as const;

function matchingEdgePoints(left: number[][], right: number[][], fromStart: boolean): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit) {
    const leftIndex = fromStart ? count : left.length - count - 1;
    const rightIndex = fromStart ? count : right.length - count - 1;
    const leftPoint = left[leftIndex];
    const rightPoint = right[rightIndex];
    if (leftPoint[0] !== rightPoint[0] || leftPoint[1] !== rightPoint[1]) break;
    count += 1;
  }
  return count;
}

function isTechnicalStrokePart(left: number[][], right: number[][]): boolean {
  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength < 3) return false;
  const sharedEdgePoints = Math.max(
    matchingEdgePoints(left, right, true),
    matchingEdgePoints(left, right, false),
  );
  return sharedEdgePoints >= Math.max(3, Math.ceil(shorterLength * .25));
}

function hasImpossibleMedianPoint(median: number[][]): boolean {
  return median.some(([x, y]) => (
    x < CHARACTER_BOUNDS.minX
    || x > CHARACTER_BOUNDS.maxX
    || y < CHARACTER_BOUNDS.minY
    || y > CHARACTER_BOUNDS.maxY
  ));
}

function normalizeJapaneseStrokeData(data: CharacterJson): CharacterJson {
  if (data.strokes.length < 2 || data.strokes.length !== data.medians.length) return data;
  const strokes: string[] = [];
  const medians: number[][][] = [];
  const mergedIndexes: number[] = [];
  let changed = false;

  data.strokes.forEach((stroke, index) => {
    const previousMedian = data.medians[index - 1];
    const median = data.medians[index];
    if (previousMedian && (
      isTechnicalStrokePart(previousMedian, median)
      || hasImpossibleMedianPoint(median)
    )) {
      const mergedIndex = strokes.length - 1;
      strokes[mergedIndex] = `${strokes[mergedIndex]} ${stroke}`;
      mergedIndexes[index] = mergedIndex;
      changed = true;
      return;
    }
    mergedIndexes[index] = strokes.length;
    strokes.push(stroke);
    medians.push(median);
  });

  if (!changed) return data;
  const radStrokes = data.radStrokes
    ? [...new Set(data.radStrokes.map((index) => mergedIndexes[index]))]
    : undefined;
  return {
    ...data,
    strokes,
    medians,
    ...(radStrokes ? { radStrokes } : {}),
  };
}

function validateCharacterData(data: CharacterJson, character: string): CharacterJson {
  if (
    !Array.isArray(data.strokes)
    || !Array.isArray(data.medians)
    || !data.strokes.length
    || data.strokes.length !== data.medians.length
  ) {
    throw new Error(`Stroke data for ${character} is malformed.`);
  }
  const valid = data.medians.every((median) => (
    Array.isArray(median)
    && median.length >= 2
    && median.every((point) => (
      Array.isArray(point)
      && point.length >= 2
      && Number.isFinite(point[0])
      && Number.isFinite(point[1])
      && point[0] >= CHARACTER_BOUNDS.minX
      && point[0] <= CHARACTER_BOUNDS.maxX
      && point[1] >= CHARACTER_BOUNDS.minY
      && point[1] <= CHARACTER_BOUNDS.maxY
    ))
  ));
  if (!valid) throw new Error(`Stroke data for ${character} contains an invalid median.`);
  return data;
}

function shardKey(character: string): string {
  const codePoint = character.codePointAt(0);
  return codePoint === undefined ? "0" : Math.floor(codePoint / 256).toString(16);
}

function strokeLanguage(language: string): StrokeDataLanguage | null {
  const normalized = getSupportedLanguage(language)?.name;
  if (normalized === "Chinese") return "zh";
  if (normalized === "Japanese") return "ja";
  if (normalized === "Korean") return "ko";
  return null;
}

function linePath([startX, startY]: Point, [endX, endY]: Point, width = 54): string {
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const offsetX = (-dy / length) * width;
  const offsetY = (dx / length) * width;
  return [
    `M ${startX + offsetX} ${startY + offsetY}`,
    `L ${endX + offsetX} ${endY + offsetY}`,
    `L ${endX - offsetX} ${endY - offsetY}`,
    `L ${startX - offsetX} ${startY - offsetY}`,
    "Z",
  ].join(" ");
}

interface JamoTemplate {
  width: number;
  strokes: Point[][];
}

const CONSONANTS: JamoTemplate[] = [
  { width: 1, strokes: [[[120, 820], [760, 820]], [[760, 820], [760, 180]]] }, // ㄱ
  { width: 1, strokes: [[[160, 820], [160, 180]], [[160, 180], [800, 180]]] }, // ㄴ
  { width: 1, strokes: [[[160, 820], [780, 820]], [[780, 820], [780, 180]], [[780, 180], [160, 180]], [[160, 180], [160, 820]]] }, // ㄷ
  { width: 1, strokes: [[[160, 820], [160, 180]], [[160, 500], [760, 500]], [[760, 820], [760, 180]]] }, // ㄹ
  { width: 1, strokes: [[[180, 180], [180, 780]], [[180, 180], [760, 180]], [[760, 180], [760, 780]]] }, // ㅁ
  { width: 1, strokes: [[[160, 800], [160, 200]], [[160, 500], [760, 500]], [[760, 800], [760, 200]]] }, // ㅂ
  { width: 1, strokes: [[[180, 760], [760, 240]], [[760, 760], [180, 240]]] }, // ㅅ
  { width: 1, strokes: [[[460, 760], [460, 260]], [[220, 520], [700, 520]]] }, // ㅇ (simplified cross template)
  { width: 1, strokes: [[[180, 780], [740, 220]], [[740, 780], [180, 220]], [[160, 500], [760, 500]]] }, // ㅈ
  { width: 1, strokes: [[[180, 760], [740, 240]], [[740, 760], [180, 240]], [[160, 830], [760, 830]]] }, // ㅊ
  { width: 1, strokes: [[[160, 800], [760, 800]], [[460, 800], [460, 180]]] }, // ㅋ
  { width: 1, strokes: [[[160, 800], [760, 800]], [[160, 500], [760, 500]], [[460, 800], [460, 180]]] }, // ㅌ
  { width: 1, strokes: [[[160, 800], [760, 800]], [[160, 500], [760, 500]], [[160, 200], [760, 200]]] }, // ㅍ
  { width: 1, strokes: [[[160, 760], [760, 760]], [[460, 760], [460, 560]], [[240, 480], [680, 480]], [[240, 480], [240, 180]], [[680, 480], [680, 180]]] }, // ㅎ
];

const VOWELS: JamoTemplate[] = [
  { width: .65, strokes: [[[460, 850], [460, 150]], [[460, 500], [780, 500]]] }, // ㅏ
  { width: .65, strokes: [[[500, 850], [500, 150]], [[180, 500], [500, 500]]] }, // ㅓ
  { width: .65, strokes: [[[460, 850], [460, 150]], [[460, 610], [780, 610]], [[460, 390], [780, 390]]] }, // ㅑ
  { width: .65, strokes: [[[500, 850], [500, 150]], [[180, 610], [500, 610]], [[180, 390], [500, 390]]] }, // ㅕ
  { width: 1, strokes: [[[150, 560], [850, 560]], [[500, 560], [500, 220]]] }, // ㅗ
  { width: 1, strokes: [[[150, 460], [850, 460]], [[390, 800], [390, 460]], [[610, 800], [610, 460]]] }, // ㅛ
  { width: 1, strokes: [[[150, 440], [850, 440]], [[500, 800], [500, 440]]] }, // ㅜ
  { width: 1, strokes: [[[150, 540], [850, 540]], [[390, 540], [390, 180]], [[610, 540], [610, 180]]] }, // ㅠ
  { width: 1, strokes: [[[150, 500], [850, 500]]] }, // ㅡ
  { width: .65, strokes: [[[500, 850], [500, 150]]] }, // ㅣ
];

export const BASIC_HANGUL_JAMO = [
  "ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㅁ", "ㅂ", "ㅅ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
  "ㅏ", "ㅓ", "ㅑ", "ㅕ", "ㅗ", "ㅛ", "ㅜ", "ㅠ", "ㅡ", "ㅣ",
] as const;

const LEAD_TO_TEMPLATE = [0, 0, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 13];
const VOWEL_TO_TEMPLATE = [0, 1, 2, 3, 0, 0, 1, 1, 4, 4, 4, 5, 6, 6, 6, 7, 8, 8, 8, 9, 9];
const TRAIL_TO_TEMPLATE = [-1, 0, 0, 0, 1, 1, 1, 2, 3, 3, 3, 3, 3, 4, 5, 5, 6, 6, 7, 7, 7, 8, 10, 11, 12, 13, 13, 13];

function transformStrokes(template: JamoTemplate, x: number, y: number, width: number, height: number): Point[][] {
  return template.strokes.map((stroke) => stroke.map(([pointX, pointY]) => [
    x + (pointX / 1_000) * width,
    y + (pointY / 1_000) * height,
  ]));
}

function hangulData(character: string): CharacterJson | null {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || codePoint < 0xac00 || codePoint > 0xd7a3) return null;
  const syllable = codePoint - 0xac00;
  const lead = Math.floor(syllable / 588);
  const vowel = Math.floor((syllable % 588) / 28);
  const trail = syllable % 28;
  const vowelTemplate = VOWELS[VOWEL_TO_TEMPLATE[vowel]];
  const leadTemplate = CONSONANTS[LEAD_TO_TEMPLATE[lead]];
  const trailIndex = TRAIL_TO_TEMPLATE[trail];
  const hasBottom = trailIndex >= 0;
  const isVerticalVowel = vowelTemplate.width < 1;
  const upperHeight = hasBottom ? 610 : 820;
  const strokes: Point[][] = [];

  if (isVerticalVowel) {
    strokes.push(...transformStrokes(leadTemplate, 80, hasBottom ? 320 : 180, 430, upperHeight));
    strokes.push(...transformStrokes(vowelTemplate, 500, hasBottom ? 320 : 180, 430, upperHeight));
  } else {
    strokes.push(...transformStrokes(leadTemplate, 170, hasBottom ? 470 : 310, 680, hasBottom ? 440 : 570));
    strokes.push(...transformStrokes(vowelTemplate, 150, hasBottom ? 245 : 80, 700, 330));
  }
  if (hasBottom) {
    strokes.push(...transformStrokes(CONSONANTS[trailIndex], 190, 35, 640, 300));
  }

  return {
    strokes: strokes.map((stroke) => linePath(stroke[0], stroke[stroke.length - 1])),
    medians: strokes,
  };
}

function jamoData(character: string): CharacterJson | null {
  const index = BASIC_HANGUL_JAMO.indexOf(character as (typeof BASIC_HANGUL_JAMO)[number]);
  if (index < 0) return null;
  const template = index < CONSONANTS.length ? CONSONANTS[index] : VOWELS[index - CONSONANTS.length];
  return {
    strokes: template.strokes.map((stroke) => linePath(stroke[0], stroke[stroke.length - 1])),
    medians: template.strokes,
  };
}

function modernHangulSyllables(): string[] {
  return Array.from({ length: 0xd7a3 - 0xac00 + 1 }, (_, index) => String.fromCodePoint(0xac00 + index));
}

export async function loadStrokeCatalog(language: string): Promise<string[]> {
  const family = strokeLanguage(language);
  if (!family) return [];
  if (family === "ko") return [...BASIC_HANGUL_JAMO, ...modernHangulSyllables()];
  if (!catalogPromise) {
    catalogPromise = fetch("/stroke-data/catalog.json", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Stroke catalog is unavailable (${response.status}).`);
        return response.json() as Promise<{ zh: string[]; ja: string[] }>;
      });
  }
  const catalog = await catalogPromise;
  return [...catalog[family]];
}

async function loadShard(language: "zh" | "ja", character: string): Promise<Record<string, CharacterJson>> {
  const key = `${language}:${shardKey(character)}`;
  const cached = shardCache.get(key);
  if (cached) return cached;
  const request = fetch(`/stroke-data/${language}/${shardKey(character)}.json`, {
    credentials: "same-origin",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Stroke data is unavailable (${response.status}).`);
    return response.json() as Promise<Record<string, CharacterJson>>;
  });
  shardCache.set(key, request);
  return request;
}

export function supportsCharacterTracing(language: string): boolean {
  return strokeLanguage(language) !== null;
}

export async function loadStrokeCharacterData(language: string, character: string): Promise<CharacterJson> {
  const family = strokeLanguage(language);
  if (!family) throw new Error(`Character tracing is not available for ${language}.`);
  if (family === "ko") {
    const generated = jamoData(character) ?? hangulData(character);
    if (!generated) throw new Error("Only modern Hangul syllables are supported.");
    return validateCharacterData(generated, character);
  }
  const shard = await loadShard(family, character);
  const data = shard[character];
  if (!data) throw new Error(`No stroke data is available for ${character}.`);
  return validateCharacterData(
    family === "ja" ? normalizeJapaneseStrokeData(data) : data,
    character,
  );
}

export function clearStrokeDataCache(): void {
  shardCache.clear();
  catalogPromise = null;
}
