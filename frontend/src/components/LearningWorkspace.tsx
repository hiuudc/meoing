import {
  ArrowLeft,
  BookOpen,
  Bot,
  CheckCircle2,
  FileText,
  History,
  Link2,
  LoaderCircle,
  Menu,
  Mic,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createLocalPreviewLesson } from "../learning/demoLesson";
import { LessonPlayer, type CoachChatMessage } from "../learning/LessonPlayer";
import { normalizeLearningProfile } from "../learning/profile";
import {
  buildQuestionGenerationConstraints,
  decorateLessonPresentation,
  getEffectiveUnitQuestionSettings,
  validateUnitQuestionSettings,
} from "../learning/questionSettings";
import { parseEvaluation, parseLesson } from "../learning/schema";
import type {
  AttemptRecord,
  Evaluation,
  LearningProfile,
  LessonProgressSnapshot,
  LessonQuestion,
  QuestionAnswer,
  SpeakingSubmission,
} from "../learning/types";
import { ExtensionBridgeError, extensionBridge } from "../integration/extensionBridge";
import {
  createLearningSession,
  putSessionLesson,
  putSessionProgress,
  removeSessionLesson,
  type LearningSessionState,
} from "../integration/learningSession";
import {
  loadLocalLearningCache,
  putStoredLesson,
  putStoredLessonProgress,
  removeStoredLesson,
  saveLocalLearningCache,
  type LocalLearningCache,
  type StoredLessonEntry,
} from "../integration/learningStorage";
import {
  buildOperationPrompt,
  MEOI_TEXT_FIELD_MAX_BYTES,
  MEOI_TRANSCRIPT_MAX_BYTES,
  type ChatOperationKind,
  type ChatOperationResult,
  type ChatOperationState,
  type OperationExpectation,
} from "../integration/protocol";
import { buildUnitContext } from "../integration/unitContext";
import { isAllowedTranscriptFile, youtubeNoCookieEmbedUrl } from "../integration/youtube";
import type { Collection, Document, StudyItem, Unit } from "../types";
import { cleanUnitName } from "../unit";
import { WorkspaceModeSwitch, type WorkspaceMode } from "./WorkspaceModeSwitch";

interface LearningWorkspaceProps {
  collection: Collection;
  unit?: Unit;
  documents: Document[];
  studyItems: StudyItem[];
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  onOpenMobileNavigation: () => void;
  onUpdateProfile: (profile: LearningProfile) => void;
}

interface RetryAttempt {
  fingerprint: string;
  operationId: string;
  failed: boolean;
}

type LearningView = "choose" | "new" | "lesson";

interface UnitLearningView {
  unitId?: string;
  view: LearningView;
  playerRunId: string;
}

interface SavedLessonChooserProps {
  entries: StoredLessonEntry[];
  onCreateNew: () => void;
  onDelete: (entry: StoredLessonEntry) => void;
  onReview: (entry: StoredLessonEntry) => void;
}

const INITIAL_STATUS = "Meoi keeps up to five validated lessons per unit in this browser. ChatGPT requests still use this unit's linked conversation.";
const LESSON_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function defaultLearningView(unitId: string | undefined, cache: LocalLearningCache): LearningView {
  return unitId && cache.lessonsByUnit[unitId]?.length ? "choose" : "new";
}

function formatLessonDate(value: string): string {
  return LESSON_DATE_FORMATTER.format(new Date(value));
}

