import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Lightbulb,
  LoaderCircle,
  MessageCircle,
  HeadphoneOff,
  RotateCcw,
  Send,
  Settings2,
  SkipForward,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { gradeAnswer, isAnswerEmpty } from "./grader";
import { GlossaryText } from "./GlossaryText";
import { shouldFlushProgress } from "./progress";
import { answerActivationSpeechText, answerSpeechText, questionSpeechText } from "./questionContent";
import {
  effectivePresentation,
  enableListening,
  loadLessonPlayerPreference,
  pauseListening,
  resetLessonPlayerPreference,
  saveLessonPlayerPreference,
  type LessonPlayerPreference,
} from "./playerPreferences";
import { getQuestionFormatDefinition } from "./questionRegistry";
import { defaultPresentationForFormat } from "./questionSettings";
import { applyAttempt, createRetryState, masteryPercent, skipQuestion, useListeningAlternate, type RetryState } from "./retry";
import {
  filterSpeechVoices,
  languageTagForSpeech,
  loadSpeechPreference,
  resolveSpeechVoice,
  saveSpeechPreference,
  type BrowserSpeechPreference,
  voicePreviewSample,
} from "./speech";
import type {
  AttemptRecord,
  Evaluation,
  Lesson,
  LessonProgressSnapshot,
  LessonQuestion,
  QuestionAnswer,
  SpeakingSubmission,
} from "./types";
import { QuestionRenderer } from "./QuestionRenderer";
import "./lesson.css";

