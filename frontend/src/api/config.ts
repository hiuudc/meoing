export interface PublicAppConfig {
  apiUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  turnstileSiteKey?: string;
}

let cachedConfig: PublicAppConfig | undefined;

function requiredEnvironmentValue(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name]?.trim();
  if (!value) throw new Error(`Missing required frontend environment variable: ${name}`);
  return value;
}

function normalizeBaseUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
}

export function getPublicAppConfig(): PublicAppConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = {
    apiUrl: normalizeBaseUrl(requiredEnvironmentValue("VITE_MEOI_API_URL"), "VITE_MEOI_API_URL"),
    supabaseUrl: normalizeBaseUrl(requiredEnvironmentValue("VITE_SUPABASE_URL"), "VITE_SUPABASE_URL"),
    supabasePublishableKey: requiredEnvironmentValue("VITE_SUPABASE_PUBLISHABLE_KEY"),
    turnstileSiteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() || undefined,
  };
  return cachedConfig;
}
