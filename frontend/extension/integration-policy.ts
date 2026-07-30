declare const __MEOI_ALLOWED_ORIGINS__: string[] | undefined;

export const LOCAL_MEOI_ORIGINS = new Set<string>([
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4173",
]);

const buildOrigins = typeof __MEOI_ALLOWED_ORIGINS__ === "undefined"
  ? [...LOCAL_MEOI_ORIGINS]
  : __MEOI_ALLOWED_ORIGINS__;

export const ALLOWED_MEOI_ORIGINS = new Set(buildOrigins);

export function isAllowedMeoiOrigin(origin: string): boolean {
  return ALLOWED_MEOI_ORIGINS.has(origin);
}
