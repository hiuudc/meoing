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
import type { ApiClient, ApiSuccess } from "../api/client";
import {
  buildProgressBatch,
  discardProgressOutboxIssues,
  enqueueProgressBatch,
  flushProgressOutbox,
  retryProgressOutboxIssues,
  type ProgressBatchPayload,
} from "../api/progressOutbox";
import { createLocalPreviewLesson } from "../learning/demoLesson";
import { LessonPlayer, type CoachChatMessage } from "../learning/LessonPlayer";
import { normalizeLearningProfile } from "../learning/profile";
import {
  buildQuestionGenerationConstraints,
  decorateLessonPresentation,
  getEffectiveCollectionQuestionSettings,
  validateCollectionQuestionSettings,
} from "../learning/questionSettings";
import { parseEvaluation, parseLesson } from "../learning/schema";
import type {
  AttemptRecord,
  Evaluation,
  LearningProfile,
  LessonProgressSnapshot,
  LessonQuestion,
  QuestionAnswer,
  Lesson,
  SpeakingSubmission,
} from "../learning/types";
import {
  ExtensionBridgeError,
  extensionBridge,
  type ExtensionCompatibility,
} from "../integration/extensionBridge";
import {
  createLearningSession,
  putSessionLesson,
  putSessionProgress,
  removeSessionLesson,
  type LearningSessionState,
} from "../integration/learningSession";
import {
  createLocalLearningCache,
  putStoredLesson,
  putStoredLessonProgress,
  removeStoredLesson,
  type LocalLearningCache,
  type StoredLessonEntry,
} from "../integration/learningStorage";
import {
  createPendingLearningOperationStore,
  pendingLearningOperationForUnit,
  putPendingLearningOperation,
  removePendingLearningOperation,
  type PendingLearningOperation,
  type PendingLearningOperationStore,
} from "../integration/pendingLearningOperations";
import {
  buildOperationPrompt,
  MEOI_EXTENSION_MIN_VERSION,
  MEOI_EXTENSION_PROTOCOL_VERSION,
  MEOI_TEXT_FIELD_MAX_BYTES,
  MEOI_TRANSCRIPT_MAX_BYTES,
  type ChatOperationKind,
  type ChatOperationResult,
  type ChatOperationState,
  type OperationExpectation,
} from "../integration/protocol";
import { buildUnitContext } from "../integration/unitContext";
import { runWithUnitChatRecovery } from "../integration/unitChatRecovery";
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
  api?: ApiClient;
  userId?: string;
  canCreateLessons?: boolean;
  canDeleteContent?: boolean;
  canManageCollectionProfile?: boolean;
}

interface RetryAttempt {
  fingerprint: string;
  operationId: string;
  failed: boolean;
}

interface SendOperationOptions {
  beforeDispatch?: (operationId: string) => void | Promise<void>;
  retainFailedResult?: boolean;
}

type LearningView = "choose" | "new" | "lesson";
type BridgeGateState = ExtensionCompatibility | { state: "checking" };
type PendingLessonState = "idle" | "recovering" | "save_failed" | "failed" | "missing";

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
  canCreate: boolean;
  currentUserId?: string;
  canDeleteContent: boolean;
}

const INITIAL_STATUS = "Meoing syncs validated lessons and progress through its secure API. ChatGPT requests still use this unit's linked conversation.";
const LESSON_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

interface WireLesson {
  id: string;
  unitId: string;
  ownerId?: string;
  status?: "draft" | "published";
  revision?: number;
  payload?: unknown;
  createdAt?: string;
}

interface WireProgressSession {
  id: string;
}

interface WireProgressAttempt {
  questionId?: string;
  attemptNumber?: number;
  status?: string;
}

interface WireProgressHistory {
  id: string;
  lessonId: string;
  attempts?: WireProgressAttempt[];
  startedAt?: string;
  updatedAt?: string;
}

type PendingEvaluationAcks = Map<string, string[]>;

interface ProgressPersistenceDependencies {
  enqueue: typeof enqueueProgressBatch;
  acknowledge: (operationId: string) => Promise<boolean>;
}

export async function persistProgressBeforeEvaluationAck(
  userId: string,
  progressId: string,
  payload: ProgressBatchPayload,
  attempts: AttemptRecord[],
  pendingAcks: PendingEvaluationAcks,
  dependencies: ProgressPersistenceDependencies = {
    enqueue: enqueueProgressBatch,
    acknowledge: (operationId) => extensionBridge.acknowledgeOperation(operationId),
  },
): Promise<number> {
  await dependencies.enqueue(userId, progressId, payload);
  let failedAcks = 0;
  const attemptedOperationIds = new Set<string>();
  for (const attempt of attempts) {
    const queue = pendingAcks.get(attempt.questionId);
    const operationId = queue?.[0];
    if (!queue?.length || !operationId || attemptedOperationIds.has(operationId)) continue;
    attemptedOperationIds.add(operationId);
    const acknowledged = await dependencies.acknowledge(operationId).catch(() => false);
    if (!acknowledged) {
      failedAcks += 1;
      continue;
    }
    queue.shift();
    if (!queue.length) pendingAcks.delete(attempt.questionId);
  }
  return failedAcks;
}

async function fetchCursorPages<T>(
  api: ApiClient,
  path: string,
  signal: AbortSignal,
  maxItems = 500,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const cursorQuery: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const response: ApiSuccess<{ items: T[]; nextCursor?: string | null }> = await api.get(
      `${path}${separator}limit=100${cursorQuery}`,
      signal,
    );
    items.push(...response.data.items);
    const next: unknown = response.data.nextCursor ?? response.meta?.nextCursor;
    cursor = typeof next === "string" && next && !seenCursors.has(next) ? next : null;
    if (cursor) seenCursors.add(cursor);
  } while (cursor && items.length < maxItems && !signal.aborted);
  return items.slice(0, maxItems);
}

