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
import {
  AI_OPERATION_CONTRACT_VERSION,
  type AiOperationKind,
  type AiOperationResult,
  type AiProvider,
} from "@meoing/ai-operation-contract";
import type { ApiClient, ApiSuccess } from "../api/client";
import { readSettings, settingsValues, upsertSetting } from "../api/settings";
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
import { isAllowedTranscriptFile, youtubeNoCookieEmbedUrl } from "../integration/youtube";
import type { Collection, Document, StudyItem, Unit } from "../types";
import { cleanUnitName } from "../unit";
import { WorkspaceModeSwitch, type WorkspaceMode } from "./WorkspaceModeSwitch";
import { AnimatedModal } from "./AnimatedModal";

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

type ChatOperationKind = AiOperationKind;
type ChatOperationResult = AiOperationResult;

interface OperationExpectation {
  unitId: string;
  targetLanguage: string;
  sourceLanguage: string;
  level: LearningProfile["level"];
  questionCount: number;
  speaking: boolean;
  allowedFormats: string[];
}

type LearningView = "choose" | "new" | "lesson";
type ProviderGateState = "checking" | "ready" | "consent_required" | "unavailable";
type PendingLessonState = "idle" | "failed";

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

const MEOI_TEXT_FIELD_MAX_BYTES = 16 * 1024;
const MEOI_TRANSCRIPT_MAX_BYTES = 500 * 1024;
const INITIAL_STATUS = "Meoing sends authorized learning operations through its secure API.";
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

