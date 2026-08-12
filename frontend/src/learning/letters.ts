import { BASIC_HANGUL_JAMO } from "./strokeData";

export const LETTERS_STORAGE_KEY = "meoi.letters.v1";
export const LETTERS_STORAGE_VERSION = 1;
export const MIN_STROKE_TOLERANCE = 0.1;
export const MAX_STROKE_TOLERANCE = 2;
export const DEFAULT_STROKE_TOLERANCE = 1;
export const STROKE_TOLERANCE_PRESETS = [
  { label: "Strict", value: MIN_STROKE_TOLERANCE },
  { label: "Standard", value: DEFAULT_STROKE_TOLERANCE },
  { label: "Forgiving", value: MAX_STROKE_TOLERANCE },
] as const;
export const MIN_LETTERS_PRACTICE_CHARACTERS = 1;
export const MAX_LETTERS_PRACTICE_CHARACTERS = 10;
export const DEFAULT_LETTERS_PRACTICE_CHARACTERS = 5;

export type LetterProgressStatus = "practicing" | "mastered";
export type LettersScript =
  | "hiragana"
  | "katakana"
  | "kanji"
  | "hanzi"
  | "jamo"
  | "syllables"
  | "other";

export interface LettersLanguageProgress {
  requireStrokeOrder: boolean;
  strokeTolerance: number;
  showStrokeGuide: boolean;
  practiceCharacterCount: number;
  characters: Record<string, LetterProgressStatus>;
}

export interface LetterSettings {
  requireStrokeOrder: boolean;
  strokeTolerance: number;
  showStrokeGuide: boolean;
}

export interface LettersProgressStore {
  version: typeof LETTERS_STORAGE_VERSION;
  collections: Record<string, Record<string, LettersLanguageProgress>>;
}

export interface LettersScriptDefinition {
  id: LettersScript;
  label: string;
}

export interface CharacterWindow {
  rowCount: number;
  startRow: number;
  endRow: number;
  startIndex: number;
  endIndex: number;
}

const DEFAULT_LANGUAGE_PROGRESS: LettersLanguageProgress = {
  requireStrokeOrder: true,
  strokeTolerance: DEFAULT_STROKE_TOLERANCE,
  showStrokeGuide: true,
  practiceCharacterCount: DEFAULT_LETTERS_PRACTICE_CHARACTERS,
  characters: {},
};

const JAPANESE_SCRIPTS: LettersScriptDefinition[] = [
  { id: "hiragana", label: "Hiragana" },
  { id: "katakana", label: "Katakana" },
  { id: "kanji", label: "Kanji" },
  { id: "other", label: "Other" },
];

const CHINESE_SCRIPTS: LettersScriptDefinition[] = [
  { id: "hanzi", label: "Hanzi" },
  { id: "other", label: "Other" },
];

const KOREAN_SCRIPTS: LettersScriptDefinition[] = [
  { id: "jamo", label: "Jamo" },
  { id: "syllables", label: "Syllables" },
];

const HIRAGANA_READINGS = [
  ["ぁ", "a"], ["あ", "a"], ["ぃ", "i"], ["い", "i"], ["ぅ", "u"], ["う", "u"], ["ゔ", "vu"],
  ["ぇ", "e"], ["え", "e"], ["ぉ", "o"], ["お", "o"], ["ゕ", "ka"], ["か", "ka"], ["が", "ga"],
  ["き", "ki"], ["ぎ", "gi"], ["く", "ku"], ["ぐ", "gu"], ["ゖ", "ke"], ["け", "ke"], ["げ", "ge"],
  ["こ", "ko"], ["ご", "go"], ["さ", "sa"], ["ざ", "za"], ["し", "shi"], ["じ", "ji"], ["す", "su"],
  ["ず", "zu"], ["せ", "se"], ["ぜ", "ze"], ["そ", "so"], ["ぞ", "zo"], ["た", "ta"], ["だ", "da"],
  ["ち", "chi"], ["ぢ", "ji"], ["っ", "tsu"], ["つ", "tsu"], ["づ", "zu"], ["て", "te"], ["で", "de"],
  ["と", "to"], ["ど", "do"], ["な", "na"], ["に", "ni"], ["ぬ", "nu"], ["ね", "ne"], ["の", "no"],
  ["は", "ha"], ["ば", "ba"], ["ぱ", "pa"], ["ひ", "hi"], ["び", "bi"], ["ぴ", "pi"], ["ふ", "fu"],
  ["ぶ", "bu"], ["ぷ", "pu"], ["へ", "he"], ["べ", "be"], ["ぺ", "pe"], ["ほ", "ho"], ["ぼ", "bo"],
  ["ぽ", "po"], ["ま", "ma"], ["み", "mi"], ["む", "mu"], ["め", "me"], ["も", "mo"], ["ゃ", "ya"],
  ["や", "ya"], ["ゅ", "yu"], ["ゆ", "yu"], ["ょ", "yo"], ["よ", "yo"], ["ら", "ra"], ["り", "ri"],
  ["る", "ru"], ["れ", "re"], ["ろ", "ro"], ["ゎ", "wa"], ["わ", "wa"], ["ゐ", "wi"], ["ゑ", "we"],
  ["を", "wo"], ["ん", "n"],
] as const;

