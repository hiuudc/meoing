const LANGUAGE_TAGS: Record<string, string> = {
  arabic: "ar-SA",
  chinese: "zh-CN",
  english: "en-US",
  french: "fr-FR",
  german: "de-DE",
  italian: "it-IT",
  japanese: "ja-JP",
  korean: "ko-KR",
  portuguese: "pt-BR",
  spanish: "es-ES",
  thai: "th-TH",
  vietnamese: "vi-VN",
};

export const SPEECH_PREFERENCE_KEY = "meoi.speech.v1";
export const SPEECH_PREFERENCE_VERSION = 1;

export interface BrowserSpeechPreference {
  version: 1;
  voiceURI: string;
  rate: number;
}

export const DEFAULT_SPEECH_PREFERENCE: BrowserSpeechPreference = {
  version: SPEECH_PREFERENCE_VERSION,
  voiceURI: "",
  rate: 1,
};

export function languageTagForSpeech(language: string): string {
  const normalized = language.trim().toLocaleLowerCase();
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/i.test(normalized)) return language;
  return LANGUAGE_TAGS[normalized] ?? "en-US";
}

export function normalizeSpeechPreference(value: unknown): BrowserSpeechPreference {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawRate = typeof source.rate === "number" && Number.isFinite(source.rate)
    ? source.rate
    : DEFAULT_SPEECH_PREFERENCE.rate;
  return {
    version: SPEECH_PREFERENCE_VERSION,
    voiceURI: typeof source.voiceURI === "string" ? source.voiceURI.slice(0, 500) : "",
    rate: Math.min(2, Math.max(0.5, rawRate)),
  };
}

export function loadSpeechPreference(storage?: Pick<Storage, "getItem">): BrowserSpeechPreference {
  if (!storage) return { ...DEFAULT_SPEECH_PREFERENCE };
  try {
    const saved = storage.getItem(SPEECH_PREFERENCE_KEY);
    if (!saved) return { ...DEFAULT_SPEECH_PREFERENCE };
    const parsed = JSON.parse(saved) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== SPEECH_PREFERENCE_VERSION) {
      return { ...DEFAULT_SPEECH_PREFERENCE };
    }
    return normalizeSpeechPreference(parsed);
  } catch {
    return { ...DEFAULT_SPEECH_PREFERENCE };
  }
}

export function saveSpeechPreference(
  preference: BrowserSpeechPreference,
  storage?: Pick<Storage, "setItem">,
): void {
  storage?.setItem(SPEECH_PREFERENCE_KEY, JSON.stringify(normalizeSpeechPreference(preference)));
}

export function resolveSpeechVoice(
  voices: SpeechSynthesisVoice[],
  preference: BrowserSpeechPreference,
  language: string,
): SpeechSynthesisVoice | undefined {
  const preferred = voices.find((voice) => voice.voiceURI === preference.voiceURI);
  if (preferred) return preferred;
  const tag = languageTagForSpeech(language).toLocaleLowerCase();
  const languagePrefix = tag.split("-")[0];
  return voices.find((voice) => voice.lang.toLocaleLowerCase() === tag)
    ?? voices.find((voice) => voice.lang.toLocaleLowerCase().startsWith(`${languagePrefix}-`))
    ?? voices.find((voice) => voice.default)
    ?? voices[0];
}
