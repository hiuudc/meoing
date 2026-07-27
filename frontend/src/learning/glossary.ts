import type { GlossaryEntry } from "./types";

export interface GlossaryTextSegment {
  text: string;
  entry?: GlossaryEntry;
}

export interface GlossarySegmentationOptions {
  mode?: "longest" | "lexical-cjk";
}

interface GlossaryCandidate {
  entry: GlossaryEntry;
  term: string;
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

function glossaryCandidates(glossary: GlossaryEntry[]): GlossaryCandidate[] {
  const seenTerms = new Set<string>();
  return glossary
    .flatMap((entry) => [entry.term, ...(entry.forms ?? []), ...(entry.aliases ?? [])]
      .map((term) => ({ entry, term: term.trim() })))
    .filter(({ term }) => {
      const normalized = term.toLocaleLowerCase();
      if (!normalized || seenTerms.has(normalized)) return false;
      seenTerms.add(normalized);
      return true;
    })
    .sort((left, right) => right.term.length - left.term.length);
}

function segmentWithCandidates(text: string, entries: GlossaryCandidate[]): GlossaryTextSegment[] {
  const segments: GlossaryTextSegment[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const match = entries.find((candidate) => {
      const slice = text.slice(index, index + candidate.term.length);
      return slice.toLocaleLowerCase() === candidate.term.toLocaleLowerCase()
        && hasValidBoundaries(text, index, candidate.term);
    });
    if (!match) {
      index += 1;
      continue;
    }
    if (plainStart < index) segments.push({ text: text.slice(plainStart, index) });
    segments.push({ text: text.slice(index, index + match.term.length), entry: match.entry });
    index += match.term.length;
    plainStart = index;
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart) });
  return segments.length ? segments : [{ text }];
}

function hasCompleteLexicalCoverage(segments: GlossaryTextSegment[]): boolean {
  const lexicalMatches = segments.filter((segment) => segment.entry);
  return lexicalMatches.length >= 2 && segments.every((segment) => (
    Boolean(segment.entry) || !/[\p{L}\p{N}\p{M}]/u.test(segment.text)
  ));
}

export function segmentGlossaryText(
  text: string,
  glossary: GlossaryEntry[],
  options: GlossarySegmentationOptions = {},
): GlossaryTextSegment[] {
  if (!text || !glossary.length) return text ? [{ text }] : [];

  const entries = glossaryCandidates(glossary);
  if (options.mode === "lexical-cjk") {
    const normalizedText = text.trim().toLocaleLowerCase();
    const normalizedWithoutTerminalPunctuation = normalizedText.replace(/[.!?。！？…]+$/u, "");
    const wholeSentenceEntries = new Set(
      glossary.filter((entry) => [entry.term, ...(entry.forms ?? []), ...(entry.aliases ?? [])]
        .some((candidate) => {
          const normalizedCandidate = candidate.trim().toLocaleLowerCase();
          return normalizedCandidate === normalizedText
            || normalizedCandidate === normalizedWithoutTerminalPunctuation;
        })),
    );
    const componentEntries = glossaryCandidates(
      glossary.filter((entry) => !wholeSentenceEntries.has(entry)),
    );
    const lexicalSegments = segmentWithCandidates(text, componentEntries);
    if (hasCompleteLexicalCoverage(lexicalSegments)) return lexicalSegments;
  }
  return segmentWithCandidates(text, entries);
}