const KATAKANA_READINGS = [
  ...HIRAGANA_READINGS.map(([character, reading]) => [
    String.fromCodePoint((character.codePointAt(0) ?? 0) + 0x60),
    reading,
  ] as const),
  ["ヷ", "va"], ["ヸ", "vi"], ["ヹ", "ve"], ["ヺ", "vo"],
] as const;

const JAMO_READINGS = [
  "g/k", "n", "d/t", "r/l", "m", "b/p", "s", "ng", "j", "ch", "k", "t", "p", "h",
  "a", "eo", "ya", "yeo", "o", "yo", "u", "yu", "eu", "i",
] as const;

export const INTERNAL_CHARACTER_READINGS: ReadonlyMap<string, string> = new Map([
  ...HIRAGANA_READINGS,
  ...KATAKANA_READINGS,
  ...BASIC_HANGUL_JAMO.map((character, index) => [character, JAMO_READINGS[index]] as const),
]);

const SMALL_HIRAGANA_LABELS = [
  [0x3041, 0x3042, "small a"],
  [0x3043, 0x3044, "small i"],
  [0x3045, 0x3046, "small u"],
  [0x3047, 0x3048, "small e"],
  [0x3049, 0x304a, "small o"],
  [0x3063, 0x3064, "small tsu"],
  [0x3083, 0x3084, "small ya"],
  [0x3085, 0x3086, "small yu"],
  [0x3087, 0x3088, "small yo"],
  [0x308e, 0x308f, "small wa"],
  [0x3095, 0x304b, "small ka"],
  [0x3096, 0x3051, "small ke"],
] as const;

export const INTERNAL_CHARACTER_DISPLAY_LABELS: ReadonlyMap<string, string> = new Map([
  ...SMALL_HIRAGANA_LABELS.map(([smallCodePoint, , label]) => [
    String.fromCodePoint(smallCodePoint),
    label,
  ] as const),
  ...SMALL_HIRAGANA_LABELS.map(([smallCodePoint, , label]) => [
    String.fromCodePoint(smallCodePoint + 0x60),
    label,
  ] as const),
]);

const JAPANESE_KANA_PRACTICE_FAMILIES: ReadonlyMap<string, string> = new Map(
  SMALL_HIRAGANA_LABELS.flatMap(([smallCodePoint, regularCodePoint]) => {
    const hiraganaFamily = String.fromCodePoint(regularCodePoint);
    const katakanaFamily = String.fromCodePoint(regularCodePoint + 0x60);
    return [
      [String.fromCodePoint(smallCodePoint), hiraganaFamily],
      [hiraganaFamily, hiraganaFamily],
      [String.fromCodePoint(smallCodePoint + 0x60), katakanaFamily],
      [katakanaFamily, katakanaFamily],
    ] as const;
  }),
);

export function lettersPracticeFamilyKey(character: string): string {
  return JAPANESE_KANA_PRACTICE_FAMILIES.get(character) ?? character;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSingleCharacter(value: string): boolean {
  return [...value].length === 1;
}

export function normalizeStrokeTolerance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_STROKE_TOLERANCE;
  const clamped = Math.min(MAX_STROKE_TOLERANCE, Math.max(MIN_STROKE_TOLERANCE, value));
  return Math.round(clamped * 10) / 10;
}

