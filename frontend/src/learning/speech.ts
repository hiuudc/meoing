import { languageLocale } from "./languages";

const LANGUAGE_TAGS: Record<string, string> = {
  arabic: "ar-SA",
  cantonese: "yue-HK",
  chinese: "zh-CN",
  dutch: "nl-NL",
  english: "en-US",
  french: "fr-FR",
  german: "de-DE",
  hindi: "hi-IN",
  indonesian: "id-ID",
  italian: "it-IT",
  japanese: "ja-JP",
  korean: "ko-KR",
  polish: "pl-PL",
  portuguese: "pt-BR",
  russian: "ru-RU",
  spanish: "es-ES",
  swedish: "sv-SE",
  thai: "th-TH",
  turkish: "tr-TR",
  vietnamese: "vi-VN",
};

const VOICE_PREVIEW_SAMPLES: Record<string, string> = {
  ar: "\u0645\u0631\u062d\u0628\u0627",
  de: "Guten Tag",
  en: "Hello",
  es: "Hola",
  fr: "Bonjour",
  hi: "\u0928\u092e\u0938\u094d\u0924\u0947",
  id: "Halo",
  it: "Buongiorno",
  ja: "\u3053\u3093\u306b\u3061\u306f",
  ko: "\uc548\ub155\ud558\uc138\uc694",
  nl: "Hallo",
  pl: "Dzie\u0144 dobry",
  pt: "Ol\u00e1",
  ru: "\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435",
  sv: "Hej",
  th: "\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35",
  tr: "Merhaba",
  vi: "Xin ch\u00e0o",
  yue: "\u4f60\u597d",
  zh: "\u4f60\u597d",
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
  return languageLocale(language) ?? LANGUAGE_TAGS[normalized] ?? "en-US";
}

function configuredLanguageTag(language: string): string | undefined {
  const normalized = language.trim().toLocaleLowerCase();
  if (/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})+$/i.test(normalized)) {
    return normalized.replace(/_/g, "-");
  }
  return (languageLocale(language) ?? LANGUAGE_TAGS[normalized])?.toLocaleLowerCase();
}

function normalizedVoiceTag(voice: SpeechSynthesisVoice): string {
  return voice.lang.trim().toLocaleLowerCase().replace(/_/g, "-");
}

export function filterSpeechVoices(
  voices: SpeechSynthesisVoice[],
  language: string,
): SpeechSynthesisVoice[] {
  const tag = configuredLanguageTag(language);
  if (!tag) return [];
  const languagePrefix = tag.split("-")[0];
  return voices
    .filter((voice) => normalizedVoiceTag(voice).split("-")[0] === languagePrefix)
    .sort((left, right) => {
      const leftTag = normalizedVoiceTag(left);
      const rightTag = normalizedVoiceTag(right);
      const leftRank = leftTag === tag ? 0 : left.default ? 1 : 2;
      const rightRank = rightTag === tag ? 0 : right.default ? 1 : 2;
      return leftRank - rightRank || left.name.localeCompare(right.name);
    });
}

export function voicePreviewSample(language: string): string {
  const tag = configuredLanguageTag(language);
  return tag ? VOICE_PREVIEW_SAMPLES[tag.split("-")[0]] ?? "" : "";
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
    rate: Math.min(2, Math.max(0.25, rawRate)),
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
  const matchingVoices = filterSpeechVoices(voices, language);
  const preferred = matchingVoices.find((voice) => voice.voiceURI === preference.voiceURI);
  if (preferred) return preferred;
  const tag = languageTagForSpeech(language).toLocaleLowerCase();
  return matchingVoices.find((voice) => normalizedVoiceTag(voice) === tag)
    ?? matchingVoices.find((voice) => voice.default)
    ?? matchingVoices[0];
}
