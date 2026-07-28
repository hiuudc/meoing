import {
  DEFAULT_LETTERS_PRACTICE_CHARACTERS,
  MAX_LETTERS_PRACTICE_CHARACTERS,
  lettersPracticeFamilyKey,
  normalizeLettersPracticeCharacterCount,
  unicodeLabel,
  type LetterProgressStatus,
  type LettersScript,
} from "./letters";
import type {
  AudioMatchingQuestion,
  CharacterTracingQuestion,
  ChoiceOption,
  GlossaryEntry,
  MatchingQuestion,
  PlayableLesson,
  PlayableQuestion,
  PlayableQuestionAlternate,
  SingleChoiceQuestion,
  ListenSelectQuestion,
} from "./types";

export interface LettersCharacterMetadata {
  displayLabel?: string;
  reading?: string;
  meaning?: string;
}

export interface LettersPracticeSession {
  lesson: PlayableLesson;
  targetCharacters: string[];
  questionIdsByCharacter: Record<string, string[]>;
}

interface BuildLettersPracticeOptions {
  collectionId: string;
  language: string;
  sourceLanguage: string;
  level: PlayableLesson["level"];
  script: LettersScript;
  scriptLabel: string;
  characters: string[];
  targetCharacters: string[];
  metadata: ReadonlyMap<string, LettersCharacterMetadata>;
  requireStrokeOrder: boolean;
  sessionId?: string;
  createdAt?: string;
}

export interface LettersPracticePlan {
  targetCharacters: string[];
  uniqueReadingCharacters: string[];
  ambiguousReadingCharacters: string[];
  unicodeCharacters: string[];
  questionCount: number;
}

interface LettersPracticeSelectionOptions {
  excludedCharacters?: ReadonlySet<string>;
}

const MATCHING_GROUP_SIZE = 5;
const EMPTY_CHARACTER_SET = new Set<string>();

function characterKey(character: string): string {
  return [...character]
    .map((part) => part.codePointAt(0)?.toString(16) ?? "0")
    .join("-");
}

function progressPriority(status?: LetterProgressStatus): number {
  if (status === "practicing") return 0;
  if (status === undefined) return 1;
  return 2;
}

export function selectLettersPracticeCharacters(
  characters: string[],
  progress: Readonly<Record<string, LetterProgressStatus>>,
  characterCount = DEFAULT_LETTERS_PRACTICE_CHARACTERS,
  options: LettersPracticeSelectionOptions = {},
): string[] {
  const targetCount = Math.min(
    characters.length,
    normalizeLettersPracticeCharacterCount(characterCount),
  );
  const excludedCharacters = options.excludedCharacters ?? EMPTY_CHARACTER_SET;
  const ordered = characters
    .map((character, index) => ({
      character,
      excluded: excludedCharacters.has(character),
      index,
      priority: progressPriority(progress[character]),
    }))
    .sort((left, right) => (
      Number(left.excluded) - Number(right.excluded)
      || left.priority - right.priority
      || left.index - right.index
    ));
  const selected: string[] = [];
  const deferred: string[] = [];
  const selectedFamilies = new Set<string>();

  ordered.forEach(({ character }) => {
    const family = lettersPracticeFamilyKey(character);
    if (selected.length < targetCount && !selectedFamilies.has(family)) {
      selected.push(character);
      selectedFamilies.add(family);
    } else {
      deferred.push(character);
    }
  });

  for (const character of deferred) {
    if (selected.length >= targetCount) break;
    selected.push(character);
  }
  return selected;
}

function normalizedReading(character: string, metadata: ReadonlyMap<string, LettersCharacterMetadata>): string {
  return metadata.get(character)?.reading?.trim() ?? "";
}

function readingKey(reading: string): string {
  return reading.normalize("NFKC").toLocaleLowerCase();
}

function practiceDescriptor(
  character: string,
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): string {
  return normalizedReading(character, metadata) || unicodeLabel(character);
}