export function progressSnapshotFromWire(
  lesson: Lesson,
  progress: WireProgressHistory | undefined,
): LessonProgressSnapshot | undefined {
  if (!progress) return undefined;
  const questionIds = new Set(lesson.questions.map((question) => question.id));
  const attemptsByQuestion: Record<string, number> = {};
  const completed = new Set<string>();
  const firstTryCorrect = new Set<string>();
  for (const attempt of progress.attempts ?? []) {
    if (!attempt.questionId || !questionIds.has(attempt.questionId)) continue;
    const attemptNumber = Number.isInteger(attempt.attemptNumber) && (attempt.attemptNumber ?? 0) > 0
      ? attempt.attemptNumber!
      : (attemptsByQuestion[attempt.questionId] ?? 0) + 1;
    attemptsByQuestion[attempt.questionId] = Math.max(
      attemptsByQuestion[attempt.questionId] ?? 0,
      attemptNumber,
    );
    if (attempt.status === "correct") {
      completed.add(attempt.questionId);
      if (attemptNumber === 1) firstTryCorrect.add(attempt.questionId);
    }
  }
  return {
    lessonId: lesson.id,
    completedQuestionIds: [...completed],
    attemptsByQuestion,
    firstTryCorrect: firstTryCorrect.size,
    totalQuestions: lesson.questions.length,
    masteryPercent: lesson.questions.length
      ? Math.round((completed.size / lesson.questions.length) * 100)
      : 0,
    updatedAt: progress.updatedAt ?? progress.startedAt ?? new Date(0).toISOString(),
  };
}

function lessonFromWire(value: WireLesson): Lesson {
  const parsed = parseLesson(value.payload);
  return {
    ...parsed,
    id: value.id,
    ownerId: value.ownerId,
    status: value.status,
    revision: value.revision,
    unitId: value.unitId || parsed.unitId,
    createdAt: value.createdAt ?? parsed.createdAt,
  };
}

export function canDeleteStoredLesson(
  lesson: Pick<Lesson, "ownerId" | "status">,
  currentUserId: string | undefined,
  canDeleteContent: boolean,
): boolean {
  return canDeleteContent
    || Boolean(currentUserId && lesson.status === "draft" && lesson.ownerId === currentUserId);
}

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

export function publicLearningError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    (error instanceof ExtensionBridgeError && error.code === "EXTENSION_NOT_READY")
    || /receiving end does not exist|extension context invalidated/i.test(message)
  ) {
    return "Meoi Bridge disconnected after an extension reload. Reload this page, then check the answer again. Your current answer is still here.";
  }
  return message || "This action could not be completed right now.";
}