export async function persistProgressBeforeEvaluationAck(
  userId: string,
  progressId: string,
  payload: ProgressBatchPayload,
  attempts: AttemptRecord[],
  pendingAcks: PendingEvaluationAcks,
  enqueue: typeof enqueueProgressBatch = enqueueProgressBatch,
): Promise<number> {
  await enqueue(userId, progressId, payload);
  for (const attempt of attempts) pendingAcks.delete(attempt.questionId);
  return 0;
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function publicLearningError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
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
                    {entry.lesson.sourceLanguage ? `${entry.lesson.sourceLanguage} to ` : ""}
                    {entry.lesson.targetLanguage} - {entry.lesson.level}
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
  const [provider, setProvider] = useState<AiProvider>("api");
  const [providerGate, setProviderGate] = useState<ProviderGateState>("checking");
  const [consentOpen, setConsentOpen] = useState(false);
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
  const learningCacheRef = useRef(learningCache);
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
  const providerReady = providerGate === "ready";

  useEffect(() => () => {
    activeAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    activeAbortRef.current?.abort();
    progressSessionIdRef.current = null;
    learningScrollRef.current?.scrollTo({ top: 0 });
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
    if (!api) {
      setProviderGate("unavailable");
      return () => { active = false; };
    }
    setProviderGate("checking");
    void readSettings(api, { scope: "user" }).then((records) => {
      if (!active) return;
      const values = settingsValues(records);
      const selected = values.aiProvider === "bridge" ? "bridge" : "api";
      const consent = values.aiConsent;
      const granted = Boolean(consent && typeof consent === "object" && "grantedAt" in consent);
      setProvider(selected);
      setProviderGate(selected === "api" ? (granted ? "ready" : "consent_required") : "unavailable");
    }).catch(() => {
      if (active) setProviderGate("unavailable");
    });
    return () => { active = false; };
  }, [api, userId]);

  useEffect(() => {
    if (!api || !unit) {
      const empty = createLocalLearningCache();
      learningCacheRef.current = empty;
      setLearningCache(empty);
      return;
    }
    // Do not abort a database-backed Worker request while changing workspace modes.
    // Wrangler's local ProxyWorker can terminate when its client connection disappears
    // after the query has already completed. The component only needs to ignore stale
    // results once it has unmounted or switched units.
    let active = true;
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
        if (!active) return;
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
        if (!active) return;
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
        if (active) setError(publicError(caught));
      });
    return () => {
      active = false;
    };
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

  async function refreshConnection() {
    if (!api) {
      setProviderGate("unavailable");
      return;
    }
    setBusy(true);
    setError("");
    setProviderGate("checking");
    try {
      const records = await readSettings(api, { scope: "user" });
      const values = settingsValues(records);
      const selected = values.aiProvider === "bridge" ? "bridge" : "api";
      const consent = values.aiConsent;
      const granted = Boolean(consent && typeof consent === "object" && "grantedAt" in consent);
      setProvider(selected);
      const nextGate = selected === "api" ? (granted ? "ready" : "consent_required") : "unavailable";
      setProviderGate(nextGate);
      if (nextGate === "ready") {
        setStatus("The OpenAI API provider is ready. Meoing stores only validated learning results.");
      }
    } catch (caught) {
      setProviderGate("unavailable");
      setError(publicError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function chooseProvider(nextProvider: AiProvider) {
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      await upsertSetting(api, { scope: "user" }, "aiProvider", nextProvider);
      setProvider(nextProvider);
      setProviderGate(nextProvider === "api" ? "consent_required" : "unavailable");
      setStatus(nextProvider === "api"
        ? "Review the API data disclosure before continuing."
        : "No compatible Bridge is available in this public build. Choose API to continue.");
    } catch (caught) {
      setError(publicError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function grantApiConsent() {
    if (!api) return;
    setBusy(true);
    try {
      await upsertSetting(api, { scope: "user" }, "aiConsent", {
        version: AI_OPERATION_CONTRACT_VERSION,
        grantedAt: new Date().toISOString(),
      });
      await upsertSetting(api, { scope: "user" }, "aiProvider", "api");
      setProvider("api");
      setProviderGate("ready");
      setConsentOpen(false);
      setStatus("OpenAI API is enabled for learning operations.");
    } catch (caught) {
      setError(publicError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function withdrawApiConsent() {
    if (!api) return;
    setBusy(true);
    try {
      await upsertSetting(api, { scope: "user" }, "aiConsent", { version: AI_OPERATION_CONTRACT_VERSION });
      setProviderGate("consent_required");
      setStatus("API consent was withdrawn. AI operations are blocked immediately.");
    } catch (caught) {
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

  function showPendingFailure(message: string) {
    setPendingLessonState("failed");
    setError(message);
    setWarning("");
    setStatus("The lesson result failed validation. Create the lesson again after reviewing the error.");
  }

  async function acceptLessonResult(result: ChatOperationResult): Promise<boolean> {
    if (!unit) return false;
    if (result.outcome === "failed") {
      showPendingFailure(result.error?.message ?? "OpenAI API could not create a valid lesson.");
      return false;
    }
    if (result.outcome === "needs_source") {
      const request = typeof result.result?.sourceRequest === "string"
        ? result.result.sourceRequest
        : "Add a transcript or notes to continue.";
      setSourceRequest(request);
      setStatus(request);
      setPendingLessonState("idle");
      return true;
    }
    if (result.outcome !== "completed" || !result.result?.lesson) {
      showPendingFailure("OpenAI API did not return a valid lesson.");
      return false;
    }

    let preparedLesson: StoredLessonEntry["lesson"];
    try {
      const parsedLesson = parseLesson(result.result.lesson);
      if (parsedLesson.unitId !== unit.id) {
        throw new Error("The returned lesson does not match the unit that requested it.");
      }
      preparedLesson = decorateLessonPresentation(parsedLesson, collection.questionSettings, profile);
    } catch (caught) {
      showPendingFailure(`AI provider returned a lesson that this page could not validate: ${publicError(caught)}`);
      return false;
    }

    if (!api) {
      setPendingLessonState("failed");
      setError("The lesson is ready in AI provider, but the secure API is unavailable.");
      setWarning("Reconnect to the API, then retry saving the lesson.");
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
      }, result.operationId);
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
      setPendingLessonState("failed");
      setError(`The lesson is ready in AI provider, but the API could not save it: ${publicError(caught)}`);
      setWarning("The validated result remains available so you can retry safely.");
      setStatus("Lesson received but cloud saving failed.");
      return false;
    }

    commitLearningCache(putStoredLesson(learningCacheRef.current, preparedLesson));
    await startLesson(preparedLesson, "Lesson received from OpenAI API and synced to Meoing.");
    setPendingLessonState("idle");
    return true;
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
    setStatus("Describe the lesson you want, then send it to this unit's linked OpenAI API conversation.");
  }

  function openSavedLessons() {
    if (!unit || !savedLessons.length) return;
    setLearningView({ unitId: unit.id, view: "choose", playerRunId: unitView.playerRunId });
    resetLessonPanels();
    setStatus(`${savedLessons.length} saved ${savedLessons.length === 1 ? "lesson is" : "lessons are"} available for this unit.`);
  }

  function reviewStoredLesson(entry: StoredLessonEntry) {
    void startLesson(entry.lesson, `Reviewing "${entry.lesson.title}" from question one. Progress will sync as a new session.`);
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
  ): Promise<ChatOperationResult> {
    if (!unit) throw new Error("Select a unit first.");
    if (!api || provider !== "api") throw new Error("Choose the API provider before running Learn.");
    if (providerGate === "consent_required") throw new Error("Consent is required before sending learning data to the API.");
    if (!providerReady) throw new Error("The API provider is unavailable.");
    const operationId = crypto.randomUUID();
    setStatus(kind === "create_lesson" ? "Creating lesson with the API..." : "Requesting learning feedback from the API...");
    const response = await api.post<ChatOperationResult>("/v1/ai/operations", {
      contractVersion: AI_OPERATION_CONTRACT_VERSION,
      operationId,
      kind,
      collectionId: collection.id,
      unitId: unit.id,
      input: input && typeof input === "object" && !Array.isArray(input) ? input : {},
    }, operationId);
    return response.data;
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
    if (textByteLength(customRequest) > MEOI_TEXT_FIELD_MAX_BYTES || textByteLength(transcript) > MEOI_TRANSCRIPT_MAX_BYTES) {
      setError("Lesson request or transcript is too large.");
      return;
    }
    setBusy(true);
    setError("");
    setWarning("");
    setSourceRequest("");
    try {
      const result = await sendOperation("create_lesson", {
        expectation: currentExpectation(),
        request: {
          customRequest: customRequest.trim() || unit.instructionOverride?.trim() || "Create a varied lesson from this unit's learning material.",
          youtubeUrl: youtubeUrl.trim() || undefined,
          transcript: transcript.trim() || undefined,
        },
      });
      await acceptLessonResult(result);
    } catch (caught) {
      if (!isAbortError(caught)) setError(publicError(caught));
    } finally {
      setBusy(false);
    }
    return;
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
        lesson: { id: lesson.id },
        questionId: question.id,
        answer,
        speaking: metadata,
      });
    } catch (caught) {
      throw new Error(publicLearningError(caught));
    }
    if (result.outcome !== "completed" || !result.result?.evaluation) throw new Error("OpenAI API did not return a valid evaluation.");
    const evaluation = parseEvaluation(result.result.evaluation);
    const normalized = metadata && !metadata.pronunciationAvailable
      ? { ...evaluation, pronunciationAssessed: false }
      : evaluation;
    const pendingAcks = pendingEvaluationAcksRef.current.get(progressQuestionId) ?? [];
    pendingEvaluationAcksRef.current.set(progressQuestionId, [...pendingAcks, result.operationId]);
    setStatus("Evaluation received from OpenAI API. It will be released by AI provider after progress is safely queued.");
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
        setWarning("Progress is safely queued, but AI provider could not clear one retained evaluation result.");
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
    const text = message.trim();
    if (textByteLength(text) > MEOI_TEXT_FIELD_MAX_BYTES) {
      throw new Error("The coaching message must be 16 KiB or smaller.");
    }
    const result = await sendOperation("coaching", {
      lesson: { id: lesson.id },
      questionId: question.id,
      evaluation,
      message: text,
      history: history.slice(-8).map((entry) => ({ role: entry.role, content: entry.content.slice(0, 2_000) })),
    });
    const reply = typeof result.result?.coachingReply === "string"
      ? result.result.coachingReply.trim()
      : "";
    if (result.outcome !== "completed" || !reply || textByteLength(reply) > MEOI_TEXT_FIELD_MAX_BYTES) {
      throw new Error("The API did not return a valid coaching reply.");
    }
    setStatus("Coaching reply received from the API.");
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

  const providerLabel = providerGate === "ready"
    ? "OpenAI API ready"
    : providerGate === "checking"
      ? "Checking AI provider"
      : providerGate === "consent_required"
        ? "API consent required"
        : provider === "bridge"
          ? "Bridge unavailable"
          : "API unavailable";

  return (
    <>
      <main className="workspace-main learning-workspace">
        <header className="main-topbar learning-topbar">
          <button className="mobile-nav-trigger" type="button" onClick={onOpenMobileNavigation} aria-label="Open navigation"><Menu size={19} /></button>
          <WorkspaceModeSwitch mode={mode} onChange={onModeChange} />
          <div className="learning-connection-pill" data-connected={providerReady ? "true" : "false"}>
            <span /> {providerLabel}
          </div>
        </header>

        <div className="content-scroll learning-scroll" ref={learningScrollRef}>
          {!providerReady ? (
            <section className="learning-bridge-gate" aria-live="polite">
              <span className="learning-bridge-gate-icon">
                {providerGate === "checking"
                  ? <LoaderCircle className="spin" size={28} />
                  : <ShieldCheck size={28} />}
              </span>
              <p className="section-kicker">AI provider</p>
              <h1>
                {providerGate === "checking"
                  ? "Checking your AI provider..."
                  : providerGate === "consent_required"
                    ? "Allow the OpenAI API to learn"
                    : provider === "bridge"
                      ? "Bridge is unavailable"
                      : "OpenAI API is unavailable"}
              </h1>
              <p>
                {providerGate === "consent_required"
                  ? "Review the disclosure before Meoing sends selected learning material or answers to OpenAI."
                  : provider === "bridge"
                    ? "This public build has no compatible Bridge. Select API to continue."
                    : "The secure API is temporarily unavailable. Check your connection and try again."}
              </p>
              {providerGate === "consent_required" ? (
                <button className="primary-button" type="button" onClick={() => setConsentOpen(true)} disabled={busy}>
                  <ShieldCheck size={16} /> Review API consent
                </button>
              ) : null}
              {providerGate !== "checking" ? (
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
              <p className="section-kicker">OpenAI API lesson studio</p>
              <h1>{unit ? cleanUnitName(unit.name) : "Select a unit"}</h1>
              <p>Meoing sends authorized learning operations through its Worker to the OpenAI API. Validated lessons and progress remain in your workspace; audio is not uploaded.</p>
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
              <span>{profile.lessonQuestionCount} questions with at least 5 formats</span>
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
                <small>.srt / .vtt / .txt - up to 500 KiB</small>
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
                {sourceRequest
                  ? "Send source and try again"
                  : pendingLessonState === "failed"
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
              coachingAvailable={providerReady}
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

      <aside className="overview-panel learning-control-panel" aria-label="Learning and AI settings">
        <section>
          <div className="overview-title-row"><h2>AI provider</h2><ShieldCheck size={17} /></div>
          <label className="compact-field">
            <span>Provider</span>
            <select value={provider} onChange={(event) => void chooseProvider(event.target.value as AiProvider)} disabled={busy}>
              <option value="api">OpenAI API</option>
              <option value="bridge">Bridge</option>
            </select>
          </label>
          {provider === "api" && providerGate === "consent_required" ? (
            <button className="primary-button wide-button" type="button" onClick={() => setConsentOpen(true)} disabled={busy}>
              Review API consent
            </button>
          ) : null}
          {provider === "api" && providerReady ? (
            <button className="secondary-button wide-button" type="button" onClick={() => void withdrawApiConsent()} disabled={busy}>
              Withdraw API consent
            </button>
          ) : null}
          <p className="control-copy">
            {providerReady
              ? "The OpenAI API provider is ready for lesson generation, evaluation, and coaching."
              : provider === "bridge"
                ? "Bridge is a versioned browser contract. This public build has no Bridge implementation; select API to continue."
                : "Review API consent or check your connection to unlock learning operations."}
          </p>
          <button className="primary-button wide-button" type="button" onClick={() => void refreshConnection()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Check again
          </button>
        </section>

        <section className="control-section">
          <h3><ShieldCheck size={15} /> Provider status</h3>
          <ul className="integration-checklist">
            <li data-ready="true"><span /> Website: authenticated</li>
            <li data-ready={providerReady ? "true" : "false"}><span /> Selected provider: {providerLabel}</li>
            <li data-ready={api ? "true" : "false"}><span /> Worker API: {api ? "ready" : "unavailable"}</li>
            <li data-ready="true"><span /> Database: server-authorized</li>
          </ul>
          <p className="quota-note">The browser keeps only a temporary progress outbox and removes batches after server acknowledgement. AI prompts and answers are not logged by the Worker.</p>
        </section>

        {providerReady ? (
          <>
            {canManageCollectionProfile ? <ProfileEditor profile={profile} onChange={onUpdateProfile} /> : null}
            <section className="control-section voice-controls">
              <h3><Mic size={15} /> Live speaking</h3>
              <button className="secondary-button wide-button" type="button" disabled><Mic size={15} /> Live voice is not available</button>
              <p className="quota-note">Voice syncing and audio upload remain disabled. Saved lesson history never includes audio or voice transcripts.</p>
            </section>
          </>
        ) : null}
      </aside>
      <AnimatedModal
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        labelledBy="api-consent-title"
        backdropClassName="modal-backdrop"
        panelClassName="entity-editor-modal api-consent-modal"
      >
        <header className="entity-editor-header">
          <div><p className="section-kicker">OpenAI API</p><h2 id="api-consent-title">Allow AI learning operations</h2></div>
          <button className="icon-button" type="button" onClick={() => setConsentOpen(false)} aria-label="Close consent dialog">x</button>
        </header>
        <div className="entity-editor-body">
          <p>Meoing sends the selected unit's learning material and the answer needed for this operation to OpenAI. Audio and sign-in tokens are never sent. Requests use OpenAI's API with response storage disabled.</p>
          <p>You can withdraw consent at any time. Without consent, API lesson generation, evaluation, and coaching are blocked.</p>
        </div>
        <footer className="entity-editor-footer"><button className="secondary-button" type="button" onClick={() => setConsentOpen(false)}>Cancel</button><button className="primary-button" type="button" onClick={() => void grantApiConsent()} disabled={busy}>Allow API</button></footer>
      </AnimatedModal>
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
        <strong>{profile.sourceLanguage} to {profile.targetLanguage}</strong>
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
