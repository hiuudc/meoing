export interface MultiClozeTemplateParts {
  markerIds: string[];
  segments: string[];
  legacy: boolean;
}

const EXPLICIT_MARKER = /\{\{blank:([^{}]+)\}\}/g;
const LEGACY_MARKER = /_{2,}/g;

function splitTemplate(
  template: string,
  pattern: RegExp,
  markerId: (match: RegExpExecArray, index: number) => string,
): MultiClozeTemplateParts {
  const markerIds: string[] = [];
  const segments: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(template))) {
    segments.push(template.slice(cursor, match.index));
    markerIds.push(markerId(match, markerIds.length));
    cursor = match.index + match[0].length;
  }
  segments.push(template.slice(cursor));
  return { markerIds, segments, legacy: pattern === LEGACY_MARKER };
}

export function parseMultiClozeTemplate(
  template: string,
  blankIds: string[],
  allowLegacy = true,
): MultiClozeTemplateParts | null {
  const explicit = splitTemplate(template, EXPLICIT_MARKER, (match) => match[1]);
  if (explicit.markerIds.length) return explicit;
  if (!allowLegacy) return null;
  const legacy = splitTemplate(template, LEGACY_MARKER, (_match, index) => blankIds[index] ?? "");
  return legacy.markerIds.length === blankIds.length && legacy.markerIds.every(Boolean)
    ? legacy
    : null;
}

export function validateMultiClozeMarkers(template: string, blankIds: string[]): string[] {
  const parsed = parseMultiClozeTemplate(template, blankIds, false);
  if (!parsed) return ["Multi-blank templates need explicit {{blank:<id>}} markers."];
  const expected = new Set(blankIds);
  const seen = new Set<string>();
  const errors: string[] = [];
  if (expected.size !== blankIds.length) errors.push("Multi-blank IDs must be unique.");
  parsed.markerIds.forEach((markerId) => {
    if (!expected.has(markerId)) errors.push(`Unknown multi-blank marker ${markerId}.`);
    if (seen.has(markerId)) errors.push(`Multi-blank marker ${markerId} appears more than once.`);
    seen.add(markerId);
  });
  blankIds.forEach((blankId) => {
    if (!seen.has(blankId)) errors.push(`Multi-blank marker ${blankId} is missing.`);
  });
  return errors;
}

export function stripBlankMarkers(text: string): string {
  return text
    .replace(/\{\{blank(?::[^{}]+)?\}\}/g, " ")
    .replace(/_{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