function operationPhaseStatus(state: ChatOperationState): string {
  switch (state.phase) {
    case "queued": return state.error?.code === "CHATGPT_LIMIT_REACHED" ? "The queue is paused because ChatGPT reached its quota." : "Request queued in Meoi Bridge...";
    case "opening_chat": return "Opening this unit's ChatGPT conversation...";
    case "sending": return "Sending the request to ChatGPT...";
    case "awaiting_response": return "Waiting for ChatGPT's complete response...";
    case "repairing_response": return `Repairing the response format ${state.repairAttempt}/3...`;
    case "completed": return "ChatGPT returned a validated result. Loading it in Meoi...";
    case "failed": return state.error?.message ?? "Meoi Bridge could not read a valid ChatGPT result.";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : "This action could not be completed right now.";
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function speakingMetadata(speaking?: SpeakingSubmission | null) {
  if (!speaking) return undefined;
  return {
    transcript: speaking.transcript,
    durationMs: speaking.durationMs,
    wordsPerMinute: speaking.wordsPerMinute,
    pauseCount: speaking.pauseCount,
    pronunciationAvailable: false,
  };
}

function SavedLessonChooser({ entries, onCreateNew, onDelete, onReview }: SavedLessonChooserProps) {
  return (
    <section className="saved-lessons" aria-labelledby="saved-lessons-title">
      <div className="saved-lessons-heading">
        <div>
          <p className="section-kicker">Local lesson history</p>
          <h2 id="saved-lessons-title">Start a new lesson or review an older one</h2>
          <p>These validated lessons are stored only in this browser. Reviewing always starts again from question one.</p>
        </div>
        <button className="primary-button" type="button" onClick={onCreateNew}>
          <Sparkles size={16} /> New lesson
        </button>
      </div>
      <ul className="saved-lesson-grid">
        {entries.map((entry) => (
          <li key={entry.lesson.id}>
            <article className="saved-lesson-card">
              <div className="saved-lesson-card-topline">
                <span><BookOpen size={14} /> Saved locally</span>
                <time dateTime={entry.savedAt}>{formatLessonDate(entry.savedAt)}</time>
              </div>
              <h3>{entry.lesson.title}</h3>
              <p>{entry.lesson.summary}</p>
              <dl>
                <div><dt>Level</dt><dd>{entry.lesson.targetLanguage} · {entry.lesson.level}</dd></div>
                <div><dt>Questions</dt><dd>{entry.lesson.questions.length}</dd></div>
                <div><dt>Latest mastery</dt><dd>{entry.progress ? `${Math.round(entry.progress.masteryPercent)}%` : "Not studied"}</dd></div>
              </dl>
              <div className="saved-lesson-card-actions">
                <button className="secondary-button" type="button" onClick={() => onReview(entry)}>
                  <Play size={15} /> Review from the start
                </button>
                <button
                  className="saved-lesson-delete-button"
                  type="button"
                  aria-label={`Delete saved lesson ${entry.lesson.title}`}
                  title="Delete saved lesson"
                  onClick={() => onDelete(entry)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LearningWorkspace({
  collection,
  unit,
  documents,
  studyItems,
  mode,
  onModeChange,
  onOpenMobileNavigation,
  onUpdateProfile,
}: LearningWorkspaceProps) {
  const profile = useMemo(() => normalizeLearningProfile(collection.learningProfile), [collection.learningProfile]);
  const [session, setSession] = useState<LearningSessionState>(() => createLearningSession());
  const [learningCache, setLearningCache] = useState<LocalLearningCache>(() => loadLocalLearningCache(window.localStorage));
  const [unitView, setUnitView] = useState<UnitLearningView>({
    view: "new",
    playerRunId: "inactive",
  });
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [customRequest, setCustomRequest] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [transcript, setTranscript] = useState("");
  const [sourceRequest, setSourceRequest] = useState("");
  const activeAbortRef = useRef<AbortController | null>(null);
  const retryAttemptsRef = useRef<Partial<Record<ChatOperationKind, RetryAttempt>>>({});
  const learningCacheRef = useRef(learningCache);
  const learningScrollRef = useRef<HTMLDivElement>(null);

  const lesson = unit ? session.lessonsByUnit[unit.id] : undefined;
  const savedLessons = unit ? learningCache.lessonsByUnit[unit.id] ?? [] : [];
  const learningView = unitView.unitId === unit?.id
    ? unitView.view
    : defaultLearningView(unit?.id, learningCache);
  const playerRunId = unitView.unitId === unit?.id ? unitView.playerRunId : "inactive";
  const embedUrl = youtubeUrl ? youtubeNoCookieEmbedUrl(youtubeUrl) : null;
  const currentProgress = lesson ? session.progressByLesson[lesson.id] : undefined;

  useEffect(() => () => activeAbortRef.current?.abort(), []);

  useEffect(() => {
    activeAbortRef.current?.abort();
    learningScrollRef.current?.scrollTo({ top: 0 });
    retryAttemptsRef.current = {};
    setBusy(false);
    setStatus(INITIAL_STATUS);
    setCustomRequest("");
    setYoutubeUrl("");
    setTranscript("");
    setSourceRequest("");
    setError("");
    setWarning("");
  }, [unit?.id]);

  useEffect(() => {
    let active = true;
    void extensionBridge.getStatus(unit?.id).then((integration) => {
      if (active) setExtensionConnected(integration.installed);
    }).catch(() => {
      if (active) setExtensionConnected(false);
    });
    return () => { active = false; };
  }, [unit?.id]);

  async function refreshConnection() {
    setBusy(true);
    setError("");
    try {
      const integration = await extensionBridge.getStatus(unit?.id);
      setExtensionConnected(integration.installed);
      setStatus("Meoi Bridge is ready. It uses ChatGPT Web directly, with no API, MCP, OAuth, Worker, or database.");
    } catch (caught) {
      setExtensionConnected(false);
      setError(publicError(caught));
    } finally {
      setBusy(false);
    }
  }

  function commitLearningCache(next: LocalLearningCache): boolean {
    const saved = saveLocalLearningCache(next, window.localStorage);
    if (saved) {
      learningCacheRef.current = next;
      setLearningCache(next);
    }
    return saved;
  }

  function resetLessonPanels() {
    setError("");
    setWarning("");
  }

  function setLearningView(nextView: UnitLearningView) {
    learningScrollRef.current?.scrollTo({ top: 0 });
    setUnitView(nextView);
  }

  function startLesson(nextLesson: StoredLessonEntry["lesson"], nextStatus: string) {
    if (!unit || nextLesson.unitId !== unit.id) return;
    setSession((current) => putSessionLesson(current, nextLesson));
    setLearningView({ unitId: unit.id, view: "lesson", playerRunId: crypto.randomUUID() });
    resetLessonPanels();
    setStatus(nextStatus);
  }

  function openNewLesson() {
    if (!unit) return;
    setLearningView({ unitId: unit.id, view: "new", playerRunId: unitView.playerRunId });
    setCustomRequest("");
    setYoutubeUrl("");
    setTranscript("");
    setSourceRequest("");
    resetLessonPanels();
    setStatus("Describe the lesson you want, then send it to this unit's linked ChatGPT conversation.");
  }

  function openSavedLessons() {
    if (!unit || !savedLessons.length) return;
    setLearningView({ unitId: unit.id, view: "choose", playerRunId: unitView.playerRunId });
    resetLessonPanels();
    setStatus(`${savedLessons.length} saved ${savedLessons.length === 1 ? "lesson is" : "lessons are"} available for this unit.`);
  }

  function reviewStoredLesson(entry: StoredLessonEntry) {
    startLesson(entry.lesson, `Reviewing “${entry.lesson.title}” from question one. Saved progress is shown only as a summary.`);
  }

  function deleteStoredLesson(entry: StoredLessonEntry) {
    if (!unit || entry.lesson.unitId !== unit.id) return;
    if (!window.confirm(`Delete saved lesson "${entry.lesson.title}"? This cannot be undone.`)) return;

    setError("");
    setWarning("");
    const nextCache = removeStoredLesson(learningCacheRef.current, unit.id, entry.lesson.id);
    if (nextCache === learningCacheRef.current) return;
    if (!commitLearningCache(nextCache)) {
      setError("The browser could not delete this saved lesson. Its local history was left unchanged.");
      return;
    }

    setSession((current) => removeSessionLesson(current, unit.id, entry.lesson.id));
    const remaining = nextCache.lessonsByUnit[unit.id] ?? [];
    if (!remaining.length) {
      setLearningView({ unitId: unit.id, view: "new", playerRunId: unitView.playerRunId });
    }
    setStatus(`Deleted saved lesson "${entry.lesson.title}".`);
  }

  function currentUnitContext() {
    if (!unit) throw new Error("Select a unit first.");
    const summary = session.unitSummaries[unit.id];
    const mostRecentProgress = currentProgress ?? savedLessons.find((entry) => entry.progress)?.progress;
    return buildUnitContext(collection, unit, documents, studyItems, profile, mostRecentProgress, summary?.commonErrors ?? []);
  }

  function currentExpectation(): OperationExpectation {
    if (!unit) throw new Error("Select a unit first.");
    const targetLanguage = profile.targetLanguage.trim();
    if (!targetLanguage) throw new Error("Enter a target language in the learning profile.");
    if (targetLanguage.length > 100) throw new Error("The target language name must be 100 characters or fewer.");
    const constraints = buildQuestionGenerationConstraints(unit.questionSettings, profile);
    return {
      unitId: unit.id,
      targetLanguage,
      level: profile.level,
      questionCount: profile.lessonQuestionCount,
      speaking: profile.speakingEnabled,
      ...constraints,
    };
  }

  async function sendOperation(kind: ChatOperationKind, input: unknown): Promise<ChatOperationResult> {
    if (!unit) throw new Error("Select a unit first.");
    const expectation = currentExpectation();
    const fingerprint = JSON.stringify({ unitId: unit.id, kind, expectation, input });
    const previous = retryAttemptsRef.current[kind];
    const retrying = Boolean(previous?.failed && previous.fingerprint === fingerprint);
    const operationId = retrying && previous ? previous.operationId : crypto.randomUUID();
    const prompt = buildOperationPrompt({ operationId, kind, expectation, input });
    retryAttemptsRef.current[kind] = { fingerprint, operationId, failed: false };

    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;
    try {
      const options = { signal: controller.signal, onState: (state: ChatOperationState) => setStatus(operationPhaseStatus(state)) };
      const state = retrying
        ? await extensionBridge.retryAndWait(operationId, options)
        : await extensionBridge.dispatchAndWait({ unitId: unit.id, operationId, kind, prompt, expectation }, options);
      setExtensionConnected(true);
      delete retryAttemptsRef.current[kind];
      if (!state.result) throw new Error("The extension completed without a ChatGPT result.");
      if (state.result.outcome === "failed") {
        await extensionBridge.acknowledgeOperation(operationId).catch(() => false);
        throw new Error(state.result.error?.message ?? "ChatGPT could not complete this request.");
      }
      return state.result;
    } catch (caught) {
      if (!isAbortError(caught) && caught instanceof ExtensionBridgeError && caught.state?.phase === "failed") {
        retryAttemptsRef.current[kind] = { fingerprint, operationId, failed: true };
      }
      throw caught;
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null;
    }
  }

  async function createLesson() {
    if (!unit) return;
    const questionSettingsErrors = validateUnitQuestionSettings(
      getEffectiveUnitQuestionSettings(unit.questionSettings, profile),
      profile,
    );
    if (questionSettingsErrors.length) {
      setError(`Update this unit's question settings before generating a lesson: ${questionSettingsErrors.join(" ")}`);
      return;
    }
    if (youtubeUrl && !embedUrl) {
      setError("Enter a valid YouTube URL.");
      return;
    }
    if (textByteLength(customRequest) > MEOI_TEXT_FIELD_MAX_BYTES) {
      setError("The lesson request must be 16 KiB or smaller.");
      return;
    }
    if (textByteLength(transcript) > MEOI_TRANSCRIPT_MAX_BYTES) {
      setError("The transcript or notes must be 500 KiB or smaller.");
      return;
    }
    setBusy(true);
    setError("");
    setWarning("");
    setSourceRequest("");
    try {
      const result = await sendOperation("create_lesson", {
        context: currentUnitContext(),
        request: {
          unitId: unit.id,
          customRequest: customRequest.trim() || unit.instructionOverride?.trim() || "Create a varied lesson from this unit's learning material.",
          youtubeUrl: youtubeUrl.trim() || undefined,
          transcript: transcript.trim() || undefined,
        },
      });
      if (result.outcome === "needs_source") {
        const request = result.result?.sourceRequest ?? "Add a transcript or notes to continue.";
        setSourceRequest(request);
        await extensionBridge.acknowledgeOperation(result.operationId).catch(() => false);
        setStatus(request);
        return;
      }
      if (result.outcome !== "completed" || !result.result?.lesson) throw new Error("ChatGPT did not return a valid lesson.");
      const parsedLesson = parseLesson(result.result.lesson);
      if (parsedLesson.unitId !== unit.id) throw new Error("The returned lesson does not match the active unit.");
      const preparedLesson = decorateLessonPresentation(parsedLesson, unit.questionSettings, profile);
      const nextCache = putStoredLesson(learningCacheRef.current, preparedLesson);
      const stored = commitLearningCache(nextCache);
      startLesson(
        preparedLesson,
        stored
          ? "Lesson received from ChatGPT and saved locally in this browser."
          : "Lesson received from ChatGPT and loaded for this session.",
      );
      if (!stored) {
        setWarning("This lesson is available now, but the browser could not save it to localStorage. Existing saved lessons were not removed.");
      }
      await extensionBridge.acknowledgeOperation(result.operationId).catch(() => false);
    } catch (caught) {
      if (!isAbortError(caught)) setError(publicError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function evaluateAnswer(question: LessonQuestion, answer: QuestionAnswer, speaking?: SpeakingSubmission | null): Promise<Evaluation> {
    if (!unit || !lesson) throw new Error("No active lesson was found.");
    const metadata = speakingMetadata(speaking);
    setWarning(speaking?.audio ? "Audio remains in this browser. Meoi sends only the transcript and timing metadata for content feedback." : "");
    const result = await sendOperation("evaluate_answer", {
      unit: { id: unit.id, name: unit.name },
      collection: { id: collection.id, name: collection.name, learningProfile: profile },
      lesson: { id: lesson.id, title: lesson.title, targetLanguage: lesson.targetLanguage, level: lesson.level },
      question,
      answer,
      speaking: metadata,
    });
    if (result.outcome !== "completed" || !result.result?.evaluation) throw new Error("ChatGPT did not return a valid evaluation.");
    const evaluation = parseEvaluation(result.result.evaluation);
    const normalized = metadata && !metadata.pronunciationAvailable
      ? { ...evaluation, pronunciationAssessed: false }
      : evaluation;
    await extensionBridge.acknowledgeOperation(result.operationId).catch(() => false);
    setStatus("Evaluation received from ChatGPT and loaded in Meoi.");
    return normalized;
  }

  async function saveProgress(attempts: AttemptRecord[], snapshot: LessonProgressSnapshot) {
    void attempts;
    setSession((current) => putSessionProgress(current, snapshot));
    if (!unit) return;
    const nextCache = putStoredLessonProgress(learningCacheRef.current, unit.id, snapshot);
    if (nextCache === learningCacheRef.current) return;
    if (!commitLearningCache(nextCache)) {
      setWarning("Your latest progress is available in this tab, but the browser could not update its local lesson history.");
    }
  }

  async function askCoach(
    question: LessonQuestion,
    evaluation: Evaluation,
    message: string,
    history: CoachChatMessage[],
  ): Promise<string> {
    if (!unit || !lesson) throw new Error("No active lesson was found.");
    if (!extensionConnected) throw new Error("Meoi Bridge is offline. Check the extension and try again.");
    const text = message.trim();
    if (textByteLength(text) > MEOI_TEXT_FIELD_MAX_BYTES) {
      throw new Error("The coaching message must be 16 KiB or smaller.");
    }
    const recentHistory = history.slice(-8).map((entry) => ({
      role: entry.role,
      content: entry.content.slice(0, 2_000),
    }));
    const result = await sendOperation("coaching", {
      unit: { id: unit.id, name: unit.name },
      collection: { id: collection.id, name: collection.name, learningProfile: profile },
      lesson: { id: lesson.id, title: lesson.title },
      question,
      evaluation,
      message: text,
      history: recentHistory,
    });
    const reply = result.result?.coachingReply?.trim();
    if (result.outcome !== "completed" || !reply || textByteLength(reply) > MEOI_TEXT_FIELD_MAX_BYTES) {
      throw new Error("ChatGPT did not return a valid coaching reply.");
    }
    await extensionBridge.acknowledgeOperation(result.operationId).catch(() => false);
    setStatus("Coaching reply received from ChatGPT and loaded in Meoi.");
    return reply;
  }

  async function handleTranscriptFile(file?: File) {
    if (!file) return;
    if (!isAllowedTranscriptFile(file)) {
      setError("Transcript files must be .srt, .vtt, or .txt and no larger than 500 KiB.");
      return;
    }
    setTranscript(await file.text());
    setError("");
  }

  function usePreviewLesson() {
    if (!unit) return;
    startLesson(
      createLocalPreviewLesson(unit.id, cleanUnitName(unit.name), profile),
      "Local player demo loaded. It is not part of this unit's saved lesson history.",
    );
  }

  return (
    <>
      <main className="workspace-main learning-workspace">
        <header className="main-topbar learning-topbar">
          <button className="mobile-nav-trigger" type="button" onClick={onOpenMobileNavigation} aria-label="Open navigation"><Menu size={19} /></button>
          <WorkspaceModeSwitch mode={mode} onChange={onModeChange} />
          <div className="learning-connection-pill" data-connected={extensionConnected ? "true" : "false"}>
            <span /> {extensionConnected ? "ChatGPT bridge" : "Extension offline"}
          </div>
        </header>

        <div className="content-scroll learning-scroll" ref={learningScrollRef}>
          <section className="learn-hero">
            <div>
              <p className="section-kicker">ChatGPT lesson studio</p>
              <h1>{unit ? cleanUnitName(unit.name) : "Select a unit"}</h1>
              <p>Meoi Bridge sends this unit's learning material to ChatGPT Web and stores up to five validated lessons locally in this browser. It does not use an API, MCP, OAuth, Worker, or database.</p>
            </div>
            <div className="learn-hero-actions">
              {savedLessons.length && learningView !== "choose" ? (
                <button className="secondary-button" type="button" onClick={openSavedLessons} disabled={busy}>
                  <History size={16} /> Saved lessons
                </button>
              ) : null}
              {learningView === "lesson" ? (
                <button className="primary-button" type="button" onClick={openNewLesson} disabled={!unit || busy}>
                  <Sparkles size={16} /> New lesson
                </button>
              ) : null}
            </div>
          </section>

          {!unit ? (
            <section className="learning-empty-state">
              <span><Bot size={28} /></span>
              <h2>Select a unit first</h2>
              <p>Choose a unit from the navigation before creating or reviewing a lesson.</p>
            </section>
          ) : learningView === "choose" ? (
            <SavedLessonChooser
              entries={savedLessons}
              onCreateNew={openNewLesson}
              onDelete={deleteStoredLesson}
              onReview={reviewStoredLesson}
            />
          ) : learningView === "new" ? (
          <section className="lesson-request-card" aria-labelledby="lesson-request-title">
            <div className="card-heading-row">
              <div><p className="section-kicker">Custom request</p><h2 id="lesson-request-title">What do you want to learn?</h2></div>
              <span>{profile.lessonQuestionCount} questions · at least 5 formats</span>
            </div>
            <label className="form-field">
              <span>Lesson request</span>
              <textarea rows={3} value={customRequest} onChange={(event) => setCustomRequest(event.target.value)} placeholder="Example: practise introducing myself in a job interview, with an emphasis on speaking." />
            </label>
            <div className="source-input-grid">
              <label className="form-field">
                <span><Link2 size={14} /> YouTube URL</span>
                <input type="url" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." />
                {youtubeUrl && !embedUrl ? <small className="field-error">Enter a valid YouTube URL.</small> : null}
              </label>
              <label className="transcript-upload">
                <Upload size={16} /> Upload transcript
                <input className="sr-only" type="file" accept=".srt,.vtt,.txt,text/plain" onChange={(event) => void handleTranscriptFile(event.target.files?.[0])} />
                <small>.srt / .vtt / .txt · up to 500 KiB</small>
              </label>
            </div>
            {embedUrl ? <div className="youtube-preview"><iframe src={embedUrl} title="YouTube lesson source" allow="accelerometer; encrypted-media; picture-in-picture" allowFullScreen /></div> : null}
            <label className="form-field">
              <span>Transcript or notes</span>
              <textarea rows={4} value={transcript} onChange={(event) => setTranscript(event.target.value)} placeholder="No captions? Paste a transcript or notes here. Meoi will not infer source content from a title or thumbnail." />
            </label>
            <div className="lesson-form-actions">
              {savedLessons.length ? (
                <button className="secondary-button" type="button" onClick={openSavedLessons} disabled={busy}>
                  <ArrowLeft size={16} /> Saved lessons
                </button>
              ) : null}
              <button className="secondary-button" type="button" onClick={usePreviewLesson} disabled={busy}>
                <Play size={16} /> Player demo
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void createLesson()}
                disabled={busy || Boolean(sourceRequest && !transcript.trim())}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                {sourceRequest ? "Send source and try again" : "Create lesson"}
              </button>
            </div>
          </section>
          ) : null}

          {error ? <div className="learning-alert is-error" role="alert">{error}</div> : null}
          {warning ? <div className="learning-alert is-warning" role="status">{warning}</div> : null}
          <div className="learning-alert" aria-live="polite">{busy ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />} {status}</div>

          {learningView === "lesson" && lesson ? (
            <LessonPlayer
              key={`${lesson.id}-${playerRunId}`}
              lesson={lesson}
              coachingAvailable={extensionConnected}
              onEvaluate={evaluateAnswer}
              onProgressBatch={saveProgress}
              onAskCoach={askCoach}
              onExit={() => {
                setLearningView({
                  unitId: unit!.id,
                  view: savedLessons.length ? "choose" : "new",
                  playerRunId,
                });
                setStatus("Lesson closed after saving the latest local progress.");
              }}
            />
          ) : learningView === "lesson" ? (
            <section className="learning-empty-state">
              <span><Bot size={28} /></span>
              <h2>This lesson is no longer available</h2>
              <p>Return to saved lessons or create a new lesson for this unit.</p>
            </section>
          ) : null}
        </div>
      </main>

      <aside className="overview-panel learning-control-panel" aria-label="Learning and integration settings">
        <section>
          <div className="overview-title-row"><h2>ChatGPT Web</h2><ShieldCheck size={17} /></div>
          <p className="control-copy">Sign in at chatgpt.com and enable the extension. No Meoi app connection, Developer Mode, OAuth, or API key is required.</p>
          <button className="primary-button wide-button" type="button" onClick={() => void refreshConnection()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Check extension
          </button>
        </section>

        <section className="control-section">
          <h3><ShieldCheck size={15} /> Local bridge status</h3>
          <ul className="integration-checklist">
            <li data-ready="true"><span /> Website · 127.0.0.1</li>
            <li data-ready={extensionConnected ? "true" : "false"}><span /> Extension · {extensionConnected ? "ready" : "not responding"}</li>
            <li data-ready="true"><span /> API / MCP / OAuth · not used</li>
            <li data-ready="true"><span /> Database · no writes</li>
          </ul>
          <p className="quota-note">The extension keeps queued prompts and validated results in browser session storage and removes each result after use. Meoi stores only validated lessons and their latest progress in this site's local storage.</p>
        </section>

        <ProfileEditor profile={profile} onChange={onUpdateProfile} />

        <section className="control-section voice-controls">
          <h3><Mic size={15} /> Live speaking</h3>
          <button className="secondary-button wide-button" type="button" disabled={!unit || !extensionConnected} onClick={() => void extensionBridge.send("OPEN_VOICE", { unitId: unit?.id })}><Mic size={15} /> Open Voice for this unit</button>
          <p className="quota-note">Meoi only opens the unit's conversation for Voice. Voice syncing and audio upload remain disabled, and saved lesson history never includes audio or voice transcripts.</p>
        </section>
      </aside>
    </>
  );
}

function ProfileEditor({ profile, onChange }: { profile: LearningProfile; onChange: (profile: LearningProfile) => void }) {
  function update<Key extends keyof LearningProfile>(key: Key, value: LearningProfile[Key]) {
    onChange(normalizeLearningProfile({ ...profile, [key]: value }));
  }

  return (
    <section className="control-section profile-editor">
      <h3><FileText size={15} /> Learning profile</h3>
      <label className="compact-field"><span>Target language</span><input maxLength={100} value={profile.targetLanguage} onChange={(event) => update("targetLanguage", event.target.value)} /></label>
      <label className="compact-field"><span>Level</span><select value={profile.level} onChange={(event) => update("level", event.target.value as LearningProfile["level"])}>
        <option value="beginner">Beginner</option><option value="elementary">Elementary</option><option value="intermediate">Intermediate</option><option value="upperIntermediate">Upper intermediate</option><option value="advanced">Advanced</option>
      </select></label>
      <label className="compact-field"><span>Questions</span><input type="number" min={8} max={15} value={profile.lessonQuestionCount} onChange={(event) => update("lessonQuestionCount", Number(event.target.value))} /></label>
      <label className="toggle-row"><span>Include speaking</span><input type="checkbox" checked={profile.speakingEnabled} onChange={(event) => update("speakingEnabled", event.target.checked)} /></label>
    </section>
  );
}
