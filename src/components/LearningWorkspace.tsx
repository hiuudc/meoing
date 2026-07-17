import {
  Bot,
  CheckCircle2,
  FileText,
  Link2,
  LoaderCircle,
  Menu,
  MessageCircle,
  Mic,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createLocalPreviewLesson } from "../learning/demoLesson";
import { LessonPlayer } from "../learning/LessonPlayer";
import { normalizeLearningProfile } from "../learning/profile";
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
  type LearningSessionState,
} from "../integration/learningSession";
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

interface CoachContext {
  question: LessonQuestion;
  evaluation: Evaluation;
}

interface RetryAttempt {
  fingerprint: string;
  operationId: string;
  failed: boolean;
}

const INITIAL_STATUS = "Meoi sends requests to ChatGPT Web and keeps accepted results only in this browser tab.";

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
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [customRequest, setCustomRequest] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [transcript, setTranscript] = useState("");
  const [sourceRequest, setSourceRequest] = useState("");
  const [coachContext, setCoachContext] = useState<CoachContext | null>(null);
  const [coachDraft, setCoachDraft] = useState("");
  const [coachReply, setCoachReply] = useState("");
  const activeAbortRef = useRef<AbortController | null>(null);
  const retryAttemptsRef = useRef<Partial<Record<ChatOperationKind, RetryAttempt>>>({});

  const lesson = unit ? session.lessonsByUnit[unit.id] : undefined;
  const embedUrl = youtubeUrl ? youtubeNoCookieEmbedUrl(youtubeUrl) : null;
  const currentProgress = lesson ? session.progressByLesson[lesson.id] : undefined;

  useEffect(() => () => activeAbortRef.current?.abort(), []);

  useEffect(() => {
    activeAbortRef.current?.abort();
    retryAttemptsRef.current = {};
    setBusy(false);
    setStatus(INITIAL_STATUS);
    setCustomRequest("");
    setYoutubeUrl("");
    setTranscript("");
    setSourceRequest("");
    setCoachContext(null);
    setCoachDraft("");
    setCoachReply("");
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

  function currentUnitContext() {
    if (!unit) throw new Error("Select a unit first.");
    const summary = session.unitSummaries[unit.id];
    return buildUnitContext(collection, unit, documents, studyItems, profile, currentProgress, summary?.commonErrors ?? []);
  }

  function currentExpectation(): OperationExpectation {
    if (!unit) throw new Error("Select a unit first.");
    const targetLanguage = profile.targetLanguage.trim();
    if (!targetLanguage) throw new Error("Enter a target language in the learning profile.");
    if (targetLanguage.length > 100) throw new Error("The target language name must be 100 characters or fewer.");
    return {
      unitId: unit.id,
      targetLanguage,
      level: profile.level,
      questionCount: profile.lessonQuestionCount,
      speaking: profile.speakingEnabled,
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
      setSession((current) => putSessionLesson(current, parsedLesson));
      await extensionBridge.acknowledgeOperation(result.operationId).catch(() => false);
      setStatus("Lesson received from ChatGPT. It is temporary and has not been saved to localStorage or a database.");
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
  }

  async function askCoach(message?: string, context = coachContext) {
    if (!unit || !lesson || !context) return;
    const text = message?.trim() || "Explain this mistake in another way and give me a fresh example without revealing the answer to my next retry.";
    if (textByteLength(text) > MEOI_TEXT_FIELD_MAX_BYTES) {
      setError("The coaching message must be 16 KiB or smaller.");
      return;
    }
    setBusy(true);
    setError("");
    setWarning("");
    try {
      const result = await sendOperation("coaching", {
        unit: { id: unit.id, name: unit.name },
        collection: { id: collection.id, name: collection.name, learningProfile: profile },
        lesson: { id: lesson.id, title: lesson.title },
        question: context.question,
        evaluation: context.evaluation,
        message: text,
      });
      const reply = result.result?.coachingReply?.trim();
      if (result.outcome !== "completed" || !reply || textByteLength(reply) > MEOI_TEXT_FIELD_MAX_BYTES) {
        throw new Error("ChatGPT did not return a valid coaching reply.");
      }
      setCoachReply(reply);
      setCoachDraft("");
      await extensionBridge.acknowledgeOperation(result.operationId).catch(() => false);
      setStatus("Coaching reply received from ChatGPT and loaded in Meoi.");
    } catch (caught) {
      if (!isAbortError(caught)) setError(publicError(caught));
    } finally {
      setBusy(false);
    }
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
    setSession((current) => putSessionLesson(current, createLocalPreviewLesson(unit.id, cleanUnitName(unit.name), profile)));
    setStatus("Local player demo loaded. It uses fixed English sample content and does not represent this unit's generated lesson.");
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

        <div className="content-scroll learning-scroll">
          <section className="learn-hero">
            <div>
              <p className="section-kicker">ChatGPT lesson studio</p>
              <h1>{unit ? cleanUnitName(unit.name) : "Select a unit"}</h1>
              <p>Meoi Bridge sends this unit's learning material to ChatGPT Web and returns validated JSON. It does not use an API, MCP, OAuth, Worker, or database, and results disappear when this page reloads.</p>
            </div>
            <div className="learn-hero-actions">
              <button className="secondary-button" type="button" onClick={usePreviewLesson} disabled={!unit}><Play size={16} /> Player demo</button>
              <button className="primary-button" type="button" onClick={() => void createLesson()} disabled={!unit || busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} Create lesson
              </button>
            </div>
          </section>

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
            {sourceRequest ? (
              <button className="primary-button" type="button" onClick={() => void createLesson()} disabled={!transcript.trim() || busy}><Send size={16} /> Send source and try again</button>
            ) : null}
          </section>

          {error ? <div className="learning-alert is-error" role="alert">{error}</div> : null}
          {warning ? <div className="learning-alert is-warning" role="status">{warning}</div> : null}
          <div className="learning-alert" aria-live="polite">{busy ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />} {status}</div>

          {lesson ? (
            <LessonPlayer
              lesson={lesson}
              onEvaluate={evaluateAnswer}
              onProgressBatch={saveProgress}
              onAskCoach={(question, evaluation) => {
                const context = { question, evaluation };
                setCoachContext(context);
                setCoachReply("");
                void askCoach(undefined, context);
              }}
            />
          ) : (
            <section className="learning-empty-state">
              <span><Bot size={28} /></span>
              <h2>No lesson for this unit yet</h2>
              <p>Open the fixed player demo, or enable Meoi Bridge and ask ChatGPT to create a lesson from this unit's material.</p>
            </section>
          )}
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
          <p className="quota-note">The extension keeps queued prompts and validated results only in browser session storage so its service worker can sleep safely. Meoi removes each result after using it.</p>
        </section>

        <ProfileEditor profile={profile} onChange={onUpdateProfile} />

        {coachContext ? (
          <section className="control-section coaching-panel">
            <h3><MessageCircle size={15} /> Coaching</h3>
            {coachReply ? <p className="coach-reply" aria-live="polite">{coachReply}</p> : <p className="control-copy">Sending a coaching request to ChatGPT Web...</p>}
            <label className="form-field">
              <span>Ask about this mistake</span>
              <textarea rows={3} value={coachDraft} onChange={(event) => setCoachDraft(event.target.value)} />
            </label>
            <button className="secondary-button wide-button" type="button" onClick={() => void askCoach(coachDraft)} disabled={!coachDraft.trim() || busy}><Send size={15} /> Send to ChatGPT</button>
          </section>
        ) : null}

        <section className="control-section voice-controls">
          <h3><Mic size={15} /> Live speaking</h3>
          <button className="secondary-button wide-button" type="button" disabled={!unit || !extensionConnected} onClick={() => void extensionBridge.send("OPEN_VOICE", { unitId: unit?.id })}><Mic size={15} /> Open Voice for this unit</button>
          <p className="quota-note">Meoi only opens the unit's conversation for Voice. Voice syncing and audio upload remain disabled because this mode does not save data.</p>
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
