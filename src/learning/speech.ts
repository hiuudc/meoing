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

export function languageTagForSpeech(language: string): string {
  const normalized = language.trim().toLocaleLowerCase();
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/i.test(normalized)) return language;
  return LANGUAGE_TAGS[normalized] ?? "en-US";
}
