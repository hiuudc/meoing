import { BASIC_HANGUL_JAMO } from "./strokeData";

export const LETTERS_STORAGE_KEY = "meoi.letters.v1";
export const LETTERS_STORAGE_VERSION = 1;
export const MIN_STROKE_TOLERANCE = 0.5;
export const MAX_STROKE_TOLERANCE = 2;
export const DEFAULT_STROKE_TOLERANCE = 1;

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
  characters: Record<string, LetterProgressStatus>;
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