export function planLettersPracticeSession(
  targetCharacters: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): LettersPracticePlan {
  const readingCounts = new Map<string, number>();
  targetCharacters.forEach((character) => {
    const reading = normalizedReading(character, metadata);
    if (!reading) return;
    const key = readingKey(reading);
    readingCounts.set(key, (readingCounts.get(key) ?? 0) + 1);
  });

  const uniqueReadingCharacters: string[] = [];
  const ambiguousReadingCharacters: string[] = [];
  const unicodeCharacters: string[] = [];
  targetCharacters.forEach((character) => {
    const reading = normalizedReading(character, metadata);
    if (!reading) {
      unicodeCharacters.push(character);
    } else if (readingCounts.get(readingKey(reading)) === 1) {
      uniqueReadingCharacters.push(character);
    } else {
      ambiguousReadingCharacters.push(character);
    }
  });

  return {
    targetCharacters: [...targetCharacters],
    uniqueReadingCharacters,
    ambiguousReadingCharacters,
    unicodeCharacters,
    questionCount: (
      targetCharacters.length * 2
      + uniqueReadingCharacters.length * 2
      + unicodeCharacters.length
      + Math.ceil(uniqueReadingCharacters.length / MATCHING_GROUP_SIZE)
      + Math.ceil(unicodeCharacters.length / MATCHING_GROUP_SIZE)
    ),
  };
}

export function lettersPracticeExerciseCount(
  targetCharacters: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): number {
  return planLettersPracticeSession(targetCharacters, metadata).questionCount;
}

function practiceChoicePool(characters: string[], targets: string[]): string[] {
  const selected = new Set(targets);
  const usedFamilies = new Set(targets.map(lettersPracticeFamilyKey));
  const pool = [...targets];

  characters.forEach((character) => {
    if (selected.has(character)) return;
    const family = lettersPracticeFamilyKey(character);
    if (usedFamilies.has(family)) return;
    usedFamilies.add(family);
    pool.push(character);
  });
  return pool;
}

function orderedChoiceCharacters(target: string, characters: string[]): string[] {
  const targetIndex = Math.max(0, characters.indexOf(target));
  const ordered = [target];
  for (let offset = 1; ordered.length < characters.length; offset += 1) {
    const candidate = characters[(targetIndex + offset) % characters.length];
    if (!ordered.includes(candidate)) ordered.push(candidate);
  }
  return ordered;
}

function rotateChoiceOptions(options: ChoiceOption[], targetIndex: number): ChoiceOption[] {
  const shift = options.length > 1 ? targetIndex % options.length : 0;
  return [...options.slice(shift), ...options.slice(0, shift)];
}

function glyphChoiceOptions(
  target: string,
  characters: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): ChoiceOption[] {
  const targetIndex = Math.max(0, characters.indexOf(target));
  const targetReading = normalizedReading(target, metadata);
  const targetReadingKey = targetReading ? readingKey(targetReading) : "";
  const options = orderedChoiceCharacters(target, characters)
    .filter((character) => {
      if (character === target || !targetReadingKey) return true;
      const candidateReading = normalizedReading(character, metadata);
      return !candidateReading || readingKey(candidateReading) !== targetReadingKey;
    })
    .slice(0, Math.min(4, characters.length))
    .map((character) => ({
      id: `character-${characterKey(character)}`,
      label: character,
    }));
  return rotateChoiceOptions(options, targetIndex);
}

function descriptorChoiceOptions(
  target: string,
  characters: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): ChoiceOption[] {
  const targetIndex = Math.max(0, characters.indexOf(target));
  const seenDescriptors = new Set<string>();
  const options: ChoiceOption[] = [];

  for (const character of orderedChoiceCharacters(target, characters)) {
    const descriptor = practiceDescriptor(character, metadata);
    const key = readingKey(descriptor);
    if (seenDescriptors.has(key)) continue;
    seenDescriptors.add(key);
    options.push({
      id: `descriptor-${characterKey(character)}`,
      label: descriptor,
    });
    if (options.length >= Math.min(4, characters.length)) break;
  }

  return rotateChoiceOptions(options, targetIndex);
}

function baseQuestion(id: string, type: PlayableQuestion["type"], prompt: string) {
  return {
    id,
    type,
    prompt,
    evaluationMode: "local" as const,
    explanation: "This Letters exercise is checked locally and missed questions return until mastered.",
    hint: "Compare the character shape, sound, and reading before trying again.",
  };
}

function readingChoiceQuestion(
  id: string,
  target: string,
  characters: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): SingleChoiceQuestion {
  const reading = normalizedReading(target, metadata);
  const options = descriptorChoiceOptions(target, characters, metadata);
  return {
    ...baseQuestion(id, "singleChoice", reading ? "Select the correct reading." : "Select the Unicode code."),
    type: "singleChoice",
    targetPrompt: target,
    glossaryTargets: [target],
    options,
    correctOptionId: `descriptor-${characterKey(target)}`,
  };
}