export interface CoachChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface LessonPlayerProps {
  lesson: Lesson;
  coachingAvailable: boolean;
  onEvaluate?: (question: LessonQuestion, answer: QuestionAnswer, speaking?: SpeakingSubmission | null) => Promise<Evaluation>;
  onProgressBatch?: (attempts: AttemptRecord[], snapshot: LessonProgressSnapshot) => void | Promise<void>;
  onAskCoach?: (
    question: LessonQuestion,
    evaluation: Evaluation,
    message: string,
    history: CoachChatMessage[],
  ) => Promise<string>;
  onExit: () => void;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function initialAnswer(question: LessonQuestion): QuestionAnswer {
  if (["multipleChoice", "wordBank", "reorderTokens", "reorderDialogue"].includes(question.type)) return [];
  if (["multiCloze", "matching", "categorize"].includes(question.type)) return {};
  return "";
}

function buildSnapshot(lesson: Lesson, state: RetryState): LessonProgressSnapshot {
  return {
    lessonId: lesson.id,
    completedQuestionIds: [...state.completed],
    attemptsByQuestion: { ...state.attemptsByQuestion },
    firstTryCorrect: state.firstTryCorrect,
    totalQuestions: lesson.questions.length,
    masteryPercent: masteryPercent(state, lesson.questions.length),
    updatedAt: new Date().toISOString(),
  };
}

function statusLabel(status: Evaluation["status"]): string {
  if (status === "correct") return "Correct";
  if (status === "partial") return "Partly correct";
  return "Not correct yet";
}

function listeningCountdown(until: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((until - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

function glossaryEntryMatchesTargets(entry: Lesson["glossary"][number], targets: string[]): boolean {
  const forms = [entry.term, ...(entry.forms ?? []), ...(entry.aliases ?? [])]
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean);
  return targets.some((target) => {
    const normalizedTarget = target.toLocaleLowerCase();
    return forms.some((form) => normalizedTarget.includes(form));
  });
}

export function LessonPlayer({
  lesson,
  coachingAvailable,
  onEvaluate,
  onProgressBatch,
  onAskCoach,
  onExit,
}: LessonPlayerProps) {
  const questionMap = useMemo(() => new Map(lesson.questions.map((question) => [question.id, question])), [lesson.questions]);
  const alternateMap = useMemo(
    () => new Map((lesson.questionAlternates ?? []).map((alternate) => [alternate.questionId, alternate.question])),
    [lesson.questionAlternates],
  );
  const [retryState, setRetryState] = useState(() => createRetryState(lesson.questions.map((question) => question.id)));
  const currentSlotId = retryState.queue[0];
  const currentPrimaryQuestion = questionMap.get(currentSlotId);
  const currentQuestion = retryState.alternateQuestionIds.includes(currentSlotId)
    ? alternateMap.get(currentSlotId) ?? currentPrimaryQuestion
    : currentPrimaryQuestion;
  const [answer, setAnswer] = useState<QuestionAnswer>(() => currentQuestion ? initialAnswer(currentQuestion) : "");
  const [speaking, setSpeaking] = useState<SpeakingSubmission | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [theoryOpen, setTheoryOpen] = useState(false);
  const [speechOpen, setSpeechOpen] = useState(false);
  const [speechPosition, setSpeechPosition] = useState({ top: 0, left: 0 });
  const [speechPreference, setSpeechPreference] = useState<BrowserSpeechPreference>(() => loadSpeechPreference(window.localStorage));
  const [playerPreference, setPlayerPreference] = useState<LessonPlayerPreference>(() => loadLessonPlayerPreference(window.localStorage));
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [chatByQuestion, setChatByQuestion] = useState<Record<string, CoachChatMessage[]>>({});
  const [coachDraft, setCoachDraft] = useState("");
  const [coachError, setCoachError] = useState("");
  const [coachSending, setCoachSending] = useState(false);
  const [exiting, setExiting] = useState(false);
  const pendingAttemptsRef = useRef<AttemptRecord[]>([]);
  const retryStateRef = useRef(retryState);
  const progressHandlerRef = useRef(onProgressBatch);
  const lessonRef = useRef(lesson);
  const playerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const speechButtonRef = useRef<HTMLButtonElement>(null);
  const speechPopoverRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const autoSpokenQuestionRef = useRef<string | null>(null);

  function questionForState(state: RetryState): LessonQuestion | undefined {
    const slotId = state.queue[0];
    const primary = questionMap.get(slotId);
    return state.alternateQuestionIds.includes(slotId) ? alternateMap.get(slotId) ?? primary : primary;
  }

  function showRetryState(next: RetryState) {
    setRetryState(next);
    retryStateRef.current = next;
    const nextQuestion = questionForState(next);
    setAnswer(nextQuestion ? initialAnswer(nextQuestion) : "");
    setSpeaking(null);
    setEvaluation(null);
    setError("");
    setCoachDraft("");
    setCoachError("");
  }

  useEffect(() => {
    retryStateRef.current = retryState;
  }, [retryState]);

  useEffect(() => {
    progressHandlerRef.current = onProgressBatch;
  }, [onProgressBatch]);

  useEffect(() => {
    lessonRef.current = lesson;
    const next = createRetryState(lesson.questions.map((question) => question.id));
    setRetryState(next);
    retryStateRef.current = next;
    const first = lesson.questions[0];
    setAnswer(first ? initialAnswer(first) : "");
    setSpeaking(null);
    setEvaluation(null);
    setError("");
    setTheoryOpen(false);
    setSpeechOpen(false);
    setChatByQuestion({});
    setCoachDraft("");
    setCoachError("");
    setNotice("");
    pendingAttemptsRef.current = [];
  }, [lesson]);

  useEffect(() => {
    function flushWhenHidden() {
      if (document.visibilityState !== "hidden" || !pendingAttemptsRef.current.length) return;
      const pending = [...pendingAttemptsRef.current];
      pendingAttemptsRef.current = [];
      void progressHandlerRef.current?.(pending, buildSnapshot(lessonRef.current, retryStateRef.current));
    }
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      if (!pendingAttemptsRef.current.length) return;
      const pending = [...pendingAttemptsRef.current];
      pendingAttemptsRef.current = [];
      void progressHandlerRef.current?.(pending, buildSnapshot(lessonRef.current, retryStateRef.current));
    };
  }, []);

  useEffect(() => {
    const fullscreen = playerRef.current;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!fullscreen || !shell) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const background = Array.from(shell.children).filter((element) => element !== fullscreen) as HTMLElement[];
    const previousState = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    background.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousState.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const updateVoices = () => setVoices(window.speechSynthesis.getVoices());
    updateVoices();
    window.speechSynthesis.addEventListener("voiceschanged", updateVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", updateVoices);
  }, []);

  useEffect(() => {
    saveSpeechPreference(speechPreference, window.localStorage);
  }, [speechPreference]);

  useEffect(() => {
    saveLessonPlayerPreference(playerPreference, window.localStorage);
  }, [playerPreference]);

  useEffect(() => {
    setNow(Date.now());
    if (playerPreference.listeningDisabledUntil <= Date.now()) return;
    const interval = window.setInterval(() => {
      const nextNow = Date.now();
      setNow(nextNow);
      if (playerPreference.listeningDisabledUntil <= nextNow) {
        setPlayerPreference((current) => enableListening(current));
      }
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [playerPreference.listeningDisabledUntil]);

  useEffect(() => {
    if (
      !currentSlotId
      || currentPrimaryQuestion?.type !== "dictation"
      || playerPreference.listeningDisabledUntil <= Date.now()
      || retryState.alternateQuestionIds.includes(currentSlotId)
      || !alternateMap.has(currentSlotId)
    ) return;
    const next = useListeningAlternate(retryState, currentSlotId, true);
    showRetryState(next);
    setNotice("Listening is paused. This exercise will return in a non-listening format.");
  }, [alternateMap, currentPrimaryQuestion?.type, currentSlotId, playerPreference.listeningDisabledUntil, retryState]);

  useEffect(() => {
    window.speechSynthesis?.cancel();
    setCoachDraft("");
    setCoachError("");
    return () => window.speechSynthesis?.cancel();
  }, [currentQuestion?.id]);

  useEffect(() => {
    if (!speechOpen) return;
    const anchor = speechButtonRef.current;
    if (!anchor) return;
    const speechAnchor = anchor;
    const position = () => {
      const rect = speechAnchor.getBoundingClientRect();
      const width = Math.min(430, window.innerWidth - 16);
      const height = speechPopoverRef.current?.offsetHeight ?? 560;
      setSpeechPosition({
        top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8)),
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      });
    };
    const frame = window.requestAnimationFrame(() => {
      position();
      speechPopoverRef.current?.querySelector<HTMLElement>("select, input, button")?.focus();
    });
    function closeOnOutsidePointer(event: PointerEvent) {
      if (speechAnchor.contains(event.target as Node) || speechPopoverRef.current?.contains(event.target as Node)) return;
      setSpeechOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("resize", position);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("resize", position);
    };
  }, [speechOpen]);

  async function flushPendingProgress() {
    if (!pendingAttemptsRef.current.length) return;
    const pending = [...pendingAttemptsRef.current];
    pendingAttemptsRef.current = [];
    await progressHandlerRef.current?.(pending, buildSnapshot(lessonRef.current, retryStateRef.current));
  }

  async function requestExit() {
    if (exiting) return;
    setExiting(true);
    window.speechSynthesis?.cancel();
    try {
      await flushPendingProgress();
      onExit();
    } finally {
      setExiting(false);
    }
  }

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (speechOpen) {
        setSpeechOpen(false);
        speechButtonRef.current?.focus();
      } else if (theoryOpen) {
        setTheoryOpen(false);
      } else {
        void requestExit();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
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

  function speak(text: string) {
    if (!("speechSynthesis" in window) || !text.trim()) return;
    const voice = resolveSpeechVoice(voices, speechPreference, lesson.targetLanguage);
    if (!voice) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = speechPreference.rate;
    utterance.voice = voice;
    utterance.lang = voice.lang || languageTagForSpeech(lesson.targetLanguage);
    window.speechSynthesis.speak(utterance);
  }

  async function submitAnswer() {
    if (!currentQuestion || evaluation || submitting) return;
    if (isAnswerEmpty(answer) && !(speaking?.audio || speaking?.transcript)) {
      setError("Enter or select an answer before checking it.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const local = gradeAnswer(currentQuestion, answer);
      if (!local.requiresAi) {
        setEvaluation(local);
      } else if (!onEvaluate) {
        setError("This question needs ChatGPT evaluation and is unavailable in local-only mode.");
      } else {
        setEvaluation(await onEvaluate(currentQuestion, answer, speaking));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The answer could not be evaluated right now.");
    } finally {
      setSubmitting(false);
    }
  }

  function continueLesson() {
    if (!currentQuestion || !currentSlotId || !evaluation) return;
    window.speechSynthesis?.cancel();
    const attemptNumber = (retryState.attemptsByQuestion[currentSlotId] ?? 0) + 1;
    const nextState = applyAttempt(retryState, currentSlotId, evaluation.status);
    const record: AttemptRecord = {
      questionId: currentSlotId,
      attemptNumber,
      status: evaluation.status,
      score: evaluation.score,
      firstTry: attemptNumber === 1,
      answeredAt: new Date().toISOString(),
    };
    const pending = [...pendingAttemptsRef.current, record];
    pendingAttemptsRef.current = pending;
    const lessonComplete = nextState.queue.length === 0;
    if (shouldFlushProgress({ pending, lessonComplete, pageHidden: document.visibilityState === "hidden" })) {
      pendingAttemptsRef.current = [];
      void onProgressBatch?.(pending, buildSnapshot(lesson, nextState));
    }
    showRetryState(nextState);
    setNotice("");
  }

  function skipCurrentQuestion() {
    if (!currentQuestion || !currentSlotId || submitting || evaluation) return;
    window.speechSynthesis?.cancel();
    const wasAlternate = retryState.alternateQuestionIds.includes(currentSlotId);
    const next = skipQuestion(retryState, currentSlotId, alternateMap.has(currentSlotId));
    const activatedAlternate = !wasAlternate && next.alternateQuestionIds.includes(currentSlotId);
    const skipCount = next.skipsByQuestion[currentSlotId] ?? 0;
    showRetryState(next);
    setNotice(activatedAlternate
      ? `Skipped ${skipCount} times. This exercise will return as ${getQuestionFormatDefinition(alternateMap.get(currentSlotId)!.type).label}.`
      : `Exercise moved to the end of the queue · skip ${skipCount}.`);
  }

  function pauseListeningExercises() {
    if (!currentSlotId || currentQuestion?.type !== "dictation" || !alternateMap.has(currentSlotId)) return;
    const nextPreference = pauseListening(playerPreference);
    setPlayerPreference(nextPreference);
    setNow(Date.now());
    const next = useListeningAlternate(retryState, currentSlotId, true);
    showRetryState(next);
    setNotice("Listening exercises are paused for 15 minutes and will use non-listening alternatives.");
  }

  async function restartLesson() {
    await flushPendingProgress();
    const next = createRetryState(lesson.questions.map((question) => question.id));
    showRetryState(next);
    setChatByQuestion({});
    setNotice("");
    pendingAttemptsRef.current = [];
  }

  async function sendCoachMessage(event?: React.FormEvent) {
    event?.preventDefault();
    if (!currentQuestion || !evaluation || !onAskCoach || !coachingAvailable || coachSending) return;
    const message = coachDraft.trim();
    if (!message) return;
    const chatKey = currentSlotId ?? currentQuestion.id;
    const history = (chatByQuestion[chatKey] ?? []).slice(-8);
    setCoachSending(true);
    setCoachError("");
    try {
      const reply = (await onAskCoach(currentQuestion, evaluation, message, history)).trim();
      if (!reply) throw new Error("ChatGPT returned an empty coaching reply.");
      setChatByQuestion((current) => ({
        ...current,
        [chatKey]: [
          ...(current[chatKey] ?? []),
          { role: "user", content: message },
          { role: "assistant", content: reply },
        ].slice(-10) as CoachChatMessage[],
      }));
      setCoachDraft("");
    } catch (caught) {
      setCoachError(caught instanceof Error ? caught.message : "The coaching message could not be sent.");
    } finally {
      setCoachSending(false);
    }
  }

  const total = lesson.questions.length;
  const masteredPosition = currentQuestion ? Math.min(retryState.completed.length + 1, total) : total;
  const displayedProgress = total ? (masteredPosition / total) * 100 : 0;
  const upcomingRetry = currentSlotId ? (retryState.attemptsByQuestion[currentSlotId] ?? 0) > 0 : false;
  const displayedAttempt = currentSlotId ? (retryState.attemptsByQuestion[currentSlotId] ?? 0) + 1 : 0;
  const presentationDefaults = currentQuestion?.presentation ?? (currentQuestion ? defaultPresentationForFormat(currentQuestion.type) : null);
  const presentation = presentationDefaults ? effectivePresentation(presentationDefaults, playerPreference) : null;
  const currentMessages = currentSlotId ? chatByQuestion[currentSlotId] ?? [] : [];
  const speechSupported = "speechSynthesis" in window;
  const targetVoices = useMemo(
    () => filterSpeechVoices(voices, lesson.targetLanguage),
    [lesson.targetLanguage, voices],
  );
  const selectedVoice = targetVoices.some((voice) => voice.voiceURI === speechPreference.voiceURI)
    ? speechPreference.voiceURI
    : "";
  const targetVoiceAvailable = speechSupported && targetVoices.length > 0;
  const questionSpeech = currentQuestion ? questionSpeechText(currentQuestion) : "";
  const answerSpeech = currentQuestion ? answerSpeechText(currentQuestion, evaluation) : "";
  const lessonTargetStrings = useMemo(
    () => [
      ...lesson.questions.flatMap((question) => question.glossaryTargets ?? []),
      ...(lesson.questionAlternates ?? []).flatMap((alternate) => alternate.question.glossaryTargets ?? []),
    ],
    [lesson.questionAlternates, lesson.questions],
  );
  const targetGlossarySample = useMemo(
    () => lesson.glossary.find((entry) => glossaryEntryMatchesTargets(entry, lessonTargetStrings)),
    [lesson.glossary, lessonTargetStrings],
  );
  const pronunciationSample = useMemo(
    () => lesson.glossary.find((entry) => (
      Boolean(entry.pronunciation?.native || entry.pronunciation?.romanized)
      && glossaryEntryMatchesTargets(entry, lessonTargetStrings)
    )),
    [lesson.glossary, lessonTargetStrings],
  );
  const voicePreviewText = pronunciationSample?.term
    ?? targetGlossarySample?.term
    ?? voicePreviewSample(lesson.targetLanguage);
  const speechRateLabel = `${Number(speechPreference.rate.toFixed(2))}x`;
  const listeningPaused = playerPreference.listeningDisabledUntil > now;
  const renderGlossaryText = Boolean(presentation?.wordTooltips || playerPreference.showPronunciation);
  const portalTarget = document.querySelector<HTMLElement>(".app-shell") ?? document.body;

  useEffect(() => {
    if (!presentation?.readQuestion) {
      autoSpokenQuestionRef.current = null;
      return;
    }
    if (!currentQuestion || !questionSpeech || !targetVoiceAvailable) return;
    const speechKey = `${currentQuestion.id}\u0000${questionSpeech}`;
    if (autoSpokenQuestionRef.current === speechKey) return;
    autoSpokenQuestionRef.current = speechKey;
    speak(questionSpeech);
  }, [currentQuestion?.id, presentation?.readQuestion, questionSpeech, targetVoiceAvailable]);

  function speakActivatedAnswer(text: string) {
    if (!currentQuestion || !presentation?.readAnswers) return;
    const targetText = answerActivationSpeechText(currentQuestion, text);
    if (targetText) speak(targetText);
  }

  const player = (
    <div className="lesson-fullscreen" ref={playerRef} data-fullscreen-player>
      <section
        className="lesson-fullscreen-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lesson-player-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="lesson-fullscreen-header">
          <button className="lesson-close-button" type="button" aria-label="Exit lesson" onClick={() => void requestExit()} disabled={exiting}>
            <X size={22} />
          </button>
          <div className="lesson-fullscreen-progress">
            <div className="lesson-progress-track" role="progressbar" aria-label="Lesson position" aria-valuemin={1} aria-valuemax={total} aria-valuenow={masteredPosition}>
              <span style={{ width: `${displayedProgress}%` }} />
            </div>
            <strong>{masteredPosition}/{total}</strong>
          </div>
          <div className="lesson-header-actions">
            <button type="button" aria-label="Review theory" onClick={() => setTheoryOpen((open) => !open)} aria-expanded={theoryOpen}>
              <BookOpen size={17} /> <span>Review theory</span>
            </button>
            <button
              ref={speechButtonRef}
              type="button"
              aria-label="Lesson settings"
              aria-haspopup="dialog"
              aria-expanded={speechOpen}
              onClick={() => setSpeechOpen((open) => !open)}
            >
              <Settings2 size={17} /> <span>Settings</span>
            </button>
          </div>
        </header>

        {currentQuestion ? (
          <main className="lesson-question-scroll">
            <article className="lesson-question-stage">
              <div className="lesson-question-label-row">
                <span>{getQuestionFormatDefinition(currentQuestion.type).label}</span>
                {upcomingRetry ? <span className="retry-badge"><RotateCcw size={13} /> Attempt {displayedAttempt}</span> : null}
              </div>
              <div className="lesson-question-title-row">
                <h1 id="lesson-player-title">
                  {renderGlossaryText
                    ? <GlossaryText
                        text={currentQuestion.prompt}
                        glossary={lesson.glossary}
                        tooltipsEnabled={presentation?.wordTooltips}
                        showPronunciation={playerPreference.showPronunciation}
                        pronunciationMode={playerPreference.pronunciationMode}
                      />
                    : currentQuestion.prompt}
                </h1>
                <div className="lesson-question-speakers">
                  {presentation?.readQuestion && questionSpeech ? (
                    <button type="button" onClick={() => speak(questionSpeech)} disabled={!targetVoiceAvailable} aria-label={`Read ${lesson.targetLanguage} question text aloud`}>
                      <Volume2 size={18} /> <span>Question</span>
                    </button>
                  ) : null}
                  {presentation?.readAnswers && answerSpeech ? (
                    <button type="button" onClick={() => speak(answerSpeech)} disabled={!targetVoiceAvailable} aria-label={`Read ${lesson.targetLanguage} answer text aloud`}>
                      <Volume2 size={18} /> <span>Answers</span>
                    </button>
                  ) : null}
                </div>
              </div>
              <QuestionRenderer
                key={`${currentQuestion.id}-${displayedAttempt}`}
                question={currentQuestion}
                answer={answer}
                language={lesson.targetLanguage}
                disabled={Boolean(evaluation) || submitting}
                onChange={setAnswer}
                onAnswerActivate={speakActivatedAnswer}
                onSpeakingChange={setSpeaking}
                renderText={renderGlossaryText
                  ? (text, interactive = true) => <GlossaryText
                      text={text}
                      glossary={lesson.glossary}
                      tooltipsEnabled={presentation?.wordTooltips}
                      showPronunciation={playerPreference.showPronunciation}
                      pronunciationMode={playerPreference.pronunciationMode}
                      interactive={interactive}
                    />
                  : undefined}
              />
              {error ? <p className="inline-error" role="alert">{error}</p> : null}
            </article>
          </main>
        ) : (
          <main className="lesson-complete-screen">
            <span><Sparkles size={30} /></span>
            <p>Lesson complete</p>
            <h1 id="lesson-player-title">All {total} questions mastered</h1>
            <p>First-try accuracy: {Math.round((retryState.firstTryCorrect / Math.max(1, total)) * 100)}%. Missed questions were repeated until correct.</p>
            <div>
              <button className="secondary-button" type="button" onClick={() => void restartLesson()}><RotateCcw size={16} /> Restart</button>
              <button className="primary-button" type="button" onClick={() => void requestExit()} disabled={exiting}>Return to lessons</button>
            </div>
          </main>
        )}

        {notice ? <div className="lesson-player-notice" role="status">{notice}</div> : null}

        {currentQuestion && !evaluation ? (
          <footer className="lesson-action-bar">
            <div className="lesson-skip-actions">
              <button className="secondary-button" type="button" onClick={skipCurrentQuestion} disabled={submitting}>
                <SkipForward size={16} /> Skip
              </button>
              {currentSlotId && currentQuestion.type === "dictation" && alternateMap.has(currentSlotId) ? (
                <button className="secondary-button" type="button" onClick={pauseListeningExercises} disabled={submitting}>
                  <HeadphoneOff size={16} /> Can't listen now
                </button>
              ) : null}
            </div>
            <p>{currentQuestion.hint ? `Hint: ${currentQuestion.hint}` : "Answer the question, then check your response."}</p>
            <button className="primary-button" type="button" onClick={() => void submitAnswer()} disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={17} /> : null}
              {submitting ? "Checking..." : "Check answer"}
            </button>
          </footer>
        ) : null}

        {currentQuestion && evaluation ? (
          <footer className={`lesson-feedback-tray is-${evaluation.status}`} aria-live="polite">
            <div className="lesson-feedback-main">
              <span className="lesson-feedback-icon">
                {evaluation.status === "correct" ? <Check size={24} /> : evaluation.status === "partial" ? <AlertTriangle size={23} /> : <X size={24} />}
              </span>
              <div className="lesson-feedback-copy">
                <strong>{statusLabel(evaluation.status)} · {Math.round(evaluation.score * 100)}%</strong>
                <p>{evaluation.explanation}</p>
                {evaluation.status !== "correct" && evaluation.correction ? <p><b>Correction:</b> {evaluation.correction}</p> : null}
                <p className="next-hint"><Lightbulb size={14} /> {evaluation.nextHint}</p>
                {displayedAttempt >= 3 && currentQuestion.supplementalHint && evaluation.status !== "correct" ? (
                  <p className="supplemental-hint"><CircleHelp size={14} /> {currentQuestion.supplementalHint}</p>
                ) : null}
                {evaluation.errors.length ? (
                  <ul>{evaluation.errors.map((item, index) => <li key={`${item.location}-${index}`}><b>{item.location}:</b> {item.message}</li>)}</ul>
                ) : null}
              </div>
              <button className="lesson-continue-button" type="button" onClick={continueLesson}>
                Continue <ChevronRight size={17} />
              </button>
            </div>

            <section className="lesson-coach-chat" aria-labelledby="lesson-coach-title">
              <div className="lesson-coach-heading">
                <div><MessageCircle size={17} /><strong id="lesson-coach-title">Discuss this answer with ChatGPT</strong></div>
                <span>Session only</span>
              </div>
              {currentMessages.length ? (
                <div className="lesson-coach-messages" aria-live="polite">
                  {currentMessages.map((message, index) => (
                    <p className={`is-${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "user" ? "You" : "ChatGPT"}</span>{message.content}</p>
                  ))}
                </div>
              ) : null}
              {!coachingAvailable ? <p className="lesson-coach-status">Meoi Bridge is offline. Connect the extension to discuss this answer.</p> : null}
              {coachError ? (
                <p className="lesson-coach-error" role="alert">{coachError} <button type="button" onClick={() => void sendCoachMessage()}>Retry</button></p>
              ) : null}
              <form onSubmit={(event) => void sendCoachMessage(event)}>
                <label className="sr-only" htmlFor={`coach-${currentQuestion.id}`}>Message ChatGPT about this answer</label>
                <textarea
                  id={`coach-${currentQuestion.id}`}
                  rows={2}
                  value={coachDraft}
                  maxLength={16_000}
                  onChange={(event) => setCoachDraft(event.target.value)}
                  placeholder="Ask why this was graded this way, or request another example..."
                  disabled={!coachingAvailable || coachSending}
                />
                <button type="submit" aria-label="Send coaching message" disabled={!coachingAvailable || coachSending || !coachDraft.trim()}>
                  {coachSending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
                </button>
              </form>
            </section>
          </footer>
        ) : null}

        {theoryOpen ? (
          <aside className="lesson-theory-overlay" aria-label="Lesson theory">
            <div className="lesson-theory-header">
              <div><p>{lesson.targetLanguage} · {lesson.level}</p><h2>{lesson.title}</h2></div>
              <button type="button" aria-label="Close theory" onClick={() => setTheoryOpen(false)}><X size={20} /></button>
            </div>
            <div className="lesson-theory-content">
              <section><h3>Objectives</h3><ul>{lesson.objectives.map((objective) => <li key={objective}>{objective}</li>)}</ul></section>
              {lesson.theory.map((block) => <article key={block.id}><span>{block.kind}</span><h3>{block.title}</h3><p>{block.body}</p></article>)}
              {lesson.glossary.length ? <section><h3>Glossary</h3><dl>{lesson.glossary.map((entry) => <div key={entry.term}><dt>{entry.term}</dt><dd>{entry.meaning}</dd></div>)}</dl></section> : null}
            </div>
          </aside>
        ) : null}

        {speechOpen ? (
          <div className="lesson-speech-popover lesson-settings-popover" ref={speechPopoverRef} role="dialog" aria-label="Lesson settings" style={speechPosition}>
            <div><strong>Lesson settings</strong><button type="button" aria-label="Close lesson settings" onClick={() => { setSpeechOpen(false); speechButtonRef.current?.focus(); }}><X size={17} /></button></div>
            <section className="lesson-settings-section">
              <div className="lesson-settings-section-title"><strong>Learning aids</strong><button type="button" onClick={() => setPlayerPreference((current) => resetLessonPlayerPreference(current))}>Reset to lesson defaults</button></div>
              {([
                ["readQuestion", "Read question"],
                ["readAnswers", "Read answers"],
                ["wordTooltips", "Word tooltips"],
              ] as const).map(([key, label]) => (
                <label className="lesson-settings-toggle" key={key}>
                  <span>
                    {label}
                    <small>
                      {key === "wordTooltips" ? "" : `${lesson.targetLanguage} only · `}
                      {playerPreference[key] === undefined ? "Lesson default" : "Browser override"}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={Boolean(presentation?.[key])}
                    onChange={(event) => setPlayerPreference((current) => ({ ...current, [key]: event.target.checked }))}
                  />
                </label>
              ))}
              <label className="lesson-settings-toggle lesson-pronunciation-toggle">
                <span>Show pronunciation<small>Display readings above {lesson.targetLanguage} text</small></span>
                <input type="checkbox" checked={playerPreference.showPronunciation} onChange={(event) => setPlayerPreference((current) => ({ ...current, showPronunciation: event.target.checked }))} />
              </label>
              <div className="pronunciation-mode" role="group" aria-label="Pronunciation preview and style">
                <button
                  type="button"
                  className={playerPreference.pronunciationMode === "romanized" ? "is-active" : ""}
                  aria-pressed={playerPreference.pronunciationMode === "romanized"}
                  onClick={() => setPlayerPreference((current) => ({ ...current, pronunciationMode: "romanized" }))}
                >
                  <ruby lang={languageTagForSpeech(lesson.targetLanguage)}>
                    {pronunciationSample?.term ?? lesson.targetLanguage}
                    <rt>{pronunciationSample?.pronunciation?.romanized ?? "Preview unavailable"}</rt>
                  </ruby>
                  <span>Romanized</span>
                </button>
                <button
                  type="button"
                  className={playerPreference.pronunciationMode === "native" ? "is-active" : ""}
                  aria-pressed={playerPreference.pronunciationMode === "native"}
                  onClick={() => setPlayerPreference((current) => ({ ...current, pronunciationMode: "native" }))}
                >
                  <ruby lang={languageTagForSpeech(lesson.targetLanguage)}>
                    {pronunciationSample?.term ?? lesson.targetLanguage}
                    <rt>{pronunciationSample?.pronunciation?.native ?? "Preview unavailable"}</rt>
                  </ruby>
                  <span>Native reading</span>
                </button>
              </div>
            </section>
            <section className="lesson-settings-section">
              <div className="lesson-settings-section-title"><strong>Listening</strong>{listeningPaused ? <span>{listeningCountdown(playerPreference.listeningDisabledUntil, now)}</span> : <span>Available</span>}</div>
              <p>{listeningPaused ? "Dictation exercises use their non-listening alternative." : "Listening exercises are enabled."}</p>
              {listeningPaused ? <button className="secondary-button" type="button" onClick={() => setPlayerPreference((current) => enableListening(current))}>Enable listening now</button> : null}
            </section>
            <section className="lesson-settings-section">
              <div className="lesson-settings-section-title">
                <strong>Browser speech</strong>
                <span>{lesson.targetLanguage}</span>
              </div>
              <div className="lesson-voice-field">
                <label>
                  <span>Browser voice</span>
                  <select
                    disabled={!targetVoiceAvailable}
                    value={selectedVoice}
                    onChange={(event) => setSpeechPreference((current) => ({ ...current, voiceURI: event.target.value }))}
                  >
                    <option value="">
                      {targetVoices.length
                        ? `Automatic ${lesson.targetLanguage} voice`
                        : `No ${lesson.targetLanguage} voice available`}
                    </option>
                    {targetVoices.map((voice) => <option value={voice.voiceURI} key={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
                  </select>
                </label>
                <div className="lesson-voice-preview-row">
                  <button
                    className="lesson-voice-preview"
                    type="button"
                    onClick={() => speak(voicePreviewText)}
                    disabled={!targetVoiceAvailable || !voicePreviewText}
                  >
                    <Volume2 size={15} /> Preview voice
                  </button>
                  <span>
                    {targetVoices.length
                      ? `${targetVoices.length} matching ${targetVoices.length === 1 ? "voice" : "voices"}`
                      : `Install a ${lesson.targetLanguage} system voice to use speech.`}
                  </span>
                </div>
              </div>
              <label className="lesson-speed-control" htmlFor="lesson-voice-speed">
                <span><b>Voice speed</b><output>{speechRateLabel}</output></span>
                <input
                  id="lesson-voice-speed"
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.05"
                  value={speechPreference.rate}
                  disabled={!speechSupported}
                  aria-valuetext={speechRateLabel}
                  onChange={(event) => setSpeechPreference((current) => ({ ...current, rate: Number(event.target.value) }))}
                />
                <small><span>0.5x</span><span>1x</span><span>1.5x</span><span>2x</span></small>
              </label>
              <p>Speech uses only {lesson.targetLanguage}. Read question plays automatically on each new exercise; answer speech starts only when you select an answer.</p>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  );

  return createPortal(player, portalTarget);
}