function publicError(error: unknown): string {
  return publicLearningError(error);
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

function SavedLessonChooser({
  entries,
  onCreateNew,
  onDelete,
  onReview,
  canCreate,
  currentUserId,
  canDeleteContent,
}: SavedLessonChooserProps) {
  return (
    <section className="saved-lessons" aria-labelledby="saved-lessons-title">
      <div className="saved-lessons-heading">
        <div>
          <p className="section-kicker">Synced lesson history</p>
          <h2 id="saved-lessons-title">Start a new lesson or review an older one</h2>
          <p>These validated lessons are synced securely. Reviewing creates a fresh progress session.</p>
        </div>
        {canCreate ? <button className="primary-button" type="button" onClick={onCreateNew}>
          <Sparkles size={16} /> New lesson
        </button> : null}
      </div>
      <ul className="saved-lesson-grid">
        {entries.map((entry) => {
          const canDelete = canDeleteStoredLesson(entry.lesson, currentUserId, canDeleteContent);
          return <li key={entry.lesson.id}>
            <article className="saved-lesson-card">
              <div className="saved-lesson-card-topline">
                <span><BookOpen size={14} /> Synced</span>
                <time dateTime={entry.savedAt}>{formatLessonDate(entry.savedAt)}</time>
              </div>
              <h3>{entry.lesson.title}</h3>
              <p>{entry.lesson.summary}</p>
              <dl>
                <div>
                  <dt>Level</dt>
                  <dd>
                    {entry.lesson.sourceLanguage ? `${entry.lesson.sourceLanguage} → ` : ""}
                    {entry.lesson.targetLanguage} · {entry.lesson.level}
                  </dd>
                </div>
                <div><dt>Questions</dt><dd>{entry.lesson.questions.length}</dd></div>
                <div><dt>Latest mastery</dt><dd>{entry.progress ? `${Math.round(entry.progress.masteryPercent)}%` : "Not studied"}</dd></div>
              </dl>
              <div className="saved-lesson-card-actions">
                <button className="secondary-button" type="button" onClick={() => onReview(entry)}>
                  <Play size={15} /> Review from the start
                </button>
                {canDelete ? <button
                  className="saved-lesson-delete-button"
                  type="button"
                  aria-label={`Delete saved lesson ${entry.lesson.title}`}
                  title="Delete saved lesson"
                  onClick={() => onDelete(entry)}
                >
                  <Trash2 size={16} />
                </button> : null}
              </div>
            </article>
          </li>;
        })}
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
  api,
  userId,
  canCreateLessons = true,
  canDeleteContent = false,
  canManageCollectionProfile = true,
}: LearningWorkspaceProps) {
  const profile = useMemo(() => normalizeLearningProfile(collection.learningProfile), [collection.learningProfile]);
  const [session, setSession] = useState<LearningSessionState>(() => createLearningSession());
  const [learningCache, setLearningCache] = useState<LocalLearningCache>(createLocalLearningCache);
  const [unitView, setUnitView] = useState<UnitLearningView>({
    view: "new",
    playerRunId: "inactive",
  });
  const [bridgeGate, setBridgeGate] = useState<BridgeGateState>({ state: "checking" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [outboxIssueCount, setOutboxIssueCount] = useState(0);
  const [customRequest, setCustomRequest] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [transcript, setTranscript] = useState("");
  const [sourceRequest, setSourceRequest] = useState("");
  const [pendingLessonState, setPendingLessonState] = useState<PendingLessonState>("idle");
  const activeAbortRef = useRef<AbortController | null>(null);
  const recoveryAbortRef = useRef<AbortController | null>(null);
  const retryAttemptsRef = useRef<Partial<Record<ChatOperationKind, RetryAttempt>>>({});
  const learningCacheRef = useRef(learningCache);
  const pendingOperationsRef = useRef<PendingLearningOperationStore>(createPendingLearningOperationStore());
  const pendingEvaluationAcksRef = useRef<PendingEvaluationAcks>(new Map());
  const progressSessionIdRef = useRef<string | null>(null);
  const learningScrollRef = useRef<HTMLDivElement>(null);

  const lesson = unit ? session.lessonsByUnit[unit.id] : undefined;
  const savedLessons = unit ? learningCache.lessonsByUnit[unit.id] ?? [] : [];
  const learningView = unitView.unitId === unit?.id
    ? unitView.view
    : defaultLearningView(unit?.id, learningCache);
  const playerRunId = unitView.unitId === unit?.id ? unitView.playerRunId : "inactive";
  const embedUrl = youtubeUrl ? youtubeNoCookieEmbedUrl(youtubeUrl) : null;
  const currentProgress = lesson ? session.progressByLesson[lesson.id] : undefined;
  const extensionConnected = bridgeGate.state === "ready";

  useEffect(() => () => {
    activeAbortRef.current?.abort();
    recoveryAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    activeAbortRef.current?.abort();
    recoveryAbortRef.current?.abort();
    progressSessionIdRef.current = null;
    learningScrollRef.current?.scrollTo({ top: 0 });
    retryAttemptsRef.current = {};
    pendingEvaluationAcksRef.current.clear();
    setBusy(false);
    setStatus(INITIAL_STATUS);
    setCustomRequest("");
    setYoutubeUrl("");
    setTranscript("");
    setSourceRequest("");
    setPendingLessonState("idle");
    setError("");
    setWarning("");
  }, [unit?.id]);

  useEffect(() => {
    let active = true;
    setBridgeGate({ state: "checking" });
    void extensionBridge.detectCompatibility(unit?.id).then((compatibility) => {
      if (active) setBridgeGate(compatibility);
    });
    return () => { active = false; };
  }, [unit?.id]);

  useEffect(() => {
    if (!api || !unit) {
      const empty = createLocalLearningCache();
      learningCacheRef.current = empty;
      setLearningCache(empty);
      return;
    }
    const controller = new AbortController();
    void Promise.all([
      fetchCursorPages<WireLesson>(
        api,
        `/v1/lessons?unitId=${encodeURIComponent(unit.id)}`,
        controller.signal,
      ),
      fetchCursorPages<WireProgressHistory>(
        api,
        `/v1/progress?collectionId=${encodeURIComponent(collection.id)}`,
        controller.signal,
      ),
    ])
      .then(async ([lessonItems, progressItems]) => {
        const wireLessons = await Promise.all(lessonItems.map(async (item) => {
          if (item.payload) return item;
          const full = await api.get<WireLesson>(`/v1/lessons/${encodeURIComponent(item.id)}`, controller.signal);
          return full.data;
        }));
        if (controller.signal.aborted) return;
        const latestProgressSummaries = new Map<string, WireProgressHistory>();
        for (const progress of progressItems) {
          if (progress.id && progress.lessonId && !latestProgressSummaries.has(progress.lessonId)) {
            latestProgressSummaries.set(progress.lessonId, progress);
          }
        }
        const detailedProgress = await Promise.all(
          [...latestProgressSummaries.values()].map(async (progress) => {
            const detail = await api.get<WireProgressHistory>(
              `/v1/progress/${encodeURIComponent(progress.id)}`,
              controller.signal,
            );
            return { ...progress, ...detail.data };
          }),
        );
        if (controller.signal.aborted) return;
        const latestProgressByLesson = new Map(
          detailedProgress.map((progress) => [progress.lessonId, progress]),
        );
        const entries = wireLessons
          .map((wireLesson) => {
            const parsedLesson = lessonFromWire(wireLesson);
            return {
              lesson: parsedLesson,
              progress: progressSnapshotFromWire(parsedLesson, latestProgressByLesson.get(parsedLesson.id)),
              savedAt: wireLesson.createdAt ?? new Date().toISOString(),
            };
          })
          .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
        const next: LocalLearningCache = {
          ...createLocalLearningCache(),
          lessonsByUnit: entries.length ? { [unit.id]: entries } : {},
        };
        learningCacheRef.current = next;
        setLearningCache(next);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(publicError(caught));
      });
    return () => controller.abort();
  }, [api, collection.id, unit?.id]);

  useEffect(() => {
    if (!api || !userId) return;
    const flush = () => {
      void flushProgressOutbox(api, userId)
        .then((result) => {
          setOutboxIssueCount(result.quarantined);
          if (result.retryableFailures) {
            setWarning("Progress is saved in the sync outbox and will retry when the connection recovers.");
          }
        })
        .catch(() => {
          setWarning("Progress is saved in the sync outbox and will retry when the connection recovers.");
        });
    };
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [api, userId]);

  useEffect(() => {
    if (bridgeGate.state !== "ready" || !unit) return;
    const controller = new AbortController();
    recoveryAbortRef.current?.abort();
    recoveryAbortRef.current = controller;
    void (async () => {
      const remembered = pendingLearningOperationForUnit(
        pendingOperationsRef.current,
        unit.id,
      );
      if (remembered) {
        await recoverPendingLesson(remembered, controller.signal);
        return;
      }
      try {
        const operationState = await extensionBridge.getLatestUnitOperation(unit.id, "create_lesson");
        if (controller.signal.aborted || !operationState) return;
        if (operationState.unitId !== unit.id) {
          throw new Error("Meoi Bridge returned a pending lesson operation for a different unit.");
        }
        const recovered: PendingLearningOperation = {
          operationId: operationState.operationId,
          unitId: operationState.unitId,
          kind: "create_lesson",
          createdAt: operationState.updatedAt,
        };
        rememberPendingOperation(recovered);
        await recoverPendingLesson(recovered, controller.signal, operationState);
      } catch (caught) {
        if (isAbortError(caught) || controller.signal.aborted) return;
        setError(publicError(caught));
        setStatus("Meoi could not inspect the extension for a pending lesson operation.");
      }
    })();
    return () => {
      controller.abort();
      if (recoveryAbortRef.current === controller) recoveryAbortRef.current = null;
    };
  }, [bridgeGate.state, unit?.id]);

  async function refreshConnection() {
    setBusy(true);
    setError("");
    setBridgeGate({ state: "checking" });
    try {
      const compatibility = await extensionBridge.detectCompatibility(unit?.id);
      setBridgeGate(compatibility);
      if (compatibility.state === "ready") {
        setStatus("Meoi Bridge v8 is ready. ChatGPT Web performs AI work; Meoing’s Worker stores only validated results.");
      }
    } catch (caught) {
      setBridgeGate({ state: "unavailable" });
      setError(publicError(caught));
    } finally {
      setBusy(false);
    }
  }

  function commitLearningCache(next: LocalLearningCache): boolean {
    learningCacheRef.current = next;
    setLearningCache(next);
    return true;
  }

  function pendingOperationForUnit(unitId: string): PendingLearningOperation | undefined {
    return pendingLearningOperationForUnit(pendingOperationsRef.current, unitId);
  }

  function rememberPendingOperation(operation: PendingLearningOperation): boolean {
    pendingOperationsRef.current = putPendingLearningOperation(pendingOperationsRef.current, operation);
    return true;
  }

  function forgetPendingOperation(operation: PendingLearningOperation): boolean {
    pendingOperationsRef.current = removePendingLearningOperation(
      pendingOperationsRef.current,
      operation.unitId,
      operation.operationId,
    );
    return true;
  }

  async function acknowledgeAndForgetPending(operation: PendingLearningOperation): Promise<boolean> {
    const acknowledged = await extensionBridge.acknowledgeOperation(operation.operationId).catch(() => false);
    return acknowledged && forgetPendingOperation(operation);
  }

  function showPendingFailure(message: string) {
    setPendingLessonState("failed");
    setError(message);
    setWarning("");
    setStatus("The lesson result failed validation. Create the lesson again after reviewing the error.");
  }

  async function acceptPendingLessonResult(
    operation: PendingLearningOperation,
    result: ChatOperationResult,
  ): Promise<boolean> {
    if (!unit || operation.unitId !== unit.id) return false;
    if (result.outcome === "failed") {
      showPendingFailure(result.error?.message ?? "ChatGPT could not create a valid lesson.");
      return false;
    }
    if (result.outcome === "needs_source") {
      const request = result.result?.sourceRequest ?? "Add a transcript or notes to continue.";
      setSourceRequest(request);
      setStatus(request);
      setPendingLessonState("idle");
      if (!await acknowledgeAndForgetPending(operation)) {
        setWarning("The source request was received, but Meoi Bridge could not clear its retained result yet.");
      }
      return true;
    }
    if (result.outcome !== "completed" || !result.result?.lesson) {
      showPendingFailure("ChatGPT did not return a valid lesson.");
      return false;
    }

    let preparedLesson: StoredLessonEntry["lesson"];
    try {
      const parsedLesson = parseLesson(result.result.lesson);
      if (parsedLesson.unitId !== operation.unitId) {
        throw new Error("The returned lesson does not match the unit that requested it.");
      }
      preparedLesson = decorateLessonPresentation(parsedLesson, collection.questionSettings, profile);
    } catch (caught) {
      showPendingFailure(`Meoi Bridge returned a lesson that this page could not validate: ${publicError(caught)}`);
      return false;
    }

    if (!api) {
      setPendingLessonState("save_failed");
      setError("The lesson is ready in Meoi Bridge, but the secure API is unavailable.");
      setWarning("The Bridge result was kept. Reconnect to the API, then retry saving.");
      setStatus("Lesson received but not acknowledged because cloud saving failed.");
      return false;
    }

    try {
      const saved = await api.post<WireLesson>("/v1/lessons", {
        collectionId: collection.id,
        unitId: unit.id,
        unitRevision: unit.revision ?? 1,
        status: "draft",
        schemaVersion: 8,
        title: preparedLesson.title,
        languageCode: unit.languageCode ?? preparedLesson.targetLanguage,
        payload: preparedLesson,
      }, operation.operationId);
      preparedLesson = saved.data.payload
        ? lessonFromWire(saved.data)
        : {
            ...preparedLesson,
            id: saved.data.id,
            ownerId: saved.data.ownerId,
            status: saved.data.status,
            revision: saved.data.revision,
          };
    } catch (caught) {
      setPendingLessonState("save_failed");
      setError(`The lesson is ready in Meoi Bridge, but the API could not save it: ${publicError(caught)}`);
      setWarning("The Bridge result remains unacknowledged so you can retry safely.");
      setStatus("Lesson received but cloud saving failed.");
      return false;
    }

    commitLearningCache(putStoredLesson(learningCacheRef.current, preparedLesson));
    await startLesson(preparedLesson, "Lesson received from ChatGPT and synced to Meoing.");
    setPendingLessonState("idle");
    if (!await acknowledgeAndForgetPending(operation)) {
      setWarning("The lesson is synced, but Meoi Bridge could not clear its retained result in this tab.");
    }
    return true;
  }

  async function recoverPendingLesson(
    operation: PendingLearningOperation,
    signal?: AbortSignal,
    initialState?: ChatOperationState,
  ): Promise<void> {
    if (!unit || operation.unitId !== unit.id) return;
    setBusy(true);
    setError("");
    setWarning("");
    setPendingLessonState("recovering");
    setStatus("Reconnecting to the pending lesson operation in Meoi Bridge...");
    try {
      let state = initialState ?? await extensionBridge.getOperationState(operation.operationId);
      if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
      if (state.operationId !== operation.operationId || state.unitId !== operation.unitId) {
        throw new Error("Meoi Bridge returned a different pending lesson operation.");
      }
      if (state.phase === "failed") {
        showPendingFailure(state.error?.message ?? "Meoi Bridge could not create a valid lesson.");
        return;
      }
      if (state.phase !== "completed") {
        state = await extensionBridge.waitForOperation(operation.operationId, {
          signal,
          onState: (nextState) => setStatus(operationPhaseStatus(nextState)),
        });
      }
      if (!state.result) throw new Error("The extension completed without a ChatGPT result.");
      await acceptPendingLessonResult(operation, state.result);
    } catch (caught) {
      if (isAbortError(caught)) return;
      if (caught instanceof ExtensionBridgeError && caught.code === "OPERATION_STATE_NOT_FOUND") {
        forgetPendingOperation(operation);
        setPendingLessonState("missing");
        setError("Meoi Bridge was reloaded or updated and no longer has this lesson operation. Create the lesson again.");
        setStatus("The pending operation is no longer available in the extension.");
        return;
      }
      if (caught instanceof ExtensionBridgeError && caught.state?.phase === "failed") {
        showPendingFailure(caught.state.error?.message ?? caught.message);
        return;
      }
      setError(publicError(caught));
      setStatus("Meoi could not reconnect to the pending lesson operation.");
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }

  async function discardFailedPendingOperation(operation: PendingLearningOperation): Promise<void> {
    await extensionBridge.acknowledgeOperation(operation.operationId).catch(() => false);
    forgetPendingOperation(operation);
    delete retryAttemptsRef.current.create_lesson;
    setPendingLessonState("idle");
  }

  function resetLessonPanels() {
    setError("");
    setWarning("");
  }

  function setLearningView(nextView: UnitLearningView) {
    learningScrollRef.current?.scrollTo({ top: 0 });
    setUnitView(nextView);
  }

  async function startLesson(
    nextLesson: StoredLessonEntry["lesson"],
    nextStatus: string,
    persistProgress = true,
  ) {
    if (!unit || nextLesson.unitId !== unit.id) return;
    if (persistProgress) {
      if (!api) {
        setError("The secure API is unavailable, so this lesson cannot start.");
        return;
      }
      try {
        const response = await api.post<WireProgressSession>(
          `/v1/lessons/${encodeURIComponent(nextLesson.id)}/progress`,
          {},
          crypto.randomUUID(),
        );
        progressSessionIdRef.current = response.data.id;
      } catch (caught) {
        setError(`The lesson session could not start: ${publicError(caught)}`);
        return;
      }
    } else {
      progressSessionIdRef.current = null;
    }
    setSession((current) => putSessionLesson(current, nextLesson));
    setLearningView({ unitId: unit.id, view: "lesson", playerRunId: crypto.randomUUID() });
    resetLessonPanels();
    setStatus(nextStatus);
  }

  function openNewLesson() {
    if (!unit || !canCreateLessons) return;
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
    void startLesson(entry.lesson, `Reviewing “${entry.lesson.title}” from question one. Progress will sync as a new session.`);
  }

  async function deleteStoredLesson(entry: StoredLessonEntry) {
    if (
      !unit
      || entry.lesson.unitId !== unit.id
      || !canDeleteStoredLesson(entry.lesson, userId, canDeleteContent)
    ) return;
    if (!window.confirm(`Delete saved lesson "${entry.lesson.title}"?`)) return;

    setError("");
    setWarning("");
    if (!api) {
      setError("The secure API is unavailable.");
      return;
    }
    try {
      await api.delete(`/v1/lessons/${encodeURIComponent(entry.lesson.id)}`, {
        expectedRevision: entry.lesson.revision ?? 1,
      });
    } catch (caught) {
      setError(publicError(caught));
      return;
    }
    const nextCache = removeStoredLesson(learningCacheRef.current, unit.id, entry.lesson.id);
    if (nextCache === learningCacheRef.current) return;
    commitLearningCache(nextCache);

    setSession((current) => removeSessionLesson(current, unit.id, entry.lesson.id));
    const remaining = nextCache.lessonsByUnit[unit.id] ?? [];
    if (!remaining.length) {
      setLearningView({ unitId: unit.id, view: "new", playerRunId: unitView.playerRunId });
    }
    setStatus(`Deleted lesson "${entry.lesson.title}".`);
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
    const constraints = buildQuestionGenerationConstraints(collection.questionSettings, profile);
    return {
      unitId: unit.id,
      targetLanguage,
      sourceLanguage: profile.sourceLanguage,
      level: profile.level,
      questionCount: profile.lessonQuestionCount,
      speaking: profile.speakingEnabled,
      ...constraints,
    };
  }

  async function sendOperation(
    kind: ChatOperationKind,
    input: unknown,
    operationOptions: SendOperationOptions = {},
  ): Promise<ChatOperationResult> {
    if (!unit) throw new Error("Select a unit first.");
    if (bridgeGate.state !== "ready") throw new Error("Meoi Bridge v8 is required before Learn can run.");
    const expectation = currentExpectation();
    const fingerprint = JSON.stringify({ unitId: unit.id, kind, expectation, input });
    const previous = retryAttemptsRef.current[kind];
    const retrying = Boolean(previous?.failed && previous.fingerprint === fingerprint);
    const operationId = retrying && previous ? previous.operationId : crypto.randomUUID();
    const prompt = buildOperationPrompt({ operationId, kind, expectation, input });
    await operationOptions.beforeDispatch?.(operationId);
    retryAttemptsRef.current[kind] = { fingerprint, operationId, failed: false };

    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;
    try {
      const options = { signal: controller.signal, onState: (state: ChatOperationState) => setStatus(operationPhaseStatus(state)) };
      const state: ChatOperationState = await runWithUnitChatRecovery(
        () => retrying
          ? extensionBridge.retryAndWait(operationId, options)
          : extensionBridge.dispatchAndWait({ unitId: unit.id, operationId, kind, prompt, expectation }, options),
        async () => {
          setStatus("The saved ChatGPT conversation is unavailable. Starting a new unit chat and retrying once...");
          await extensionBridge.resetUnitChat(unit.id);
          return extensionBridge.retryAndWait(operationId, options);
        },
      );
      setBridgeGate((current) => current.state === "ready" ? current : {
        state: "ready",
        version: MEOI_EXTENSION_PROTOCOL_VERSION,
        integration: {
          installed: true,
          extensionVersion: MEOI_EXTENSION_MIN_VERSION,
          pausedForQuota: false,
          queueLength: 0,
        },
      });
      delete retryAttemptsRef.current[kind];
      if (!state.result) throw new Error("The extension completed without a ChatGPT result.");
      if (state.result.outcome === "failed") {
        if (!operationOptions.retainFailedResult) {
          await extensionBridge.acknowledgeOperation(operationId).catch(() => false);
          throw new Error(state.result.error?.message ?? "ChatGPT could not complete this request.");
        }
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
    if (!unit || !canCreateLessons) return;
    const questionSettingsErrors = validateCollectionQuestionSettings(
      getEffectiveCollectionQuestionSettings(collection.questionSettings, profile),
      profile,
    );
    if (questionSettingsErrors.length) {
      setError(`Update this collection's question settings before generating a lesson: ${questionSettingsErrors.join(" ")}`);
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

    const existingPending = pendingOperationForUnit(unit.id);
    if (existingPending && pendingLessonState !== "failed") {
      await recoverPendingLesson(existingPending);
      return;
    }

    setBusy(true);
    setError("");
    setWarning("");
    setSourceRequest("");
    let pendingOperation: PendingLearningOperation | undefined;
    try {
      if (existingPending) await discardFailedPendingOperation(existingPending);
      const result = await sendOperation("create_lesson", {
        context: currentUnitContext(),
        request: {
          unitId: unit.id,
          customRequest: customRequest.trim() || unit.instructionOverride?.trim() || "Create a varied lesson from this unit's learning material.",
          youtubeUrl: youtubeUrl.trim() || undefined,
          transcript: transcript.trim() || undefined,
        },
      }, {
        retainFailedResult: true,
        beforeDispatch: (operationId) => {
          pendingOperation = {
            operationId,
            unitId: unit.id,
            kind: "create_lesson",
            createdAt: new Date().toISOString(),
          };
          if (!rememberPendingOperation(pendingOperation)) {
            pendingOperation = undefined;
            throw new Error("The page could not retain the pending lesson operation. Nothing was sent.");
          }
          setPendingLessonState("recovering");
        },
      });
      const recorded = pendingOperation ?? pendingOperationForUnit(unit.id);
      if (!recorded || recorded.operationId !== result.operationId) {
        throw new Error("Meoi lost the pending operation metadata before it could save the lesson.");
      }
      await acceptPendingLessonResult(recorded, result);
    } catch (caught) {
      if (!isAbortError(caught)) {
        if (caught instanceof ExtensionBridgeError && caught.state?.phase === "failed") {
          showPendingFailure(caught.state.error?.message ?? caught.message);
        } else {
          setError(publicError(caught));
          if (pendingOperation) {
            setStatus("The lesson operation remains recorded and Meoi will reconnect to it.");
          }
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function evaluateAnswer(
    question: LessonQuestion,
    answer: QuestionAnswer,
    speaking?: SpeakingSubmission | null,
    progressQuestionId = question.id,
  ): Promise<Evaluation> {
    if (!unit || !lesson) throw new Error("No active lesson was found.");
    const metadata = speakingMetadata(speaking);
    setWarning(speaking?.audio ? "Audio remains in this browser. Meoi sends only the transcript and timing metadata for content feedback." : "");
    let result: ChatOperationResult;
    try {
      result = await sendOperation("evaluate_answer", {
        unit: { id: unit.id, name: unit.name },
        collection: { id: collection.id, name: collection.name, learningProfile: profile },
        lesson: {
          id: lesson.id,
          title: lesson.title,
          targetLanguage: lesson.targetLanguage,
          sourceLanguage: lesson.sourceLanguage ?? "English",
          level: lesson.level,
        },
        question,
        answer,
        speaking: metadata,
      });
    } catch (caught) {
      throw new Error(publicLearningError(caught));
    }
    if (result.outcome !== "completed" || !result.result?.evaluation) throw new Error("ChatGPT did not return a valid evaluation.");
    const evaluation = parseEvaluation(result.result.evaluation);
    const normalized = metadata && !metadata.pronunciationAvailable
      ? { ...evaluation, pronunciationAssessed: false }
      : evaluation;
    const pendingAcks = pendingEvaluationAcksRef.current.get(progressQuestionId) ?? [];
    pendingEvaluationAcksRef.current.set(progressQuestionId, [...pendingAcks, result.operationId]);
    setStatus("Evaluation received from ChatGPT. It will be released by Meoi Bridge after progress is safely queued.");
    return normalized;
  }

  async function saveProgress(attempts: AttemptRecord[], snapshot: LessonProgressSnapshot) {
    setSession((current) => putSessionProgress(current, snapshot));
    if (!unit) return;
    const nextCache = putStoredLessonProgress(learningCacheRef.current, unit.id, snapshot);
    if (nextCache !== learningCacheRef.current) commitLearningCache(nextCache);
    const progressId = progressSessionIdRef.current;
    if (!progressId || !api || !userId || !attempts.length) {
      if (attempts.length && lesson?.id !== "preview") {
        setWarning("Progress could not be saved because no server session is available. Keep this lesson open and try again.");
        throw new Error("No server progress session is available.");
      }
      return;
    }
    try {
      const payload = buildProgressBatch(attempts, snapshot);
      const failedAcks = await persistProgressBeforeEvaluationAck(
        userId,
        progressId,
        payload,
        attempts,
        pendingEvaluationAcksRef.current,
      );
      if (failedAcks) {
        setWarning("Progress is safely queued, but Meoi Bridge could not clear one retained evaluation result.");
      }
    } catch (caught) {
      setWarning("Progress could not be saved to this device. Keep this lesson open and try Continue again.");
      throw caught;
    }
    void flushProgressOutbox(api, userId)
      .then((result) => {
        setOutboxIssueCount(result.quarantined);
        if (result.retryableFailures) {
          setWarning("Progress is saved in the IndexedDB sync outbox and will retry automatically.");
        } else if (!result.quarantined) {
          setWarning("");
        }
      })
      .catch(() => {
        setWarning("Progress is saved in the IndexedDB sync outbox and will retry automatically.");
      });
  }

  async function retryRejectedProgress() {
    if (!api || !userId) return;
    await retryProgressOutboxIssues(userId);
    const result = await flushProgressOutbox(api, userId);
    setOutboxIssueCount(result.quarantined);
    setWarning(result.retryableFailures
      ? "Progress is still waiting for the connection to recover."
      : result.quarantined
        ? "The server still rejects this progress. You can retry later or discard it."
        : "");
  }

  async function discardRejectedProgress() {
    if (!userId || !window.confirm(
      `Discard ${outboxIssueCount} rejected progress ${outboxIssueCount === 1 ? "batch" : "batches"}? This cannot be undone.`,
    )) return;
    await discardProgressOutboxIssues(userId);
    setOutboxIssueCount(0);
    setWarning("");
  }

  async function askCoach(
    question: LessonQuestion,
    evaluation: Evaluation,
    message: string,
    history: CoachChatMessage[],
  ): Promise<string> {
    if (!unit || !lesson) throw new Error("No active lesson was found.");
    if (bridgeGate.state !== "ready") throw new Error("Meoi Bridge v8 is unavailable. Check the extension and try again.");
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
      lesson: {
        id: lesson.id,
        title: lesson.title,
        targetLanguage: lesson.targetLanguage,
        sourceLanguage: lesson.sourceLanguage ?? "English",
      },
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
    void startLesson(
      createLocalPreviewLesson(unit.id, cleanUnitName(unit.name), profile),
      "Temporary player preview loaded. Its progress is not synced.",
      false,
    );
  }

  const bridgeLabel = bridgeGate.state === "ready"
    ? `Bridge ${bridgeGate.integration.extensionVersion ?? MEOI_EXTENSION_MIN_VERSION} ready`
    : bridgeGate.state === "outdated"
      ? bridgeGate.version === MEOI_EXTENSION_PROTOCOL_VERSION
        ? `Bridge ${bridgeGate.integration.extensionVersion ?? "v8 build"} outdated`
        : `Bridge v${bridgeGate.version} outdated`
      : bridgeGate.state === "checking"
        ? "Checking Bridge"
        : "Bridge unavailable";

  return (
    <>
      <main className="workspace-main learning-workspace">
        <header className="main-topbar learning-topbar">
          <button className="mobile-nav-trigger" type="button" onClick={onOpenMobileNavigation} aria-label="Open navigation"><Menu size={19} /></button>
          <WorkspaceModeSwitch mode={mode} onChange={onModeChange} />
          <div className="learning-connection-pill" data-connected={extensionConnected ? "true" : "false"}>
            <span /> {bridgeLabel}
          </div>
        </header>

        <div className="content-scroll learning-scroll" ref={learningScrollRef}>
          {bridgeGate.state !== "ready" ? (
            <section className="learning-bridge-gate" aria-live="polite">
              <span className="learning-bridge-gate-icon">
                {bridgeGate.state === "checking"
                  ? <LoaderCircle className="spin" size={28} />
                  : <ShieldCheck size={28} />}
              </span>
              <p className="section-kicker">Meoi Bridge v8 required</p>
              <h1>
                {bridgeGate.state === "checking"
                  ? "Checking the browser extension..."
                  : bridgeGate.state === "outdated"
                    ? bridgeGate.version === MEOI_EXTENSION_PROTOCOL_VERSION
                      ? `Update Meoi Bridge to ${MEOI_EXTENSION_MIN_VERSION}`
                      : `Update Meoi Bridge v${bridgeGate.version}`
                    : "Meoi Bridge is not available"}
              </h1>
              <p>
                {bridgeGate.state === "outdated"
                  ? bridgeGate.version === MEOI_EXTENSION_PROTOCOL_VERSION
                    ? `Learn requires Meoi Bridge ${MEOI_EXTENSION_MIN_VERSION} or newer. ${bridgeGate.integration.extensionVersion
                      ? `Version ${bridgeGate.integration.extensionVersion} was detected.`
                      : "An older v8 build without patch-version reporting was detected."} Reload the updated extension, then reload this page.`
                    : `Learn is locked because protocol v${bridgeGate.version} was detected. Install Meoi Bridge ${MEOI_EXTENSION_MIN_VERSION}, reload the extension, then reload this page.`
                  : bridgeGate.state === "unavailable"
                    ? `Install or enable Meoi Bridge ${MEOI_EXTENSION_MIN_VERSION}, reload the extension, then reload this page. Library and Letters remain available.`
                    : "Meoi is checking protocol v8 and older v4-v7 status channels. Older versions are detected only for upgrade guidance and cannot run operations."}
              </p>
              {bridgeGate.state !== "checking" ? (
                <button className="primary-button" type="button" onClick={() => void refreshConnection()} disabled={busy}>
                  {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                  Check again
                </button>
              ) : null}
            </section>
          ) : (
            <>
          <section className="learn-hero">
            <div>
              <p className="section-kicker">ChatGPT lesson studio</p>
              <h1>{unit ? cleanUnitName(unit.name) : "Select a unit"}</h1>
              <p>Meoi Bridge sends this unit's learning material to ChatGPT Web. Validated lessons and progress are then synced through Meoing’s Worker; audio and coaching text are not stored.</p>
            </div>
            <div className="learn-hero-actions">
              {savedLessons.length && learningView !== "choose" ? (
                <button className="secondary-button" type="button" onClick={openSavedLessons} disabled={busy}>
                  <History size={16} /> Saved lessons
                </button>
              ) : null}
              {learningView === "lesson" && canCreateLessons ? (
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
              canCreate={canCreateLessons}
              currentUserId={userId}
              canDeleteContent={canDeleteContent}
            />
          ) : learningView === "new" && !canCreateLessons ? (
            <section className="learning-empty-state">
              <span><ShieldCheck size={28} /></span>
              <h2>Lesson creation is read-only</h2>
              <p>Your collection role can review available lessons but cannot create a new one.</p>
            </section>
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
              {pendingLessonState === "save_failed" ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    const pending = pendingOperationForUnit(unit.id);
                    if (pending) void recoverPendingLesson(pending);
                  }}
                  disabled={busy}
                >
                  <RefreshCw size={16} /> Retry cloud save
                </button>
              ) : null}
              <button
                className="primary-button"
                type="button"
                onClick={() => void createLesson()}
                disabled={busy || Boolean(sourceRequest && !transcript.trim())}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                {sourceRequest
                  ? "Send source and try again"
                  : pendingLessonState === "failed" || pendingLessonState === "missing"
                    ? "Create lesson again"
                    : "Create lesson"}
              </button>
            </div>
          </section>
          ) : null}

          {error ? <div className="learning-alert is-error" role="alert">{error}</div> : null}
          {warning ? <div className="learning-alert is-warning" role="status">{warning}</div> : null}
          {outboxIssueCount ? (
            <div className="learning-alert is-warning" role="alert">
              <span>
                {outboxIssueCount} progress {outboxIssueCount === 1 ? "batch was" : "batches were"} rejected by the server.
                It no longer blocks newer progress.
              </span>
              <button className="secondary-button" type="button" onClick={() => void retryRejectedProgress()}>
                Retry
              </button>
              <button className="secondary-button" type="button" onClick={() => void discardRejectedProgress()}>
                Discard
              </button>
            </div>
          ) : null}
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
                setStatus("Lesson closed after queueing the latest progress for sync.");
              }}
            />
          ) : learningView === "lesson" ? (
            <section className="learning-empty-state">
              <span><Bot size={28} /></span>
              <h2>This lesson is no longer available</h2>
              <p>Return to saved lessons or create a new lesson for this unit.</p>
            </section>
          ) : null}
            </>
          )}
        </div>
      </main>

      <aside className="overview-panel learning-control-panel" aria-label="Learning and integration settings">
        <section>
          <div className="overview-title-row"><h2>ChatGPT Web</h2><ShieldCheck size={17} /></div>
          <p className="control-copy">
            {bridgeGate.state === "ready"
              ? `Meoi Bridge ${bridgeGate.integration.extensionVersion ?? MEOI_EXTENSION_MIN_VERSION} is ready. Sign in at chatgpt.com to create lessons and use coaching.`
              : `Install Meoi Bridge ${MEOI_EXTENSION_MIN_VERSION}, reload the extension, then reload this page. Learn remains locked until the required v8 build responds.`}
          </p>
          <button className="primary-button wide-button" type="button" onClick={() => void refreshConnection()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Check again
          </button>
        </section>

        <section className="control-section">
          <h3><ShieldCheck size={15} /> Local bridge status</h3>
          <ul className="integration-checklist">
            <li data-ready="true"><span /> Website · authenticated</li>
            <li data-ready={extensionConnected ? "true" : "false"}><span /> Extension · {bridgeLabel}</li>
            <li data-ready={api ? "true" : "false"}><span /> Worker API · {api ? "ready" : "unavailable"}</li>
            <li data-ready="true"><span /> PostgreSQL · server-authorized</li>
          </ul>
          <p className="quota-note">The extension keeps queued prompts and validated results in extension session storage and removes each result after use. The website uses IndexedDB only as a temporary progress outbox, deleting batches after server acknowledgement.</p>
        </section>

        {bridgeGate.state === "ready" ? (
          <>
            {canManageCollectionProfile ? <ProfileEditor profile={profile} onChange={onUpdateProfile} /> : null}
            <section className="control-section voice-controls">
              <h3><Mic size={15} /> Live speaking</h3>
              <button className="secondary-button wide-button" type="button" disabled={!unit} onClick={() => void extensionBridge.send("OPEN_VOICE", { unitId: unit?.id })}><Mic size={15} /> Open Voice for this unit</button>
              <p className="quota-note">Meoi only opens the unit's conversation for Voice. Voice syncing and audio upload remain disabled, and saved lesson history never includes audio or voice transcripts.</p>
            </section>
          </>
        ) : null}
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
      <div className="learning-language-pair">
        <span>Language pair</span>
        <strong>{profile.sourceLanguage} <span aria-hidden="true">→</span> {profile.targetLanguage}</strong>
        <small>Edit languages in Collection settings.</small>
      </div>
      <label className="compact-field"><span>Level</span><select value={profile.level} onChange={(event) => update("level", event.target.value as LearningProfile["level"])}>
        <option value="beginner">Beginner</option><option value="elementary">Elementary</option><option value="intermediate">Intermediate</option><option value="upperIntermediate">Upper intermediate</option><option value="advanced">Advanced</option>
      </select></label>
      <label className="compact-field"><span>Questions</span><input type="number" min={8} max={15} value={profile.lessonQuestionCount} onChange={(event) => update("lessonQuestionCount", Number(event.target.value))} /></label>
      <label className="toggle-row"><span>Include speaking</span><input type="checkbox" checked={profile.speakingEnabled} onChange={(event) => update("speakingEnabled", event.target.checked)} /></label>
    </section>
  );
}