function descriptorChoiceQuestion(
  id: string,
  target: string,
  characters: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): SingleChoiceQuestion {
  const reading = normalizedReading(target, metadata);
  const descriptor = reading || unicodeLabel(target);
  const options = glyphChoiceOptions(target, characters, metadata);
  return {
    ...baseQuestion(
      id,
      "singleChoice",
      reading
        ? `Which character is read "${descriptor}"?`
        : `Which character has code "${descriptor}"?`,
    ),
    type: "singleChoice",
    glossaryTargets: options.map((option) => option.label),
    options,
    correctOptionId: `character-${characterKey(target)}`,
  };
}

function listeningQuestion(
  id: string,
  target: string,
  characters: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): ListenSelectQuestion {
  const options = glyphChoiceOptions(target, characters, metadata);
  return {
    ...baseQuestion(id, "listenSelect", "Listen and select the character you hear."),
    type: "listenSelect",
    audioText: target,
    glossaryTargets: options.map((option) => option.label),
    options,
    correctOptionId: `character-${characterKey(target)}`,
  };
}

function tracingQuestion(
  id: string,
  target: string,
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
  requireStrokeOrder: boolean,
): CharacterTracingQuestion {
  const characterMetadata = metadata.get(target);
  return {
    ...baseQuestion(id, "characterTracing", "Trace the character."),
    type: "characterTracing",
    character: target,
    reading: characterMetadata?.displayLabel ?? characterMetadata?.reading ?? unicodeLabel(target),
    meaning: characterMetadata?.meaning,
    requireStrokeOrder,
    glossaryTargets: [target],
  };
}

function matchingDescriptor(
  character: string,
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
  used: Set<string>,
): string {
  const preferred = practiceDescriptor(character, metadata);
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  const unique = `${preferred} - ${unicodeLabel(character)}`;
  used.add(unique);
  return unique;
}

function audioMatchingQuestions(
  id: string,
  targets: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): { primary: AudioMatchingQuestion; alternate: MatchingQuestion } {
  const usedDescriptors = new Set<string>();
  const primary: AudioMatchingQuestion = {
    ...baseQuestion(id, "audioMatching", "Match each sound to its character."),
    type: "audioMatching",
    glossaryTargets: [...targets],
    pairs: targets.map((character) => ({
      audioId: `audio-${characterKey(character)}`,
      audioText: character,
      matchId: `match-${characterKey(character)}`,
      label: character,
    })),
  };
  const alternate: MatchingQuestion = {
    ...baseQuestion(`${id}-alternate`, "matching", "Match each reading or code to its character."),
    type: "matching",
    glossaryTargets: [...targets],
    pairs: targets.map((character) => ({
      leftId: `descriptor-${characterKey(character)}`,
      left: matchingDescriptor(character, metadata, usedDescriptors),
      rightId: `match-${characterKey(character)}`,
      right: character,
    })),
  };
  return { primary, alternate };
}

function unicodeMatchingQuestion(
  id: string,
  targets: string[],
): MatchingQuestion {
  return {
    ...baseQuestion(id, "matching", "Match each Unicode code to its character."),
    type: "matching",
    glossaryTargets: [...targets],
    pairs: targets.map((character) => ({
      leftId: `descriptor-${characterKey(character)}`,
      left: unicodeLabel(character),
      rightId: `match-${characterKey(character)}`,
      right: character,
    })),
  };
}

function glossaryFor(
  targets: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): GlossaryEntry[] {
  return targets.map((character) => {
    const characterMetadata = metadata.get(character);
    return {
      term: character,
      meaning: characterMetadata?.meaning ?? `${unicodeLabel(character)} character`,
      ...(characterMetadata?.reading
        ? { pronunciation: { romanized: characterMetadata.reading } }
        : {}),
    };
  });
}