export function strokeTolerancePosition(value: number): number {
  const normalized = normalizeStrokeTolerance(value);
  if (normalized <= DEFAULT_STROKE_TOLERANCE) {
    return (normalized - MIN_STROKE_TOLERANCE)
      / (DEFAULT_STROKE_TOLERANCE - MIN_STROKE_TOLERANCE)
      * 50;
  }
  return 50 + (normalized - DEFAULT_STROKE_TOLERANCE)
    / (MAX_STROKE_TOLERANCE - DEFAULT_STROKE_TOLERANCE)
    * 50;
}

export function strokeToleranceFromPosition(value: number): number {
  const position = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 50;
  if (position <= 50) {
    return normalizeStrokeTolerance(
      MIN_STROKE_TOLERANCE
      + (position / 50) * (DEFAULT_STROKE_TOLERANCE - MIN_STROKE_TOLERANCE),
    );
  }
  return normalizeStrokeTolerance(
    DEFAULT_STROKE_TOLERANCE
    + ((position - 50) / 50) * (MAX_STROKE_TOLERANCE - DEFAULT_STROKE_TOLERANCE),
  );
}

export function strokeToleranceForKey(value: number, key: string): number | null {
  if (key === "Home") return MIN_STROKE_TOLERANCE;
  if (key === "End") return MAX_STROKE_TOLERANCE;
  const changes: Readonly<Record<string, number>> = {
    ArrowDown: -0.1,
    ArrowLeft: -0.1,
    ArrowRight: 0.1,
    ArrowUp: 0.1,
    PageDown: -0.5,
    PageUp: 0.5,
  };
  const change = changes[key];
  return change === undefined ? null : normalizeStrokeTolerance(value + change);
}

export function strokeToleranceLabel(value: number): string {
  const normalized = normalizeStrokeTolerance(value);
  const preset = STROKE_TOLERANCE_PRESETS.find((candidate) => candidate.value === normalized);
  return `${preset?.label ?? "Custom"} ${normalized.toFixed(1)}x`;
}

export function normalizeLettersPracticeCharacterCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LETTERS_PRACTICE_CHARACTERS;
  return Math.min(
    MAX_LETTERS_PRACTICE_CHARACTERS,
    Math.max(MIN_LETTERS_PRACTICE_CHARACTERS, Math.round(value)),
  );
}

function normalizeLanguageProgress(value: unknown): LettersLanguageProgress {
  if (!isRecord(value)) return { ...DEFAULT_LANGUAGE_PROGRESS, characters: {} };
  const rawCharacters = isRecord(value.characters) ? value.characters : {};
  const characters: Record<string, LetterProgressStatus> = {};
  Object.entries(rawCharacters).slice(0, 50_000).forEach(([character, status]) => {
    if (!isSingleCharacter(character) || (status !== "practicing" && status !== "mastered")) return;
    characters[character] = status;
  });
  return {
    requireStrokeOrder: typeof value.requireStrokeOrder === "boolean" ? value.requireStrokeOrder : true,
    strokeTolerance: normalizeStrokeTolerance(value.strokeTolerance),
    showStrokeGuide: typeof value.showStrokeGuide === "boolean" ? value.showStrokeGuide : true,
    practiceCharacterCount: normalizeLettersPracticeCharacterCount(value.practiceCharacterCount),
    characters,
  };
}

export function createLettersProgressStore(): LettersProgressStore {
  return { version: LETTERS_STORAGE_VERSION, collections: {} };
}

export function normalizeLettersProgressStore(value: unknown): LettersProgressStore {
  if (!isRecord(value) || value.version !== LETTERS_STORAGE_VERSION || !isRecord(value.collections)) {
    return createLettersProgressStore();
  }
  const collections: LettersProgressStore["collections"] = {};
  Object.entries(value.collections).forEach(([collectionId, languages]) => {
    if (!collectionId.trim() || !isRecord(languages)) return;
    const normalizedLanguages = Object.fromEntries(
      Object.entries(languages)
        .filter(([language]) => language.trim())
        .map(([language, progress]) => [language, normalizeLanguageProgress(progress)]),
    );
    if (Object.keys(normalizedLanguages).length) collections[collectionId] = normalizedLanguages;
  });
  return { version: LETTERS_STORAGE_VERSION, collections };
}

