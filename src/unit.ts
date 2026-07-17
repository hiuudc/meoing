const LEGACY_UNIT_PREFIX = /^Unit\s+\d+\s*(?:\u00c2\u00b7|\u00b7)\s*/i;

export function cleanUnitName(name: string): string {
  return name.replace(LEGACY_UNIT_PREFIX, "");
}
