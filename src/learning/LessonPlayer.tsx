import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Lightbulb,
  LoaderCircle,
  MessageCircle,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { gradeAnswer, isAnswerEmpty } from "./grader";
import { GlossaryText } from "./GlossaryText";
import { shouldFlushProgress } from "./progress";
import { answerSpeechText, questionSpeechText } from "./questionContent";
import { getQuestionFormatDefinition } from "./questionRegistry";
import { defaultPresentationForFormat } from "./questionSettings";
import { applyAttempt, createRetryState, masteryPercent, type RetryState } from "./retry";
import {
  loadSpeechPreference,
  resolveSpeechVoice,
  saveSpeechPreference,
  type BrowserSpeechPreference,
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

const SPEECH_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

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

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
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
  const [retryState, setRetryState] = useState(() => createRetryState(lesson.questions.map((question) => question.id)));
  const currentQuestion = questionMap.get(retryState.queue[0]);
  const [answer, setAnswer] = useState<QuestionAnswer>(() => currentQuestion ? initialAnswer(currentQuestion) : "");
  const [speaking, setSpeaking] = useState<SpeakingSubmission | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [theoryOpen, setTheoryOpen] = useState(false);
  const [speechOpen, setSpeechOpen] = useState(false);
  const [speechPosition, setSpeechPosition] = useState({ top: 0, left: 0 });
  const [speechPreference, setSpeechPreference] = useState<BrowserSpeechPreference>(() => loadSpeechPreference(window.localStorage));
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
      const width = Math.min(320, window.innerWidth - 16);
      const height = speechPopoverRef.current?.offsetHeight ?? 220;
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
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = speechPreference.rate;
    const voice = resolveSpeechVoice(voices, speechPreference, lesson.targetLanguage);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
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
    if (!currentQuestion || !evaluation) return;
    window.speechSynthesis?.cancel();
    const attemptNumber = (retryState.attemptsByQuestion[currentQuestion.id] ?? 0) + 1;
    const nextState = applyAttempt(retryState, currentQuestion.id, evaluation.status);
    const record: AttemptRecord = {
      questionId: currentQuestion.id,
      attemptNumber,
      status: evaluation.status,
      score: evaluation.score,
      firstTry: attemptNumber === 1,
      answeredAt: new Date().toISOString(),
    };
    const pending = [...pendingAttemptsRef.current, record];
    pendingAttemptsRef.current = pending;
    setRetryState(nextState);
    retryStateRef.current = nextState;
    const lessonComplete = nextState.queue.length === 0;
    if (shouldFlushProgress({ pending, lessonComplete, pageHidden: document.visibilityState === "hidden" })) {
      pendingAttemptsRef.current = [];
      void onProgressBatch?.(pending, buildSnapshot(lesson, nextState));
    }
    const nextQuestion = questionMap.get(nextState.queue[0]);
    setAnswer(nextQuestion ? initialAnswer(nextQuestion) : "");
    setSpeaking(null);
    setEvaluation(null);
    setError("");
    setCoachDraft("");
    setCoachError("");
  }

  async function restartLesson() {
    await flushPendingProgress();
    const next = createRetryState(lesson.questions.map((question) => question.id));
    setRetryState(next);
    retryStateRef.current = next;
    setAnswer(lesson.questions[0] ? initialAnswer(lesson.questions[0]) : "");
    setSpeaking(null);
    setEvaluation(null);
    setError("");
    setChatByQuestion({});
    setCoachDraft("");
    setCoachError("");
    pendingAttemptsRef.current = [];
  }

  async function sendCoachMessage(event?: React.FormEvent) {
    event?.preventDefault();
    if (!currentQuestion || !evaluation || !onAskCoach || !coachingAvailable || coachSending) return;
    const message = coachDraft.trim();
    if (!message) return;
    const history = (chatByQuestion[currentQuestion.id] ?? []).slice(-8);
    setCoachSending(true);
    setCoachError("");
    try {
      const reply = (await onAskCoach(currentQuestion, evaluation, message, history)).trim();
      if (!reply) throw new Error("ChatGPT returned an empty coaching reply.");
      setChatByQuestion((current) => ({
        ...current,
        [currentQuestion.id]: [
          ...(current[currentQuestion.id] ?? []),
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
  const upcomingRetry = currentQuestion ? (retryState.attemptsByQuestion[currentQuestion.id] ?? 0) > 0 : false;
  const displayedAttempt = currentQuestion ? (retryState.attemptsByQuestion[currentQuestion.id] ?? 0) + 1 : 0;
  const presentation = currentQuestion?.presentation ?? (currentQuestion ? defaultPresentationForFormat(currentQuestion.type) : null);
  const currentMessages = currentQuestion ? chatByQuestion[currentQuestion.id] ?? [] : [];
  const speechSupported = "speechSynthesis" in window;
  const selectedVoice = voices.some((voice) => voice.voiceURI === speechPreference.voiceURI) ? speechPreference.voiceURI : "";
  const portalTarget = document.querySelector<HTMLElement>(".app-shell") ?? document.body;

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
            <button type="button" onClick={() => setTheoryOpen((open) => !open)} aria-expanded={theoryOpen}>
              <BookOpen size={17} /> <span>Review theory</span>
            </button>
            <button
              ref={speechButtonRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={speechOpen}
              onClick={() => setSpeechOpen((open) => !open)}
              disabled={!speechSupported}
            >
              <Settings2 size={17} /> <span>Speech</span>
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
                  {presentation?.wordTooltips
                    ? <GlossaryText text={currentQuestion.prompt} glossary={lesson.glossary} />
                    : currentQuestion.prompt}
                </h1>
                <div className="lesson-question-speakers">
                  {presentation?.readQuestion ? (
                    <button type="button" onClick={() => speak(questionSpeechText(currentQuestion))} disabled={!speechSupported} aria-label="Read question aloud">
                      <Volume2 size={18} /> <span>Question</span>
                    </button>
                  ) : null}
                  {presentation?.readAnswers && answerSpeechText(currentQuestion, evaluation) ? (
                    <button type="button" onClick={() => speak(answerSpeechText(currentQuestion, evaluation))} disabled={!speechSupported} aria-label="Read answers aloud">
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
                onSpeakingChange={setSpeaking}
                renderText={presentation?.wordTooltips
                  ? (text) => <GlossaryText text={text} glossary={lesson.glossary} />
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

        {currentQuestion && !evaluation ? (
          <footer className="lesson-action-bar">
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
          <div className="lesson-speech-popover" ref={speechPopoverRef} role="dialog" aria-label="Speech settings" style={speechPosition}>
            <div><strong>Speech settings</strong><button type="button" aria-label="Close speech settings" onClick={() => { setSpeechOpen(false); speechButtonRef.current?.focus(); }}><X size={17} /></button></div>
            <label>
              <span>Browser voice</span>
              <select value={selectedVoice} onChange={(event) => setSpeechPreference((current) => ({ ...current, voiceURI: event.target.value }))}>
                <option value="">Automatic language match</option>
                {voices.map((voice) => <option value={voice.voiceURI} key={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
              </select>
            </label>
            <label>
              <span>Speed</span>
              <select value={speechPreference.rate} onChange={(event) => setSpeechPreference((current) => ({ ...current, rate: Number(event.target.value) }))}>
                {SPEECH_RATES.map((rate) => <option value={rate} key={rate}>{rate}x</option>)}
              </select>
            </label>
            <p>Speech plays only when you press a speaker button.</p>
          </div>
        ) : null}
      </section>
    </div>
  );

  return createPortal(player, portalTarget);
}
