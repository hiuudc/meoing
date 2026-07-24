export const SUPPORTED_LANGUAGES = [
  { name: "English", locale: "en-US", browserCodes: ["en"] },
  { name: "Vietnamese", locale: "vi-VN", browserCodes: ["vi"] },
  { name: "Japanese", locale: "ja-JP", browserCodes: ["ja"] },
  { name: "Spanish", locale: "es-ES", browserCodes: ["es"] },
  { name: "Chinese", locale: "zh-CN", browserCodes: ["zh"] },
  { name: "Korean", locale: "ko-KR", browserCodes: ["ko"] },
  { name: "French", locale: "fr-FR", browserCodes: ["fr"] },
  { name: "German", locale: "de-DE", browserCodes: ["de"] },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["name"];

export const SUPPORTED_LANGUAGE_NAMES = SUPPORTED_LANGUAGES.map((language) => language.name);

const languageByName = new Map(
  SUPPORTED_LANGUAGES.map((language) => [language.name.toLocaleLowerCase(), language] as const),
);

const languageByBrowserCode = new Map<string, (typeof SUPPORTED_LANGUAGES)[number]>(
  SUPPORTED_LANGUAGES.flatMap((language) => (
    language.browserCodes.map((code) => [code, language] as const)
  )),
);

export function getSupportedLanguage(value: unknown) {
  if (typeof value !== "string") return undefined;
  return languageByName.get(value.trim().toLocaleLowerCase());
}

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return Boolean(getSupportedLanguage(value));
}

export function detectBrowserLanguage(locales?: readonly string[]): SupportedLanguage {
  const candidates = locales ?? (
    typeof navigator === "undefined"
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language]
  );
  for (const locale of candidates) {
    const code = locale.trim().toLocaleLowerCase().replace(/_/g, "-").split("-")[0];
    const match = languageByBrowserCode.get(code);
    if (match) return match.name;
  }
  return "English";
}

export function normalizeSourceLanguage(value: unknown): SupportedLanguage {
  return getSupportedLanguage(value)?.name ?? detectBrowserLanguage();
}

export function canonicalLanguageName(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return getSupportedLanguage(value)?.name ?? value.trim().slice(0, 100);
}

export function languageLocale(language: string): string | undefined {
  return getSupportedLanguage(language)?.locale;
}
