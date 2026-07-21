import type { QuestionPresentationSettings } from "./types";

export const LESSON_PLAYER_PREFERENCE_KEY = "meoi.lessonPlayerPreferences.v1";
export const LESSON_PLAYER_PREFERENCE_VERSION = 1;
export const LISTENING_PAUSE_DURATION_MS = 15 * 60 * 1_000;

export interface LessonPlayerPreference {
  version: 1;
  readQuestion?: boolean;
  readAnswers?: boolean;
  wordTooltips?: boolean;
  showPronunciation: boolean;
  pronunciationMode: "romanized" | "native";
  listeningDisabledUntil: number;
}

export const DEFAULT_LESSON_PLAYER_PREFERENCE: LessonPlayerPreference = {
  version: LESSON_PLAYER_PREFERENCE_VERSION,
  showPronunciation: true,
  pronunciationMode: "romanized",
  listeningDisabledUntil: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  };
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
