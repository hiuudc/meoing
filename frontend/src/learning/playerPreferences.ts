import type { QuestionPresentationSettings } from "./types";

export const LESSON_PLAYER_PREFERENCE_KEY = "meoi.lessonPlayerPreferences.v1";
export const LESSON_PLAYER_PREFERENCE_VERSION = 1;
export const LISTENING_PAUSE_DURATION_MS = 15 * 60 * 1_000;
export const DEFAULT_TYPEAHEAD_TIMEOUT_MS = 1_500;
export const MIN_TYPEAHEAD_TIMEOUT_MS = 1_000;
export const MAX_TYPEAHEAD_TIMEOUT_MS = 10_000;
export const TYPEAHEAD_TIMEOUT_STEP_MS = 250;

export interface LessonShortcut {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface LessonPlayerPreference {
  version: 1;
  readQuestion?: boolean;
  readAnswers?: boolean;
  wordTooltips?: boolean;
  showPronunciation: boolean;
  pronunciationMode: "romanized" | "native";
  listeningDisabledUntil: number;
  skipShortcut: LessonShortcut;
  typeaheadTimeoutMs: number;
}

export const DEFAULT_SKIP_SHORTCUT: LessonShortcut = {
  key: "s",
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

export const DEFAULT_LESSON_PLAYER_PREFERENCE: LessonPlayerPreference = {
  version: LESSON_PLAYER_PREFERENCE_VERSION,
  showPronunciation: true,
  pronunciationMode: "romanized",
  listeningDisabledUntil: 0,
  skipShortcut: DEFAULT_SKIP_SHORTCUT,
  typeaheadTimeoutMs: DEFAULT_TYPEAHEAD_TIMEOUT_MS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeTypeaheadTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TYPEAHEAD_TIMEOUT_MS;
  const rounded = Math.round(value / TYPEAHEAD_TIMEOUT_STEP_MS) * TYPEAHEAD_TIMEOUT_STEP_MS;
  return Math.min(MAX_TYPEAHEAD_TIMEOUT_MS, Math.max(MIN_TYPEAHEAD_TIMEOUT_MS, rounded));
}

export function normalizeLessonPlayerPreference(value: unknown, now = Date.now()): LessonPlayerPreference {
  const source = isRecord(value) ? value : {};
  const rawListeningUntil = typeof source.listeningDisabledUntil === "number" && Number.isFinite(source.listeningDisabledUntil)
    ? source.listeningDisabledUntil
    : 0;
  const listeningDisabledUntil = rawListeningUntil > now
    ? Math.min(rawListeningUntil, now + LISTENING_PAUSE_DURATION_MS)
    : 0;
  return {
    version: LESSON_PLAYER_PREFERENCE_VERSION,
    ...(typeof source.readQuestion === "boolean" ? { readQuestion: source.readQuestion } : {}),
    ...(typeof source.readAnswers === "boolean" ? { readAnswers: source.readAnswers } : {}),
    ...(typeof source.wordTooltips === "boolean" ? { wordTooltips: source.wordTooltips } : {}),
    showPronunciation: typeof source.showPronunciation === "boolean"
      ? source.showPronunciation
      : DEFAULT_LESSON_PLAYER_PREFERENCE.showPronunciation,
    pronunciationMode: source.pronunciationMode === "native" ? "native" : "romanized",
    listeningDisabledUntil,
    skipShortcut: normalizeLessonShortcut(source.skipShortcut),
    typeaheadTimeoutMs: normalizeTypeaheadTimeoutMs(source.typeaheadTimeoutMs),
  };
}

export function isForbiddenLessonShortcut(shortcut: LessonShortcut): boolean {
  const key = shortcut.key.toLocaleLowerCase();
  if (["enter", "escape", "tab", "backspace"].includes(key)) return true;
  if (shortcut.ctrlKey || shortcut.metaKey) return true;
  if (/^f(?:[1-9]|1[0-2])$/i.test(key)) return true;
  if (shortcut.altKey && ["arrowleft", "arrowright", "home"].includes(key)) return true;
  return !key || ["shift", "alt", "control", "meta"].includes(key);
}

export function normalizeLessonShortcut(value: unknown): LessonShortcut {
  if (!isRecord(value) || typeof value.key !== "string") return { ...DEFAULT_SKIP_SHORTCUT };
  const shortcut: LessonShortcut = {
    key: value.key.length === 1 ? value.key.toLocaleLowerCase() : value.key.toLocaleLowerCase(),
    altKey: value.altKey === true,
    ctrlKey: value.ctrlKey === true,
    metaKey: value.metaKey === true,
    shiftKey: value.shiftKey === true,
  };
  return isForbiddenLessonShortcut(shortcut) ? { ...DEFAULT_SKIP_SHORTCUT } : shortcut;
}

export function lessonShortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): LessonShortcut {
  return {
    key: event.key.length === 1 ? event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase(),
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

export function lessonShortcutMatches(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  shortcut: LessonShortcut,
): boolean {
  const candidate = lessonShortcutFromKeyboardEvent(event);
  return candidate.key === shortcut.key
    && candidate.altKey === shortcut.altKey
    && candidate.ctrlKey === shortcut.ctrlKey
    && candidate.metaKey === shortcut.metaKey
    && candidate.shiftKey === shortcut.shiftKey;
}

export function lessonShortcutLabel(shortcut: LessonShortcut): string {
  return [
    shortcut.ctrlKey ? "Ctrl" : "",
    shortcut.altKey ? "Alt" : "",
    shortcut.shiftKey ? "Shift" : "",
    shortcut.metaKey ? "Meta" : "",
    shortcut.key.length === 1 ? shortcut.key.toLocaleUpperCase() : shortcut.key,
  ].filter(Boolean).join("+");
}

export function loadLessonPlayerPreference(
  storage?: Pick<Storage, "getItem">,
  now = Date.now(),
): LessonPlayerPreference {
  if (!storage) return { ...DEFAULT_LESSON_PLAYER_PREFERENCE };
  try {
    const saved = storage.getItem(LESSON_PLAYER_PREFERENCE_KEY);
    if (!saved) return { ...DEFAULT_LESSON_PLAYER_PREFERENCE };
    const parsed = JSON.parse(saved) as unknown;
    if (!isRecord(parsed) || parsed.version !== LESSON_PLAYER_PREFERENCE_VERSION) {
      return { ...DEFAULT_LESSON_PLAYER_PREFERENCE };
    }
    return normalizeLessonPlayerPreference(parsed, now);
  } catch {
    return { ...DEFAULT_LESSON_PLAYER_PREFERENCE };
  }
}

export function saveLessonPlayerPreference(
  preference: LessonPlayerPreference,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    storage?.setItem(LESSON_PLAYER_PREFERENCE_KEY, JSON.stringify(normalizeLessonPlayerPreference(preference)));
  } catch {
    // Browser storage can be unavailable; the in-memory preference still applies.
  }
}

export function pauseListening(preference: LessonPlayerPreference, now = Date.now()): LessonPlayerPreference {
  return { ...preference, listeningDisabledUntil: now + LISTENING_PAUSE_DURATION_MS };
}

export function enableListening(preference: LessonPlayerPreference): LessonPlayerPreference {
  return { ...preference, listeningDisabledUntil: 0 };
}

export function resetPresentationOverrides(preference: LessonPlayerPreference): LessonPlayerPreference {
  const { readQuestion: _readQuestion, readAnswers: _readAnswers, wordTooltips: _wordTooltips, ...rest } = preference;
  return rest;
}

export function resetLessonPlayerPreference(preference: LessonPlayerPreference): LessonPlayerPreference {
  return {
    ...DEFAULT_LESSON_PLAYER_PREFERENCE,
    listeningDisabledUntil: preference.listeningDisabledUntil,
  };
}

export function effectivePresentation(
  defaults: QuestionPresentationSettings,
  preference: LessonPlayerPreference,
): QuestionPresentationSettings {
  return {
    readQuestion: preference.readQuestion ?? defaults.readQuestion,
    readAnswers: preference.readAnswers ?? defaults.readAnswers,
    wordTooltips: preference.wordTooltips ?? defaults.wordTooltips,
  };
}
