import {
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Menu,
  Play,
  RotateCcw,
  Search,
  Volume2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";
import { createPortal } from "react-dom";
import { loadLocalLearningCache } from "../integration/learningStorage";
import { CharacterTracingResponse } from "../learning/CharacterTracingResponse";
import { LessonPlayer } from "../learning/LessonPlayer";
import {
  DEFAULT_LETTERS_PRACTICE_QUESTIONS,
  getLettersLanguageProgress,
  getCharacterWindow,
  INTERNAL_CHARACTER_READINGS,
  MAX_LETTERS_PRACTICE_QUESTIONS,
  MAX_STROKE_TOLERANCE,
  MIN_LETTERS_PRACTICE_QUESTIONS,
  MIN_STROKE_TOLERANCE,
  loadLettersProgress,
  matchesCharacterQuery,
  normalizeLettersPracticeQuestionCount,
  saveLettersProgress,
  scriptForCharacter,
  scriptsForLanguage,
  unicodeLabel,
  updateLettersLanguageProgress,
  type LetterProgressStatus,
  type LettersProgressStore,
  type LettersScript,
} from "../learning/letters";
import {
  buildLettersPracticeSession,
  selectLettersPracticeCharacters,
  type LettersCharacterMetadata,
  type LettersPracticeSession,
} from "../learning/lettersPractice";
import { normalizeLearningProfile } from "../learning/profile";
import { languageTagForSpeech } from "../learning/speech";
import { loadStrokeCatalog } from "../learning/strokeData";
import type {
  AttemptRecord,
  CharacterTracingQuestion,
  GlossaryEntry,
  LessonProgressSnapshot,
  QuestionAnswer,
} from "../learning/types";
import type { Collection, StudyItem, Unit } from "../types";
import { AnimatedModal } from "./AnimatedModal";
import { WorkspaceModeSwitch, type WorkspaceMode } from "./WorkspaceModeSwitch";

interface LettersWorkspaceProps {
  collection: Collection;
  units: Unit[];
  studyItems: StudyItem[];
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  onOpenMobileNavigation: () => void;
}

interface VirtualCharacterGridProps {
  characters: string[];
  metadata: ReadonlyMap<string, LettersCharacterMetadata>;
  progress: Readonly<Record<string, LetterProgressStatus>>;
  onSelect: (character: string) => void;
}

interface LettersPracticeProps {
  characters: string[];
  character: string;
  language: string;
  metadata?: LettersCharacterMetadata;
  requireStrokeOrder: boolean;
  showStrokeGuide: boolean;
  strokeTolerance: number;
  onClose: () => void;
  onSelect: (character: string) => void;
  onStart: (character: string) => void;
  onMastered: (character: string) => void;
  onShowStrokeGuideChange: (value: boolean) => void;
  onStrokeToleranceChange: (value: number) => void;
}

interface LettersLessonIntroProps {
  open: boolean;
  language: string;
  scriptLabel: string;
  characters: string[];
  metadata: ReadonlyMap<string, LettersCharacterMetadata>;
  questionCount: number;
  onQuestionCountChange: (value: number) => void;
  onClose: () => void;
  onExited: () => void;
  onStart: () => void;
}

const GRID_ROW_HEIGHT = 100;
const GRID_MIN_COLUMN_WIDTH = 88;
const GRID_OVERSCAN_ROWS = 3;

function singleCharacter(value: string): boolean {
  return [...value].length === 1;
}

function glossaryMetadata(entry: GlossaryEntry): LettersCharacterMetadata {
  return {
    reading: entry.pronunciation?.romanized ?? entry.pronunciation?.native,
    meaning: entry.meaning,
  };
}

function collectionCharacterMetadata(
  unitIds: ReadonlySet<string>,
  studyItems: StudyItem[],
): Map<string, LettersCharacterMetadata> {
  const metadata = new Map<string, LettersCharacterMetadata>();
  studyItems.forEach((item) => {
    if (!unitIds.has(item.unitId) || !singleCharacter(item.text.trim())) return;
    metadata.set(item.text.trim(), { meaning: item.translation.trim() || undefined });
  });
  const cache = loadLocalLearningCache(window.localStorage);
  unitIds.forEach((unitId) => {
    (cache.lessonsByUnit[unitId] ?? []).forEach(({ lesson }) => {
      lesson.glossary.forEach((entry) => {
        if (!singleCharacter(entry.term)) return;
        metadata.set(entry.term, { ...metadata.get(entry.term), ...glossaryMetadata(entry) });
      });
    });
  });
  INTERNAL_CHARACTER_READINGS.forEach((reading, character) => {
    metadata.set(character, { ...metadata.get(character), reading });
  });
  return metadata;
}

function VirtualCharacterGrid({
  characters,
  metadata,
  progress,
  onSelect,
}: VirtualCharacterGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0, scrollTop: 0 });

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewport((current) => ({
      ...current,
      width: element.clientWidth,
      height: element.clientHeight,
    }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const scrollTop = event.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      setViewport((current) => ({ ...current, scrollTop }));
    });
  }

  const columns = Math.max(1, Math.floor(Math.max(viewport.width, GRID_MIN_COLUMN_WIDTH) / GRID_MIN_COLUMN_WIDTH));
  const characterWindow = getCharacterWindow({
    characterCount: characters.length,
    columns,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
    rowHeight: GRID_ROW_HEIGHT,
    overscanRows: GRID_OVERSCAN_ROWS,
  });
  const visibleCharacters = characters.slice(characterWindow.startIndex, characterWindow.endIndex);

  return (
    <div className="letters-grid-viewport" ref={viewportRef} onScroll={onScroll}>
      <div className="letters-grid-spacer" style={{ height: characterWindow.rowCount * GRID_ROW_HEIGHT }}>
        <div
          className="letters-grid-window"
          role="grid"
          aria-rowcount={characterWindow.rowCount}
          aria-colcount={columns}
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            transform: `translateY(${characterWindow.startRow * GRID_ROW_HEIGHT}px)`,
          }}
        >
          {visibleCharacters.map((character, index) => {
            const characterMetadata = metadata.get(character);
            const status = progress[character];
            return (
              <button
                type="button"
                className={`letters-character-tile${status ? ` is-${status}` : ""}`}
                key={character}
                role="gridcell"
                aria-rowindex={characterWindow.startRow + Math.floor(index / columns) + 1}
                aria-colindex={(index % columns) + 1}
                aria-label={`${character}, ${characterMetadata?.reading ?? unicodeLabel(character)}, ${status ?? "not started"}`}
                onClick={() => onSelect(character)}
              >
                <strong>{character}</strong>
                <span>{characterMetadata?.reading ?? unicodeLabel(character)}</span>
                <i aria-hidden="true"><b /></i>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function speakCharacter(language: string, character: string) {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(character);
  utterance.lang = languageTagForSpeech(language);
  utterance.rate = .82;
  window.speechSynthesis.speak(utterance);
}

function LettersLessonIntro({
  open,
  language,
  scriptLabel,
  characters,
  metadata,
  questionCount,
  onQuestionCountChange,
  onClose,
  onExited,
  onStart,
}: LettersLessonIntroProps) {
  return createPortal(
    <AnimatedModal
      open={open}
      onClose={onClose}
      onExited={onExited}
      labelledBy="letters-lesson-intro-title"
      backdropClassName="letters-lesson-intro-backdrop"
      panelClassName="letters-lesson-intro"
    >
      <header>
        <div>
          <p className="section-kicker">{language} letters</p>
          <h1 id="letters-lesson-intro-title">Let&apos;s learn {scriptLabel}</h1>
        </div>
        <button type="button" aria-label="Close Letters lesson" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <main>
        <div className="letters-lesson-intro-copy">
          <h2>Practice sound, recognition, and stroke order</h2>
          <p>
            There are no hearts. A missed exercise returns later in the session until you answer it correctly.
          </p>
        </div>
        <div className="letters-lesson-character-list" aria-label="Characters in this practice">
          {characters.map((character) => {
            const characterMetadata = metadata.get(character);
            return (
              <article key={character}>
                <strong lang={languageTagForSpeech(language)}>{character}</strong>
                <div>
                  <b>{characterMetadata?.reading ?? unicodeLabel(character)}</b>
                  {characterMetadata?.meaning ? <span>{characterMetadata.meaning}</span> : null}
                </div>
                <button
                  type="button"
                  aria-label={`Play ${character}`}
                  onClick={() => speakCharacter(language, character)}
                >
                  <Volume2 size={17} />
                </button>
              </article>
            );
          })}
        </div>
        <label className="letters-session-length">
          <span>
            <strong>Practice length</strong>
            <small>Custom session size, saved for this Collection and language.</small>
          </span>
          <input
            type="number"
            min={MIN_LETTERS_PRACTICE_QUESTIONS}
            max={MAX_LETTERS_PRACTICE_QUESTIONS}
            step={1}
            value={questionCount}
            onChange={(event) => onQuestionCountChange(
              normalizeLettersPracticeQuestionCount(event.currentTarget.valueAsNumber),
            )}
            aria-label="Number of practice questions"
          />
          <output>{questionCount} questions</output>
        </label>
      </main>
      <footer>
        <button className="secondary-button" type="button" onClick={onClose}>Not now</button>
        <button className="primary-button" type="button" onClick={onStart} disabled={!characters.length}>
          Start lesson <ChevronRight size={16} />
        </button>
      </footer>
    </AnimatedModal>,
    document.querySelector<HTMLElement>(".app-shell") ?? document.body,
  );
}

function LettersPractice({
  characters,
  character,
  language,
  metadata,
  requireStrokeOrder,
  showStrokeGuide,
  strokeTolerance,
  onClose,
  onSelect,
  onStart,
  onMastered,
  onShowStrokeGuideChange,
  onStrokeToleranceChange,
}: LettersPracticeProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeHandlerRef = useRef(onClose);
  const startHandlerRef = useRef(onStart);
  const masteredHandlerRef = useRef(onMastered);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [answer, setAnswer] = useState<QuestionAnswer>("");
  const [runId, setRunId] = useState(0);
  const currentIndex = characters.indexOf(character);

  useEffect(() => {
    closeHandlerRef.current = onClose;
    startHandlerRef.current = onStart;
    masteredHandlerRef.current = onMastered;
  });

  const handleStart = useCallback(() => {
    startHandlerRef.current(character);
  }, [character]);

  const handleAnswerChange = useCallback((next: QuestionAnswer) => {
    setAnswer(next);
    if (next === "passed") masteredHandlerRef.current(character);
  }, [character]);

  useEffect(() => {
    setAnswer("");
    setRunId((current) => current + 1);
  }, [character, requireStrokeOrder]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHandlerRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, []);

  const question: CharacterTracingQuestion = {
    id: `letters-${language}-${unicodeLabel(character)}`,
    type: "characterTracing",
    evaluationMode: "local",
    prompt: "Trace the character",
    explanation: "This practice is checked locally from the bundled stroke data.",
    character,
    meaning: metadata?.meaning,
    reading: metadata?.reading,
    requireStrokeOrder,
  };
  const completed = answer === "passed";

  function changeStrokeTolerance(value: number) {
    setAnswer("");
    setRunId((current) => current + 1);
    onStrokeToleranceChange(value);
  }

  return createPortal(
    <div className="letters-practice-backdrop">
      <section ref={dialogRef} className="letters-practice-dialog" role="dialog" aria-modal="true" aria-labelledby="letters-practice-title">
        <header>
          <button ref={closeRef} type="button" aria-label="Close character practice" onClick={onClose}><X size={21} /></button>
          <div>
            <p>{language} letters</p>
            <h1 id="letters-practice-title">Trace the character</h1>
          </div>
          <strong>{currentIndex + 1}/{characters.length}</strong>
        </header>
        <main>
          <CharacterTracingResponse
            key={`${character}-${runId}`}
            question={question}
            language={language}
            answer={answer}
            onStart={handleStart}
            onChange={handleAnswerChange}
            strokeTolerance={strokeTolerance}
            showStrokeGuide={showStrokeGuide}
          />
          {requireStrokeOrder ? (
            <div className="letters-tolerance-control">
              <span>
                <label htmlFor="letters-stroke-tolerance"><strong>Stroke tolerance</strong></label>
                <output>{strokeTolerance.toFixed(1)}x</output>
              </span>
              <input
                id="letters-stroke-tolerance"
                type="range"
                min={MIN_STROKE_TOLERANCE}
                max={MAX_STROKE_TOLERANCE}
                step={0.1}
                value={strokeTolerance}
                onChange={(event) => changeStrokeTolerance(Number(event.target.value))}
              />
              <div className="letters-tolerance-presets" aria-label="Stroke tolerance presets">
                {([
                  ["Strict", MIN_STROKE_TOLERANCE],
                  ["Standard", 1],
                  ["Forgiving", MAX_STROKE_TOLERANCE],
                ] as const).map(([label, value]) => (
                  <button
                    type="button"
                    key={label}
                    aria-pressed={strokeTolerance === value}
                    onClick={() => changeStrokeTolerance(value)}
                  >
                    <span>{label}</span>
                    <small>{value.toFixed(1)}x</small>
                  </button>
                ))}
              </div>
              <label className="letters-practice-guide-toggle">
                <input
                  type="checkbox"
                  checked={showStrokeGuide}
                  onChange={(event) => onShowStrokeGuideChange(event.target.checked)}
                />
                Show drag direction guide
              </label>
            </div>
          ) : null}
        </main>
        <footer>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onSelect(characters[Math.max(0, currentIndex - 1)])}
            disabled={currentIndex <= 0}
          >
            <ChevronLeft size={16} /> Previous
          </button>
          <button className="secondary-button" type="button" onClick={() => {
            setAnswer("");
            setRunId((current) => current + 1);
          }}>
            <RotateCcw size={15} /> Retry
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              if (currentIndex >= characters.length - 1) onClose();
              else onSelect(characters[currentIndex + 1]);
            }}
            disabled={!completed}
          >
            {currentIndex >= characters.length - 1 ? "Done" : "Next"} <ChevronRight size={16} />
          </button>
        </footer>
      </section>
    </div>,
    document.querySelector<HTMLElement>(".app-shell") ?? document.body,
  );
}

export function LettersWorkspace({
  collection,
  units,
  studyItems,
  mode,
  onModeChange,
  onOpenMobileNavigation,
}: LettersWorkspaceProps) {
  const profile = normalizeLearningProfile(collection.learningProfile);
  const language = profile.targetLanguage;
  const scriptDefinitions = scriptsForLanguage(language);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [catalogError, setCatalogError] = useState("");
  const [activeScript, setActiveScript] = useState<LettersScript>(() => scriptDefinitions[0]?.id ?? "other");
  const [query, setQuery] = useState("");
  const [selectedCharacter, setSelectedCharacter] = useState("");
  const [practiceIntroOpen, setPracticeIntroOpen] = useState(false);
  const [pendingPracticeSession, setPendingPracticeSession] = useState<LettersPracticeSession | null>(null);
  const [practiceSession, setPracticeSession] = useState<LettersPracticeSession | null>(null);
  const [progressStore, setProgressStore] = useState<LettersProgressStore>(() => loadLettersProgress(window.localStorage));
  const unitIds = useMemo(() => new Set(units.map((unit) => unit.id)), [units]);
  const metadata = useMemo(
    () => collectionCharacterMetadata(unitIds, studyItems),
    [collection.id, studyItems, unitIds],
  );
  const languageProgress = useMemo(
    () => getLettersLanguageProgress(progressStore, collection.id, language),
    [collection.id, language, progressStore],
  );

  useEffect(() => {
    setActiveScript(scriptDefinitions[0]?.id ?? "other");
    setQuery("");
    setSelectedCharacter("");
    setPracticeIntroOpen(false);
    setPendingPracticeSession(null);
    setPracticeSession(null);
  }, [language]);

  useEffect(() => {
    let active = true;
    if (!scriptDefinitions.length) {
      setCatalog([]);
      setCatalogStatus("idle");
      return;
    }
    setCatalogStatus("loading");
    setCatalogError("");
    loadStrokeCatalog(language)
      .then((characters) => {
        if (!active) return;
        setCatalog(characters);
        setCatalogStatus("ready");
      })
      .catch((error) => {
        if (!active) return;
        setCatalog([]);
        setCatalogError(error instanceof Error ? error.message : "The local stroke catalog could not be loaded.");
        setCatalogStatus("error");
      });
    return () => {
      active = false;
    };
  }, [language, scriptDefinitions.length]);

  useEffect(() => {
    saveLettersProgress(progressStore, window.localStorage);
  }, [progressStore]);

  const scriptCharacters = useMemo(
    () => catalog.filter((character) => scriptForCharacter(language, character) === activeScript),
    [activeScript, catalog, language],
  );
  const visibleCharacters = useMemo(
    () => scriptCharacters.filter((character) => {
      const characterMetadata = metadata.get(character);
      return matchesCharacterQuery(
        character,
        query,
        `${characterMetadata?.reading ?? ""} ${characterMetadata?.meaning ?? ""}`,
      );
    }),
    [metadata, query, scriptCharacters],
  );
  const masteredCount = scriptCharacters.filter(
    (character) => languageProgress.characters[character] === "mastered",
  ).length;
  const selectedMetadata = metadata.get(selectedCharacter);
  const activeScriptLabel = scriptDefinitions.find((script) => script.id === activeScript)?.label ?? "characters";
  const practiceCharacters = useMemo(
    () => selectLettersPracticeCharacters(
      scriptCharacters,
      languageProgress.characters,
      languageProgress.practiceQuestionCount ?? DEFAULT_LETTERS_PRACTICE_QUESTIONS,
    ),
    [
      languageProgress.characters,
      languageProgress.practiceQuestionCount,
      scriptCharacters,
    ],
  );

  function updateProgress(
    update: (progress: ReturnType<typeof getLettersLanguageProgress>) => ReturnType<typeof getLettersLanguageProgress>,
  ) {
    setProgressStore((current) => updateLettersLanguageProgress(current, collection.id, language, update));
  }

  function markCharacter(character: string, status: LetterProgressStatus) {
    updateProgress((current) => {
      if (current.characters[character] === "mastered" && status === "practicing") return current;
      return { ...current, characters: { ...current.characters, [character]: status } };
    });
  }

  function preparePracticeSession() {
    const next = buildLettersPracticeSession({
      collectionId: collection.id,
      language,
      sourceLanguage: profile.sourceLanguage,
      level: profile.level,
      script: activeScript,
      scriptLabel: activeScriptLabel,
      characters: scriptCharacters,
      metadata,
      progress: languageProgress.characters,
      requireStrokeOrder: languageProgress.requireStrokeOrder,
      questionCount: languageProgress.practiceQuestionCount,
    });
    updateProgress((current) => ({
      ...current,
      characters: Object.fromEntries([
        ...Object.entries(current.characters),
        ...next.targetCharacters.map((character) => [
          character,
          current.characters[character] === "mastered" ? "mastered" : "practicing",
        ] as const),
      ]),
    }));
    setPendingPracticeSession(next);
    setPracticeIntroOpen(false);
  }

  function savePracticeProgress(
    _attempts: AttemptRecord[],
    snapshot: LessonProgressSnapshot,
  ) {
    if (!practiceSession) return;
    const completedQuestionIds = new Set(snapshot.completedQuestionIds);
    updateProgress((current) => {
      const characters = { ...current.characters };
      practiceSession.targetCharacters.forEach((character) => {
        const questionIds = practiceSession.questionIdsByCharacter[character] ?? [];
        if (questionIds.length && questionIds.every((questionId) => completedQuestionIds.has(questionId))) {
          characters[character] = "mastered";
        } else if (characters[character] !== "mastered") {
          characters[character] = "practicing";
        }
      });
      return { ...current, characters };
    });
  }

  return (
    <>
      <main className="workspace-main letters-workspace">
        <header className="main-topbar letters-topbar">
          <button className="mobile-nav-trigger" type="button" onClick={onOpenMobileNavigation} aria-label="Open navigation"><Menu size={19} /></button>
          <WorkspaceModeSwitch mode={mode} onChange={onModeChange} />
          <span>{language}</span>
        </header>
        <div className="content-scroll letters-scroll">
          <section className="letters-hero">
            <div>
              <p className="section-kicker">Local character studio</p>
              <h1>{scriptDefinitions.length ? `Learn ${language} characters` : "Letters are not available"}</h1>
              <p>
                {scriptDefinitions.length
                  ? "Browse the complete bundled stroke catalog and practise without a remote dictionary or runtime CDN."
                  : `${language} does not use the Chinese, Japanese, or Korean tracing catalog.`}
              </p>
            </div>
            {scriptDefinitions.length ? (
              <button
                className="primary-button"
                type="button"
                onClick={() => setPracticeIntroOpen(true)}
                disabled={!scriptCharacters.length}
              >
                <Play size={16} /> Learn the characters
              </button>
            ) : null}
          </section>

          {scriptDefinitions.length ? (
            <>
              <section className="letters-controls" aria-label="Character catalog controls">
                <div className="letters-script-tabs" role="tablist" aria-label={`${language} scripts`}>
                  {scriptDefinitions.map((script) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeScript === script.id}
                      className={activeScript === script.id ? "is-active" : ""}
                      key={script.id}
                      onClick={() => {
                        setActiveScript(script.id);
                        setQuery("");
                      }}
                    >
                      {script.label}
                    </button>
                  ))}
                </div>
                <label className="letters-search">
                  <Search size={16} />
                  <span className="sr-only">Search characters</span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search character, reading, meaning, or U+ code"
                  />
                </label>
                <div className="letters-option-toggles">
                  <label className="letters-stroke-order-toggle">
                    <input
                      type="checkbox"
                      checked={languageProgress.requireStrokeOrder}
                      onChange={(event) => updateProgress((current) => ({
                        ...current,
                        requireStrokeOrder: event.target.checked,
                      }))}
                    />
                    Require stroke order
                  </label>
                  <label className="letters-stroke-order-toggle">
                    <input
                      type="checkbox"
                      checked={languageProgress.showStrokeGuide}
                      onChange={(event) => updateProgress((current) => ({
                        ...current,
                        showStrokeGuide: event.target.checked,
                      }))}
                    />
                    Show drag direction
                  </label>
                </div>
              </section>

              <section className="letters-catalog" aria-labelledby="letters-catalog-title">
                <div className="letters-catalog-heading">
                  <div>
                    <p className="section-kicker">{scriptDefinitions.find((script) => script.id === activeScript)?.label}</p>
                    <h2 id="letters-catalog-title">{masteredCount}/{scriptCharacters.length} mastered</h2>
                  </div>
                  <span>{visibleCharacters.length.toLocaleString()} shown</span>
                </div>
                {catalogStatus === "loading" ? (
                  <p className="letters-catalog-status"><LoaderCircle className="spin" size={18} /> Loading local character index...</p>
                ) : null}
                {catalogStatus === "error" ? <p className="letters-catalog-status is-error" role="alert">{catalogError}</p> : null}
                {catalogStatus === "ready" && visibleCharacters.length ? (
                  <VirtualCharacterGrid
                    characters={visibleCharacters}
                    metadata={metadata}
                    progress={languageProgress.characters}
                    onSelect={setSelectedCharacter}
                  />
                ) : null}
                {catalogStatus === "ready" && !visibleCharacters.length ? (
                  <p className="letters-catalog-status">No character matches this filter.</p>
                ) : null}
              </section>
            </>
          ) : (
            <section className="learning-empty-state">
              <span>ABC</span>
              <h2>No tracing catalog for {language}</h2>
              <p>Learn remains available for this Collection. Letters currently supports Chinese, Japanese, and Korean.</p>
            </section>
          )}
        </div>
      </main>

      <aside className="overview-panel letters-control-panel" aria-label="Letters progress">
        <section>
          <div className="overview-title-row"><h2>Letters progress</h2><Check size={17} /></div>
          <p className="control-copy">Progress is stored only in this browser and is isolated by Collection and learning language.</p>
        </section>
        {scriptDefinitions.length ? (
          <section className="control-section">
            <h3>{scriptDefinitions.find((script) => script.id === activeScript)?.label}</h3>
            <div className="letters-progress-summary">
              <strong>{masteredCount}</strong>
              <span>of {scriptCharacters.length.toLocaleString()} mastered</span>
            </div>
            <button
              className="secondary-button wide-button"
              type="button"
              onClick={() => {
                if (!window.confirm(`Reset ${activeScript} progress for this Collection?`)) return;
                const scriptSet = new Set(scriptCharacters);
                updateProgress((current) => ({
                  ...current,
                  characters: Object.fromEntries(
                    Object.entries(current.characters).filter(([character]) => !scriptSet.has(character)),
                  ),
                }));
              }}
              disabled={!scriptCharacters.some((character) => languageProgress.characters[character])}
            >
              <RotateCcw size={15} /> Reset this script
            </button>
          </section>
        ) : null}
        <section className="control-section">
          <h3>Local data</h3>
          <p className="quota-note">Stroke geometry is lazy-loaded from same-origin build assets. Unknown readings remain unknown instead of being inferred.</p>
        </section>
      </aside>

      {selectedCharacter ? (
        <LettersPractice
          characters={visibleCharacters.length ? visibleCharacters : scriptCharacters}
          character={selectedCharacter}
          language={language}
          metadata={selectedMetadata}
          requireStrokeOrder={languageProgress.requireStrokeOrder}
          showStrokeGuide={languageProgress.showStrokeGuide}
          strokeTolerance={languageProgress.strokeTolerance}
          onClose={() => setSelectedCharacter("")}
          onSelect={setSelectedCharacter}
          onStart={(character) => markCharacter(character, "practicing")}
          onMastered={(character) => markCharacter(character, "mastered")}
          onShowStrokeGuideChange={(showStrokeGuide) => updateProgress((current) => ({
            ...current,
            showStrokeGuide,
          }))}
          onStrokeToleranceChange={(strokeTolerance) => updateProgress((current) => ({
            ...current,
            strokeTolerance,
          }))}
        />
      ) : null}

      <LettersLessonIntro
        open={practiceIntroOpen}
        language={language}
        scriptLabel={activeScriptLabel}
        characters={practiceCharacters}
        metadata={metadata}
        questionCount={languageProgress.practiceQuestionCount}
        onQuestionCountChange={(practiceQuestionCount) => updateProgress((current) => ({
          ...current,
          practiceQuestionCount,
        }))}
        onClose={() => setPracticeIntroOpen(false)}
        onExited={() => {
          if (!pendingPracticeSession) return;
          setPracticeSession(pendingPracticeSession);
          setPendingPracticeSession(null);
        }}
        onStart={preparePracticeSession}
      />

      {practiceSession ? (
        <LessonPlayer
          lesson={practiceSession.lesson}
          coachingAvailable={false}
          tracingOptions={{
            strokeTolerance: languageProgress.strokeTolerance,
            showStrokeGuide: languageProgress.showStrokeGuide,
          }}
          returnLabel="Return to Letters"
          onProgressBatch={savePracticeProgress}
          onExit={() => setPracticeSession(null)}
        />
      ) : null}
    </>
  );
}
