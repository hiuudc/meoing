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
  Keyboard,
  Rows3,
  RotateCcw,
  Send,
  Settings2,
  SkipForward,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { gradeAnswer, isAnswerComplete } from "./grader";
import { GlossaryText } from "./GlossaryText";
import { shouldFlushProgress } from "./progress";
import { answerActivationSpeechText, questionSpeechText } from "./questionContent";
import {
  isForbiddenLessonShortcut,
  lessonShortcutFromKeyboardEvent,
  lessonShortcutLabel,
  lessonShortcutMatches,
  effectivePresentation,
  enableListening,
  loadLessonPlayerPreference,
  pauseListening,
  resetLessonPlayerPreference,
  saveLessonPlayerPreference,
  type LessonPlayerPreference,
} from "./playerPreferences";
import { getQuestionFormatDefinition } from "./questionRegistry";
import { defaultPresentationForFormat, isListeningQuestionFormat } from "./questionSettings";
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
  PlayableLesson,
  PlayableQuestion,
  QuestionAnswer,
  SpeakingSubmission,
} from "./types";
import {
  answerBankForQuestion,
  QuestionRenderer,
  type AnswerInputMode,
} from "./QuestionRenderer";
import "./lesson.css";

export interface CoachChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface LessonPlayerProps {
  lesson: PlayableLesson;
  coachingAvailable: boolean;
  variant?: "standard" | "lettersPractice";
  onEvaluate?: (question: LessonQuestion, answer: QuestionAnswer, speaking?: SpeakingSubmission | null) => Promise<Evaluation>;
  onProgressBatch?: (attempts: AttemptRecord[], snapshot: LessonProgressSnapshot) => void | Promise<void>;
  onAskCoach?: (
    question: LessonQuestion,
    evaluation: Evaluation,
    message: string,
    history: CoachChatMessage[],
  ) => Promise<string>;
  onExit: () => void;
  returnLabel?: string;
  interactionSuspended?: boolean;
  tracingOptions?: {
    requireStrokeOrder?: boolean;
    strokeTolerance?: number;
    showStrokeGuide?: boolean;
    onOpenSettings?: (trigger: HTMLButtonElement) => void;
    resetRevision?: number;
  };
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function initialAnswer(question: PlayableQuestion): QuestionAnswer {
  if (["multipleChoice", "wordBank", "reorderTokens", "reorderDialogue"].includes(question.type)) return [];
  if (["multiCloze", "matching", "audioMatching", "categorize"].includes(question.type)) return {};
  return "";
}

function buildSnapshot(lesson: PlayableLesson, state: RetryState): LessonProgressSnapshot {
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

function isEditableTarget(target: HTMLElement | null): boolean {
  return Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
}

function isTextEditingTarget(target: HTMLElement | null): boolean {
  const editable = target?.closest<HTMLElement>("input, textarea, select, [contenteditable='true']");
  if (!editable) return false;
  if (editable instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "reset", "submit"].includes(editable.type);
  }
  return true;
}

function separatedQuestionPrompts(question: PlayableQuestion): { source: string; target: string } {
  if (question.targetPrompt?.trim()) {
    return { source: question.prompt, target: question.targetPrompt.trim() };
  }
  const candidates = (question.glossaryTargets ?? [])
    .map((target) => target.trim())
    .filter((target) => target && question.prompt.includes(target));
  const maximal = candidates.filter((candidate) => !candidates.some((other) => (
    other !== candidate && other.includes(candidate)
  )));
  if (maximal.length !== 1) return { source: question.prompt, target: "" };
  const target = maximal[0];
  const source = question.prompt.replace(target, " ").replace(/\s+/g, " ").trim();
  return source && source !== question.prompt ? { source, target } : { source: question.prompt, target: "" };
}

export function LessonPlayer({
  lesson,
  coachingAvailable,
  variant = "standard",
  onEvaluate,
  onProgressBatch,
  onAskCoach,
  onExit,
  returnLabel = "Return to lessons",
  interactionSuspended = false,
  tracingOptions,
}: LessonPlayerProps) {
  const lettersPractice = variant === "lettersPractice";
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
  const [answerInputModeOverride, setAnswerInputModeOverride] = useState<AnswerInputMode | null>(null);
  const [voicePreviewStatus, setVoicePreviewStatus] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [chatByQuestion, setChatByQuestion] = useState<Record<string, CoachChatMessage[]>>({});
  const [coachDraft, setCoachDraft] = useState("");
  const [coachError, setCoachError] = useState("");
  const [coachSending, setCoachSending] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [recordingSkipShortcut, setRecordingSkipShortcut] = useState(false);
  const [shortcutStatus, setShortcutStatus] = useState("");
  const pendingAttemptsRef = useRef<AttemptRecord[]>([]);
  const retryStateRef = useRef(retryState);
  const progressHandlerRef = useRef(onProgressBatch);
  const lessonRef = useRef(lesson);
  const playerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const speechButtonRef = useRef<HTMLButtonElement>(null);
  const speechPopoverRef = useRef<HTMLDivElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const autoSpokenQuestionRef = useRef<string | null>(null);
  const autoSpokenTraceRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const continuingRef = useRef(false);
  const numberBufferRef = useRef("");
  const numberTimerRef = useRef<number | null>(null);
  const numberFocusFrameRef = useRef<number | null>(null);

  function questionForState(state: RetryState): PlayableQuestion | undefined {
    const slotId = state.queue[0];
    const primary = questionMap.get(slotId);
    return state.alternateQuestionIds.includes(slotId) ? alternateMap.get(slotId) ?? primary : primary;
  }

  function focusCurrentQuestion() {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const inputs = Array.from(
      dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "[data-question-answer-input]:not(:disabled)",
      ),
    );
    const input = inputs.find((candidate) => !candidate.value.trim()) ?? inputs[0];
    if (input) {
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
      return;
    }
    dialog.querySelector<HTMLElement>("[data-question-focus-root]")?.focus({ preventScroll: true });
  }

