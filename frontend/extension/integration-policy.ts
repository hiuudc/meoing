export const LOCAL_MEOI_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4173",
]);

export function isAllowedMeoiOrigin(origin: string): boolean {
  return LOCAL_MEOI_ORIGINS.has(origin);
}