export function loadLettersProgress(storage?: Pick<Storage, "getItem">): LettersProgressStore {
  if (!storage) return createLettersProgressStore();
  try {
    const value = storage.getItem(LETTERS_STORAGE_KEY);
    return value ? normalizeLettersProgressStore(JSON.parse(value)) : createLettersProgressStore();
  } catch {
    return createLettersProgressStore();
  }
}

export function saveLettersProgress(
  store: LettersProgressStore,
  storage?: Pick<Storage, "setItem">,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LETTERS_STORAGE_KEY, JSON.stringify(normalizeLettersProgressStore(store)));
    return true;
  } catch {
    return false;
  }
}

export function getLettersLanguageProgress(
  store: LettersProgressStore,
  collectionId: string,
  language: string,
): LettersLanguageProgress {
  const progress = store.collections[collectionId]?.[language];
  return progress
    ? {
      requireStrokeOrder: progress.requireStrokeOrder,
      strokeTolerance: progress.strokeTolerance,
      showStrokeGuide: progress.showStrokeGuide,
      practiceCharacterCount: progress.practiceCharacterCount,
      characters: { ...progress.characters },
    }
    : { ...DEFAULT_LANGUAGE_PROGRESS, characters: {} };
}

export function updateLettersLanguageProgress(
  store: LettersProgressStore,
  collectionId: string,
  language: string,
  update: (progress: LettersLanguageProgress) => LettersLanguageProgress,
): LettersProgressStore {
  const current = getLettersLanguageProgress(store, collectionId, language);
  return {
    ...store,
    collections: {
      ...store.collections,
      [collectionId]: {
        ...store.collections[collectionId],
        [language]: update(current),
      },
    },
  };
}

export function scriptsForLanguage(language: string): LettersScriptDefinition[] {
  if (language === "Japanese") return JAPANESE_SCRIPTS;
  if (language === "Chinese") return CHINESE_SCRIPTS;
  if (language === "Korean") return KOREAN_SCRIPTS;
  return [];
}

export function scriptForCharacter(language: string, character: string): LettersScript {
  if (language === "Japanese") {
    if (/\p{Script=Hiragana}/u.test(character)) return "hiragana";
    if (/\p{Script=Katakana}/u.test(character)) return "katakana";
    if (/\p{Script=Han}/u.test(character)) return "kanji";
    return "other";
  }
  if (language === "Chinese") return /\p{Script=Han}/u.test(character) ? "hanzi" : "other";
  if (language === "Korean") {
    return BASIC_HANGUL_JAMO.includes(character as (typeof BASIC_HANGUL_JAMO)[number])
      ? "jamo"
      : "syllables";
  }
  return "other";
}

export function unicodeLabel(character: string): string {
  const codePoint = character.codePointAt(0);
  return codePoint === undefined ? "U+0000" : `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function matchesCharacterQuery(character: string, query: string, searchableMetadata = ""): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const normalizedCodePoint = unicodeLabel(character).toLocaleLowerCase();
  const compactCodePoint = normalizedCodePoint.replace("u+", "");
  return character.toLocaleLowerCase().includes(normalized)
    || normalizedCodePoint.includes(normalized)
    || compactCodePoint.includes(normalized.replace(/^u\+/, ""))
    || searchableMetadata.toLocaleLowerCase().includes(normalized);
}

export function getCharacterWindow({
  characterCount,
  columns,
  scrollTop,
  viewportHeight,
  rowHeight,
  overscanRows,
}: {
  characterCount: number;
  columns: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscanRows: number;
}): CharacterWindow {
  const safeColumns = Math.max(1, Math.floor(columns));
  const safeRowHeight = Math.max(1, rowHeight);
  const rowCount = Math.ceil(Math.max(0, characterCount) / safeColumns);
  const visibleRows = Math.ceil(Math.max(viewportHeight, safeRowHeight) / safeRowHeight);
  const startRow = Math.max(0, Math.floor(Math.max(0, scrollTop) / safeRowHeight) - Math.max(0, overscanRows));
  const endRow = Math.min(rowCount, startRow + visibleRows + Math.max(0, overscanRows) * 2);
  return {
    rowCount,
    startRow,
    endRow,
    startIndex: startRow * safeColumns,
    endIndex: Math.min(characterCount, endRow * safeColumns),
  };
}