  function showRetryState(next: RetryState) {
    setRetryState(next);
    retryStateRef.current = next;
    const nextQuestion = questionForState(next);
    setAnswer(nextQuestion ? initialAnswer(nextQuestion) : "");
    setSpeaking(null);
    setEvaluation(null);
    setSubmitting(false);
    submittingRef.current = false;
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
    setSubmitting(false);
    submittingRef.current = false;
    continuingRef.current = false;
    setError("");
    setTheoryOpen(false);
    setSpeechOpen(false);
    setAnswerInputModeOverride(null);
    setVoicePreviewStatus("");
    setChatByQuestion({});
    setCoachDraft("");
    setCoachError("");
    setNotice("");
    setRecordingSkipShortcut(false);
    setShortcutStatus("");
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
    const frame = window.requestAnimationFrame(() => {
      if (!dialogRef.current?.contains(document.activeElement)) focusCurrentQuestion();
    });
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

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.inert = interactionSuspended;
    if (interactionSuspended) dialog.setAttribute("aria-hidden", "true");
    else dialog.removeAttribute("aria-hidden");
  }, [interactionSuspended]);

  useLayoutEffect(() => {
    if (numberFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(numberFocusFrameRef.current);
      numberFocusFrameRef.current = null;
    }
    if (evaluation) continueButtonRef.current?.focus({ preventScroll: true });
  }, [currentQuestion?.id, evaluation]);

  useEffect(() => {
    if (!evaluation) continuingRef.current = false;
  }, [currentQuestion?.id, evaluation]);

  useEffect(() => {
    numberBufferRef.current = "";
    if (numberTimerRef.current !== null) {
      window.clearTimeout(numberTimerRef.current);
      numberTimerRef.current = null;
    }
  }, [currentQuestion?.id, evaluation, speechOpen, theoryOpen]);

  useEffect(() => () => {
    if (numberTimerRef.current !== null) window.clearTimeout(numberTimerRef.current);
    if (numberFocusFrameRef.current !== null) window.cancelAnimationFrame(numberFocusFrameRef.current);
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
      || !currentPrimaryQuestion
      || !isListeningQuestionFormat(currentPrimaryQuestion.type)
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

  function handleDialogKeyDownCapture(event: React.KeyboardEvent<HTMLElement>) {
    if (interactionSuspended || event.defaultPrevented || recordingSkipShortcut) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.key === "Escape") {
      if (target?.closest("[data-typeahead-active='true']")) return;
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
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    function activateNumberShortcut(index: number) {
      const control = dialogRef.current?.querySelector<HTMLElement>(
        `[data-lesson-hotkey-index="${index}"]:not(:disabled)`,
      );
      if (!control) return;
      control.click();
      if (numberFocusFrameRef.current !== null) window.cancelAnimationFrame(numberFocusFrameRef.current);
      numberFocusFrameRef.current = window.requestAnimationFrame(() => {
        numberFocusFrameRef.current = null;
        dialogRef.current?.querySelector<HTMLElement>("[data-question-focus-root]")?.focus({ preventScroll: true });
      });
    }

    function handleLessonKeyDown(event: KeyboardEvent) {
      if (
        interactionSuspended
        || event.defaultPrevented
        || recordingSkipShortcut
        || event.repeat
        || event.isComposing
        || event.keyCode === 229
      ) return;

      const target = event.target instanceof HTMLElement ? event.target : null;
      const skipShortcut = playerPreference.skipShortcut;
      if (
        !speechOpen
        && !theoryOpen
        && lessonShortcutMatches(event, skipShortcut)
        && (!isEditableTarget(target) || skipShortcut.altKey || skipShortcut.ctrlKey || skipShortcut.metaKey || skipShortcut.shiftKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        skipCurrentQuestion();
        return;
      }

      if (event.key === "Enter") {
        if (speechOpen || theoryOpen) return;
        const button = target?.closest<HTMLButtonElement>("button");
        const coachForm = target?.closest(".lesson-coach-chat form");
        if (coachForm) {
          if (button) return;
          if (target instanceof HTMLTextAreaElement && event.shiftKey) return;
          event.preventDefault();
          event.stopPropagation();
          if (coachDraft.trim() && coachingAvailable && !coachSending) void sendCoachMessage();
          else if (evaluation) continueLesson();
          return;
        }
        if (evaluation) {
          if (button && !button.classList.contains("lesson-continue-button") && !button.hasAttribute("disabled")) return;
          event.preventDefault();
          event.stopPropagation();
          continueLesson();
          return;
        }
        if (button && !button.classList.contains("primary-button")) return;
        if (target instanceof HTMLSelectElement) return;
        if (target instanceof HTMLTextAreaElement && event.shiftKey) return;
        if (!currentQuestion) return;
        event.preventDefault();
        event.stopPropagation();
        void submitAnswer();
        return;
      }

      if (
        evaluation
        || submitting
        || speechOpen
        || theoryOpen
        || isTextEditingTarget(target)
        || event.altKey
        || event.ctrlKey
        || event.metaKey
      ) return;
      const digit = event.code.startsWith("Numpad") ? event.code.slice(6) : event.key;
      if (!/^\d$/.test(digit)) return;

      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("[data-lesson-hotkey-index]") ?? [],
      );
      const maxIndex = controls.reduce((maximum, control) => (
        Math.max(maximum, Number(control.dataset.lessonHotkeyIndex) || 0)
      ), 0);
      if (!maxIndex) return;

      event.preventDefault();
      event.stopPropagation();
      if (numberTimerRef.current !== null) window.clearTimeout(numberTimerRef.current);
      if (maxIndex <= 9) {
        numberBufferRef.current = "";
        numberTimerRef.current = null;
        const numeric = Number(digit);
        if (numeric >= 1 && numeric <= maxIndex) activateNumberShortcut(numeric);
        return;
      }
      const nextBuffer = `${numberBufferRef.current}${digit}`.replace(/^0+/, "");
      numberBufferRef.current = nextBuffer;
      const numeric = Number(nextBuffer);
      const hasLongerCandidate = nextBuffer.length === 1
        && Array.from({ length: maxIndex }, (_, index) => String(index + 1)).some((label) => (
          label.length > nextBuffer.length && label.startsWith(nextBuffer)
        ));
      if (numeric >= 1 && numeric <= maxIndex && !hasLongerCandidate) {
        numberBufferRef.current = "";
        numberTimerRef.current = null;
        activateNumberShortcut(numeric);
        return;
      }
      numberTimerRef.current = window.setTimeout(() => {
        const pending = Number(numberBufferRef.current);
        numberBufferRef.current = "";
        numberTimerRef.current = null;
        if (pending >= 1 && pending <= maxIndex) activateNumberShortcut(pending);
      }, 420);
    }

    window.addEventListener("keydown", handleLessonKeyDown, true);
    return () => window.removeEventListener("keydown", handleLessonKeyDown, true);
  }, [
    answer,
    coachDraft,
    coachSending,
    coachingAvailable,
    currentQuestion,
    evaluation,
    interactionSuspended,
    playerPreference.skipShortcut,
    recordingSkipShortcut,
    retryState,
    speaking,
    speechOpen,
    submitting,
    theoryOpen,
  ]);

  function speak(text: string, preference = speechPreference): boolean {
    if (!("speechSynthesis" in window) || !text.trim()) return false;
    const voice = resolveSpeechVoice(voices, preference, lesson.targetLanguage);
    if (!voice) return false;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = preference.rate;
    utterance.voice = voice;
    utterance.lang = voice.lang || languageTagForSpeech(lesson.targetLanguage);
    window.speechSynthesis.speak(utterance);
    return true;
  }

  async function submitAnswer(candidateAnswer: QuestionAnswer = answer) {
    if (!currentQuestion || evaluation || submitting || submittingRef.current) return;
    if (!isAnswerComplete(currentQuestion, candidateAnswer) && !(speaking?.audio || speaking?.transcript)) {
      setError(currentQuestion.type === "matching" || currentQuestion.type === "audioMatching"
        ? "Complete every matching pair before checking the answer."
        : currentQuestion.type === "categorize"
          ? "Categorize every item before checking the answer."
          : "Enter or select an answer before checking it.");
      if (currentQuestion.type === "multiCloze") {
        const values = candidateAnswer && typeof candidateAnswer === "object" && !Array.isArray(candidateAnswer)
          ? candidateAnswer as Record<string, string>
          : {};
        const missing = currentQuestion.blanks.find((blank) => !values[blank.id]?.trim());
        const inputs = Array.from(dialogRef.current?.querySelectorAll<HTMLInputElement>("[data-multi-cloze-input]") ?? []);
        inputs.find((input) => input.dataset.multiClozeInput === missing?.id)?.focus();
      }
      return;
    }
    setError("");
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const local = gradeAnswer(currentQuestion, candidateAnswer);
      if (!local.requiresAi) {
        setEvaluation(local);
      } else if (currentQuestion.type === "characterTracing") {
        setError("Character tracing could not be graded locally.");
      } else if (!onEvaluate) {
        setError("This question needs ChatGPT evaluation and is unavailable in local-only mode.");
      } else {
        setEvaluation(await onEvaluate(currentQuestion, candidateAnswer, speaking));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The answer could not be evaluated right now.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function continueLesson() {
    if (!currentQuestion || !currentSlotId || !evaluation || continuingRef.current) return;
    continuingRef.current = true;
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
    if (!currentSlotId || !currentQuestion || !isListeningQuestionFormat(currentQuestion.type) || !alternateMap.has(currentSlotId)) return;
    const nextPreference = pauseListening(playerPreference);
    setPlayerPreference(nextPreference);
    setNow(Date.now());
    const next = useListeningAlternate(retryState, currentSlotId, true);
    showRetryState(next);
    setNotice("Listening exercises are paused for 15 minutes and will use non-listening alternatives.");
  }

  function useCurrentAlternate(reason: string) {
    if (!currentSlotId || retryState.alternateQuestionIds.includes(currentSlotId)) {
      setError(reason);
      return;
    }
    const alternate = alternateMap.get(currentSlotId);
    if (!alternate) {
      setError(`${reason} No alternate exercise is available for this saved lesson.`);
      return;
    }
    const next = useListeningAlternate(retryState, currentSlotId, true);
    showRetryState(next);
    setNotice(`${reason} This slot will return as ${getQuestionFormatDefinition(alternate.type).label}.`);
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
    if (currentQuestion.type === "characterTracing") return;
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
  const separatedPrompts = currentQuestion
    ? separatedQuestionPrompts(currentQuestion)
    : { source: "", target: "" };
  const rendererOwnsTargetPrompt = currentQuestion
    ? ["fillBlank", "selectBlank", "multiCloze"].includes(currentQuestion.type)
    : false;
  const currentAnswerBank = currentQuestion ? answerBankForQuestion(currentQuestion) : undefined;
  const answerInputMode = currentAnswerBank
    ? answerInputModeOverride ?? currentAnswerBank.defaultMode
    : undefined;
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
  const voicePreviewText = questionSpeech
    || pronunciationSample?.term
    || targetGlossarySample?.term
    || voicePreviewSample(lesson.targetLanguage);
  const speechRateLabel = `${Number(speechPreference.rate.toFixed(2))}x`;
  const typeaheadTimeoutLabel = `${Number((playerPreference.typeaheadTimeoutMs / 1_000).toFixed(2))}s`;
  const listeningPaused = playerPreference.listeningDisabledUntil > now;
  const automaticallyGraded = currentQuestion
    ? ["matching", "audioMatching", "categorize", "characterTracing"].includes(currentQuestion.type)
    : false;
  const showCurrentPronunciation = playerPreference.showPronunciation && !lettersPractice;
  const renderGlossaryText = Boolean(presentation?.wordTooltips || showCurrentPronunciation);
  const portalTarget = document.querySelector<HTMLElement>(".app-shell") ?? document.body;

  useLayoutEffect(() => {
    if (!currentQuestion || evaluation) return undefined;
    focusCurrentQuestion();
    return undefined;
  }, [answerInputMode, currentQuestion?.id, displayedAttempt, evaluation]);

  useEffect(() => {
    if (currentQuestion?.type === "characterTracing") return;
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

  useEffect(() => {
    if (currentQuestion?.type !== "characterTracing") {
      autoSpokenTraceRef.current = null;
      return;
    }
    if (!targetVoiceAvailable) return;
    const skipCount = retryState.skipsByQuestion[currentQuestion.id] ?? 0;
    const speechKey = `${currentQuestion.id}\u0000${displayedAttempt}\u0000${skipCount}`;
    if (autoSpokenTraceRef.current === speechKey) return;
    if (speak(currentQuestion.character)) autoSpokenTraceRef.current = speechKey;
  }, [
    currentQuestion?.id,
    currentQuestion?.type,
    displayedAttempt,
    retryState.skipsByQuestion,
    targetVoiceAvailable,
  ]);

  function speakActivatedAnswer(text: string) {
    if (!currentQuestion || (!lettersPractice && !presentation?.readAnswers)) return;
    const targetText = answerActivationSpeechText(currentQuestion, text);
    if (targetText) speak(targetText);
  }

  function completeInteractiveQuestion(nextAnswer: QuestionAnswer) {
    setAnswer(nextAnswer);
    void submitAnswer(nextAnswer);
  }

  function switchAnswerInputMode() {
    if (!answerInputMode) return;
    const nextMode: AnswerInputMode = answerInputMode === "keyboard" ? "bank" : "keyboard";
    setAnswerInputModeOverride(nextMode);
  }

  function recordSkipShortcut(event: React.KeyboardEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecordingSkipShortcut(false);
      setShortcutStatus("Shortcut recording cancelled.");
      return;
    }
    if (event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const shortcut = lessonShortcutFromKeyboardEvent(event.nativeEvent);
    if (isForbiddenLessonShortcut(shortcut)) {
      setShortcutStatus("That key is reserved by the lesson or browser. Choose another shortcut.");
      return;
    }
    setPlayerPreference((current) => ({ ...current, skipShortcut: shortcut }));
    setRecordingSkipShortcut(false);
    setShortcutStatus(`Skip shortcut saved as ${lessonShortcutLabel(shortcut)}.`);
  }

  function renderLessonText(text: string, interactive = true) {
    const normalizedText = text.trim();
    const targetLanguageTag = languageTagForSpeech(lesson.targetLanguage);
    const isExactTargetText = Boolean(normalizedText && currentQuestion?.glossaryTargets?.some(
      (target) => target.trim() === normalizedText,
    ));
    const containsTargetText = Boolean(normalizedText && currentQuestion?.glossaryTargets?.some(
      (target) => target.trim() && text.includes(target),
    ));
    const content = renderGlossaryText || containsTargetText ? (
      <GlossaryText
        text={text}
        glossary={lesson.glossary}
        tooltipsEnabled={presentation?.wordTooltips}
        showPronunciation={showCurrentPronunciation}
        pronunciationMode={playerPreference.pronunciationMode}
        interactive={interactive}
        termClassName={isExactTargetText ? undefined : "lesson-target-text"}
        termLang={isExactTargetText ? undefined : targetLanguageTag}
        onTermActivate={speak}
      />
    ) : text;
    return isExactTargetText ? (
      <span className="lesson-target-text" lang={targetLanguageTag}>{content}</span>
    ) : content;
  }

  function selectVoice(voiceURI: string) {
    const nextPreference = { ...speechPreference, voiceURI };
    setSpeechPreference(nextPreference);
    const voice = resolveSpeechVoice(voices, nextPreference, lesson.targetLanguage);
    if (!voice || !voicePreviewText) {
      setVoicePreviewStatus(`No ${lesson.targetLanguage} voice is available for preview.`);
      return;
    }
    setVoicePreviewStatus(`Previewing ${voice.name}.`);
    speak(voicePreviewText, nextPreference);
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
        onKeyDownCapture={handleDialogKeyDownCapture}
      >
        <header className="lesson-fullscreen-header">
          <div className="lesson-header-left-actions">
            <button className="lesson-close-button" type="button" aria-label="Exit lesson" onClick={() => void requestExit()} disabled={exiting}>
              <X size={22} />
            </button>
            {currentQuestion?.type === "characterTracing" && tracingOptions?.onOpenSettings ? (
              <button
                className="letter-settings-context-trigger"
                type="button"
                aria-label="Open Letter settings"
                title="Letter settings"
                onClick={(event) => tracingOptions.onOpenSettings?.(event.currentTarget)}
              >
                <Settings2 size={18} />
              </button>
            ) : null}
          </div>
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
            <article className="lesson-question-stage" data-question-focus-root tabIndex={-1}>
              <div className="lesson-question-label-row">
                <span>{getQuestionFormatDefinition(currentQuestion.type).label}</span>
                {upcomingRetry ? <span className="retry-badge"><RotateCcw size={13} /> Attempt {displayedAttempt}</span> : null}
              </div>
              <div className="lesson-question-title-row">
                <h1 id="lesson-player-title">
                  {separatedPrompts.target ? separatedPrompts.source : renderLessonText(separatedPrompts.source)}
                </h1>
              </div>
              {separatedPrompts.target && !rendererOwnsTargetPrompt ? (
                <div className="lesson-target-prompt-row">
                  <button
                    type="button"
                    aria-label={`Play ${lesson.targetLanguage} prompt`}
                    onClick={() => speak(questionSpeech || separatedPrompts.target)}
                    disabled={!targetVoiceAvailable}
                  >
                    <Volume2 size={20} />
                  </button>
                  <p>{renderLessonText(separatedPrompts.target)}</p>
                </div>
              ) : null}
              <QuestionRenderer
                key={`${currentQuestion.id}-${displayedAttempt}`}
                question={currentQuestion}
                answer={answer}
                language={lesson.targetLanguage}
                disabled={Boolean(evaluation) || submitting}
                evaluated={Boolean(evaluation)}
                onChange={setAnswer}
                answerInputMode={answerInputMode}
                onAnswerActivate={speakActivatedAnswer}
                onSpeakTarget={targetVoiceAvailable ? speak : undefined}
                onSpeakingChange={setSpeaking}
                onRequireAlternate={() => useCurrentAlternate("This exercise is not supported on this device.")}
                onComplete={completeInteractiveQuestion}
                renderText={renderLessonText}
                typeaheadResetMs={playerPreference.typeaheadTimeoutMs}
                tracingOptions={tracingOptions}
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
              <button className="primary-button" type="button" onClick={() => void requestExit()} disabled={exiting}>{returnLabel}</button>
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
              {currentSlotId && isListeningQuestionFormat(currentQuestion.type) && alternateMap.has(currentSlotId) ? (
                <button className="secondary-button" type="button" onClick={pauseListeningExercises} disabled={submitting}>
                  <HeadphoneOff size={16} /> Can't listen now
                </button>
              ) : null}
            </div>
            {currentAnswerBank && answerInputMode ? (
              <button
                className="lesson-input-mode-toggle"
                type="button"
                onClick={switchAnswerInputMode}
                disabled={submitting}
              >
                {answerInputMode === "keyboard" ? <Rows3 size={17} /> : <Keyboard size={17} />}
                {answerInputMode === "keyboard" ? "Use word bank" : "Use keyboard"}
              </button>
            ) : !automaticallyGraded ? (
              <p>{currentQuestion.hint ? `Hint: ${currentQuestion.hint}` : "Answer the question, then check your response."}</p>
            ) : <span aria-hidden="true" />}
            {automaticallyGraded ? (
              <p className="lesson-auto-grade-status">
                {submitting
                  ? "Checking..."
                  : currentQuestion.type === "characterTracing"
                    ? "Complete the trace to continue."
                    : "Complete all matches to continue."}
              </p>
            ) : (
              <button className="primary-button" type="button" onClick={() => void submitAnswer()} disabled={submitting}>
                {submitting ? <LoaderCircle className="spin" size={17} /> : null}
                {submitting ? "Checking..." : "Check answer"}
              </button>
            )}
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
              <button ref={continueButtonRef} className="lesson-continue-button" type="button" onClick={continueLesson}>
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
              <div className="lesson-settings-section-title"><strong>Keyboard shortcuts</strong><span>Browser setting</span></div>
              <div className="lesson-shortcut-setting">
                <span>
                  Skip exercise
                  <small>Plain keys work outside text fields. Modified shortcuts also work while typing.</small>
                </span>
                <button
                  type="button"
                  className={recordingSkipShortcut ? "is-recording" : ""}
                  aria-pressed={recordingSkipShortcut}
                  onClick={() => {
                    setRecordingSkipShortcut(true);
                    setShortcutStatus("Press the new Skip shortcut. Escape cancels.");
                  }}
                  onKeyDown={recordSkipShortcut}
                >
                  {recordingSkipShortcut ? "Press keys..." : lessonShortcutLabel(playerPreference.skipShortcut)}
                </button>
              </div>
              <p className="lesson-shortcut-status" role="status">{shortcutStatus}</p>
            </section>
            <section className="lesson-settings-section">
              <div className="lesson-settings-section-title"><strong>Word bank</strong><span>Browser setting</span></div>
              <label className="lesson-range-control lesson-typeahead-control" htmlFor="lesson-typeahead-timeout">
                <span><b>Typeahead reset time</b><output>{typeaheadTimeoutLabel}</output></span>
                <input
                  id="lesson-typeahead-timeout"
                  type="range"
                  min="1"
                  max="10"
                  step="0.25"
                  value={playerPreference.typeaheadTimeoutMs / 1_000}
                  aria-valuetext={typeaheadTimeoutLabel}
                  onChange={(event) => setPlayerPreference((current) => ({
                    ...current,
                    typeaheadTimeoutMs: Math.round(Number(event.target.value) * 1_000),
                  }))}
                />
                <small className="lesson-speed-ticks" aria-hidden="true">
                  <span style={{ left: "0%" }}>1s</span>
                  <span style={{ left: "44.444%" }}>5s</span>
                  <span style={{ left: "100%" }}>10s</span>
                </small>
              </label>
              <p>Controls how long an unfinished word prefix stays active. A unique match is still selected immediately.</p>
            </section>
            <section className="lesson-settings-section">
              <div className="lesson-settings-section-title"><strong>Listening</strong>{listeningPaused ? <span>{listeningCountdown(playerPreference.listeningDisabledUntil, now)}</span> : <span>Available</span>}</div>
              <p>{listeningPaused ? "Listening exercises use their non-listening alternatives." : "Listening exercises are enabled."}</p>
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
                    onChange={(event) => selectVoice(event.target.value)}
                  >
                    <option value="">
                      {targetVoices.length
                        ? `Automatic ${lesson.targetLanguage} voice`
                        : `No ${lesson.targetLanguage} voice available`}
                    </option>
                    {targetVoices.map((voice) => <option value={voice.voiceURI} key={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
                  </select>
                </label>
                <p className="lesson-voice-status" role="status">
                  {voicePreviewStatus || (targetVoices.length
                    ? `${targetVoices.length} matching ${targetVoices.length === 1 ? "voice" : "voices"} · selecting one previews it automatically`
                    : `Install a ${lesson.targetLanguage} system voice to use speech.`)}
                </p>
              </div>
              <label className="lesson-range-control lesson-speed-control" htmlFor="lesson-voice-speed">
                <span><b>Voice speed</b><output>{speechRateLabel}</output></span>
                <input
                  id="lesson-voice-speed"
                  type="range"
                  min="0.25"
                  max="2"
                  step="0.05"
                  value={speechPreference.rate}
                  disabled={!speechSupported}
                  aria-valuetext={speechRateLabel}
                  onChange={(event) => setSpeechPreference((current) => ({ ...current, rate: Number(event.target.value) }))}
                />
                <small className="lesson-speed-ticks" aria-hidden="true">
                  <span style={{ left: "0%" }}>0.25x</span>
                  <span style={{ left: "42.857%" }}>1x</span>
                  <span style={{ left: "71.429%" }}>1.5x</span>
                  <span style={{ left: "100%" }}>2x</span>
                </small>
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