export function buildLettersPracticeSession({
  collectionId,
  language,
  sourceLanguage,
  level,
  script,
  scriptLabel,
  characters,
  targetCharacters,
  metadata,
  requireStrokeOrder,
  sessionId = `letters-${Date.now()}`,
  createdAt = new Date().toISOString(),
}: BuildLettersPracticeOptions): LettersPracticeSession {
  const availableCharacters = new Set(characters);
  const targets = [...new Set(targetCharacters)]
    .filter((character) => availableCharacters.has(character))
    .slice(0, MAX_LETTERS_PRACTICE_CHARACTERS);
  if (!targets.length) throw new Error("No characters are available for this Letters practice.");
  const plan = planLettersPracticeSession(targets, metadata);
  const uniqueReadingCharacters = new Set(plan.uniqueReadingCharacters);
  const unicodeCharacters = new Set(plan.unicodeCharacters);
  const choicePool = practiceChoicePool(characters, targets);

  const questions: PlayableQuestion[] = [];
  const questionAlternates: PlayableQuestionAlternate[] = [];
  const questionIdsByCharacter = Object.fromEntries(targets.map((character) => [character, [] as string[]]));
  let questionNumber = 0;

  function register(question: PlayableQuestion, relatedCharacters: string[]) {
    questions.push(question);
    relatedCharacters.forEach((character) => questionIdsByCharacter[character]?.push(question.id));
  }

  targets.forEach((target) => {
    const targetKey = characterKey(target);
    const tracingId = `${sessionId}-q${++questionNumber}-${targetKey}-trace`;
    register(tracingQuestion(tracingId, target, metadata, requireStrokeOrder), [target]);

    if (uniqueReadingCharacters.has(target)) {
      const listeningId = `${sessionId}-q${++questionNumber}-${targetKey}-listen`;
      const listening = listeningQuestion(listeningId, target, choicePool, metadata);
      register(listening, [target]);
      questionAlternates.push({
        questionId: listening.id,
        question: readingChoiceQuestion(`${listeningId}-alternate`, target, choicePool, metadata),
      });
    }

    const visualId = `${sessionId}-q${++questionNumber}-${targetKey}-visual`;
    register(readingChoiceQuestion(visualId, target, choicePool, metadata), [target]);

    if (uniqueReadingCharacters.has(target) || unicodeCharacters.has(target)) {
      const descriptorId = `${sessionId}-q${++questionNumber}-${targetKey}-descriptor`;
      register(descriptorChoiceQuestion(descriptorId, target, choicePool, metadata), [target]);
    }
  });

  for (let index = 0; index < plan.uniqueReadingCharacters.length; index += MATCHING_GROUP_SIZE) {
    const group = plan.uniqueReadingCharacters.slice(index, index + MATCHING_GROUP_SIZE);
    const matchingId = `${sessionId}-q${++questionNumber}-audio-matching-${Math.floor(index / MATCHING_GROUP_SIZE) + 1}`;
    const matching = audioMatchingQuestions(matchingId, group, metadata);
    register(matching.primary, group);
    questionAlternates.push({ questionId: matching.primary.id, question: matching.alternate });
  }

  for (let index = 0; index < plan.unicodeCharacters.length; index += MATCHING_GROUP_SIZE) {
    const group = plan.unicodeCharacters.slice(index, index + MATCHING_GROUP_SIZE);
    const matchingId = `${sessionId}-q${++questionNumber}-unicode-matching-${Math.floor(index / MATCHING_GROUP_SIZE) + 1}`;
    register(unicodeMatchingQuestion(matchingId, group), group);
  }

  const includesListening = plan.uniqueReadingCharacters.length > 0;
  const activitySummary = includesListening
    ? "tracing, recognition, listening, and matching"
    : "tracing, Unicode recognition, and matching";

  return {
    targetCharacters: targets,
    questionIdsByCharacter,
    lesson: {
      schemaVersion: 7,
      id: sessionId,
      unitId: `letters:${collectionId}:${script}`,
      title: `${scriptLabel} practice`,
      summary: `${questions.length} local exercises for ${targets.length} characters across ${activitySummary}.`,
      targetLanguage: language,
      sourceLanguage,
      level,
      objectives: [`Recognize and write the selected ${scriptLabel} characters.`],
      theory: [{
        id: `${sessionId}-guide`,
        kind: "pronunciation",
        title: `${scriptLabel} focus`,
        body: includesListening
          ? "Listen, compare the character forms, and follow the highlighted stroke direction. Missed exercises return until correct."
          : "Compare each character with its Unicode code and follow the highlighted stroke direction. Missed exercises return until correct.",
      }],
      examples: targets.map((character) => ({
        id: `${sessionId}-example-${characterKey(character)}`,
        source: character,
        translation: metadata.get(character)?.displayLabel
          ?? metadata.get(character)?.reading
          ?? metadata.get(character)?.meaning,
      })),
      glossary: glossaryFor(targets, metadata),
      sourceReferences: [],
      questions,
      questionAlternates,
      createdAt,
    },
  };
}
