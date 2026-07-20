import type { GlossaryEntry } from "./types";

export interface GlossaryTextSegment {
  text: string;
  entry?: GlossaryEntry;
}

function isWordCharacter(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}\p{M}]/u.test(value));
}

function hasValidBoundaries(text: string, index: number, term: string): boolean {
  const usesWhitespaceBoundaries = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{N}\p{M}\s'’-]+$/u.test(term);
  if (!usesWhitespaceBoundaries) return true;
  const before = text[index - 1];
  const first = term[0];
  const last = term[term.length - 1];
  const after = text[index + term.length];
  if (isWordCharacter(before) && isWordCharacter(first)) return false;
  if (isWordCharacter(last) && isWordCharacter(after)) return false;
  return true;
}

export function segmentGlossaryText(text: string, glossary: GlossaryEntry[]): GlossaryTextSegment[] {
  if (!text || !glossary.length) return text ? [{ text }] : [];

  const seenTerms = new Set<string>();
  const entries = glossary
    .filter((entry) => {
      const normalized = entry.term.trim().toLocaleLowerCase();
      if (!normalized || seenTerms.has(normalized)) return false;
      seenTerms.add(normalized);
      return true;
    })
    .sort((left, right) => right.term.length - left.term.length);

  const segments: GlossaryTextSegment[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const entry = entries.find((candidate) => {
      const slice = text.slice(index, index + candidate.term.length);
      return slice.toLocaleLowerCase() === candidate.term.toLocaleLowerCase()
        && hasValidBoundaries(text, index, candidate.term);
    });
    if (!entry) {
      index += 1;
      continue;
    }
    if (plainStart < index) segments.push({ text: text.slice(plainStart, index) });
    segments.push({ text: text.slice(index, index + entry.term.length), entry });
    index += entry.term.length;
    plainStart = index;
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart) });
  return segments.length ? segments : [{ text }];
}
