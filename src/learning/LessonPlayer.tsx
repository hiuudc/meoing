import { BookOpen, Check, ChevronRight, CircleHelp, Lightbulb, MessageCircle, RotateCcw, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { gradeAnswer, isAnswerEmpty } from "./grader";
import { shouldFlushProgress } from "./progress";
import { applyAttempt, createRetryState, masteryPercent, type RetryState } from "./retry";
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

interface LessonPlayerProps {
  lesson: Lesson;
  onEvaluate?: (question: LessonQuestion, answer: QuestionAnswer, speaking?: SpeakingSubmission | null) => Promise<Evaluation>;
  onProgressBatch?: (attempts: AttemptRecord[], snapshot: LessonProgressSnapshot) => void | Promise<void>;
  onAskCoach?: (question: LessonQuestion, evaluation: Evaluation) => void | Promise<void>;
}

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
  if (status === "correct") return "Đúng";
  if (status === "partial") return "Chưa hoàn chỉnh";
  return "Chưa đúng";
}

export function LessonPlayer({ lesson, onEvaluate, onProgressBatch, onAskCoach }: LessonPlayerProps) {
  const questionMap = useMemo(() => new Map(lesson.questions.map((question) => [question.id, question])), [lesson.questions]);
  const [retryState, setRetryState] = useState(() => createRetryState(lesson.questions.map((question) => question.id)));
  const currentQuestion = questionMap.get(retryState.queue[0]);
  const [answer, setAnswer] = useState<QuestionAnswer>(() => currentQuestion ? initialAnswer(currentQuestion) : "");
  const [speaking, setSpeaking] = useState<SpeakingSubmission | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [theoryOpen, setTheoryOpen] = useState(true);
  const pendingAttemptsRef = useRef<AttemptRecord[]>([]);
  const retryStateRef = useRef(retryState);
  const progressHandlerRef = useRef(onProgressBatch);
  const lessonRef = useRef(lesson);

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

  async function submitAnswer() {
    if (!currentQuestion || evaluation || submitting) return;
    if (isAnswerEmpty(answer) && !(speaking?.audio || speaking?.transcript)) {
      setError("Hãy nhập hoặc chọn câu trả lời trước khi chấm.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const local = gradeAnswer(currentQuestion, answer);
      if (!local.requiresAi) {
        setEvaluation(local);
      } else if (!onEvaluate) {
        setError("Câu này cần ChatGPT đánh giá và đang được khóa trong local-only mode.");
      } else {
        setEvaluation(await onEvaluate(currentQuestion, answer, speaking));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không thể chấm câu trả lời lúc này.");
    } finally {
      setSubmitting(false);
    }
  }

  function continueLesson() {
    if (!currentQuestion || !evaluation) return;
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
  }

  function restartLesson() {
    const next = createRetryState(lesson.questions.map((question) => question.id));
    setRetryState(next);
    retryStateRef.current = next;
    setAnswer(lesson.questions[0] ? initialAnswer(lesson.questions[0]) : "");
    setSpeaking(null);
    setEvaluation(null);
    setError("");
    pendingAttemptsRef.current = [];
  }

  const total = lesson.questions.length;
  const progress = masteryPercent(retryState, total);
  const upcomingRetry = currentQuestion ? (retryState.attemptsByQuestion[currentQuestion.id] ?? 0) > 0 : false;
  const displayedAttempt = currentQuestion ? (retryState.attemptsByQuestion[currentQuestion.id] ?? 0) + 1 : 0;
  const showCoach = Boolean(currentQuestion && evaluation && evaluation.status !== "correct" && displayedAttempt >= 3 && onAskCoach);

  if (!currentQuestion) {
    return (
      <section className="lesson-player lesson-complete">
        <span className="completion-icon"><Sparkles size={25} /></span>
        <p className="section-kicker">Lesson complete</p>
        <h2>Đã mastery toàn bộ {total} câu</h2>
        <p>First-try accuracy: {Math.round((retryState.firstTryCorrect / Math.max(1, total)) * 100)}%. Các câu sai đã được lặp lại cho tới khi đúng.</p>
        <button className="secondary-button" type="button" onClick={restartLesson}><RotateCcw size={16} /> Học lại bài</button>
      </section>
    );
  }

  return (
    <section className="lesson-player" aria-label={`Lesson: ${lesson.title}`}>
      <header className="lesson-player-header">
        <div>
          <p className="section-kicker">{lesson.targetLanguage} · {lesson.level}</p>
          <h2>{lesson.title}</h2>
          <p>{lesson.summary}</p>
        </div>
        <button className="theory-toggle" type="button" aria-expanded={theoryOpen} onClick={() => setTheoryOpen((open) => !open)}>
          <BookOpen size={16} /> {theoryOpen ? "Ẩn lý thuyết" : "Mở lý thuyết"}
        </button>
      </header>

      <div className="lesson-progress-row">
        <div className="lesson-progress-track" aria-label={`${progress}% mastery`}><span style={{ width: `${progress}%` }} /></div>
        <strong>{retryState.completed.length}/{total}</strong>
      </div>

      {theoryOpen ? (
        <div className="lesson-theory-grid">
          <section>
            <h3>Mục tiêu</h3>
            <ul>{lesson.objectives.map((objective) => <li key={objective}>{objective}</li>)}</ul>
          </section>
          {lesson.theory.map((block) => (
            <article key={block.id}>
              <span>{block.kind}</span>
              <h3>{block.title}</h3>
              <p>{block.body}</p>
            </article>
          ))}
          {lesson.glossary.length ? (
            <section className="lesson-glossary">
              <h3>Glossary</h3>
              <dl>{lesson.glossary.map((entry) => <div key={entry.term}><dt>{entry.term}</dt><dd>{entry.meaning}</dd></div>)}</dl>
            </section>
          ) : null}
        </div>
      ) : null}

      <article className="question-card">
        <div className="question-meta-row">
          <span>Câu {retryState.completed.length + 1}/{total}</span>
          <span>{currentQuestion.type}</span>
          {upcomingRetry ? <span className="retry-badge"><RotateCcw size={13} /> Lặp lại · lần {displayedAttempt}</span> : null}
        </div>
        <h3>{currentQuestion.prompt}</h3>
        <QuestionRenderer
          key={`${currentQuestion.id}-${displayedAttempt}`}
          question={currentQuestion}
          answer={answer}
          disabled={Boolean(evaluation) || submitting}
          onChange={setAnswer}
          onSpeakingChange={setSpeaking}
        />

        {evaluation ? (
          <section className={`evaluation-panel is-${evaluation.status}`} aria-live="polite">
            <div className="evaluation-title-row">
              <span>{evaluation.status === "correct" ? <Check size={17} /> : <X size={17} />}</span>
              <strong>{statusLabel(evaluation.status)} · {Math.round(evaluation.score * 100)}%</strong>
            </div>
            <p>{evaluation.explanation}</p>
            {evaluation.errors.length ? (
              <ul>{evaluation.errors.map((item, index) => <li key={`${item.location}-${index}`}><strong>{item.location}:</strong> {item.message}</li>)}</ul>
            ) : null}
            {evaluation.status !== "correct" ? <p><strong>Sửa:</strong> {evaluation.correction}</p> : null}
            <p className="next-hint"><Lightbulb size={14} /> {evaluation.nextHint}</p>
            {displayedAttempt >= 3 && currentQuestion.supplementalHint && evaluation.status !== "correct" ? (
              <p className="supplemental-hint"><CircleHelp size={14} /> {currentQuestion.supplementalHint}</p>
            ) : null}
            {evaluation.rubricScores?.length ? (
              <dl className="rubric-scores">{evaluation.rubricScores.map((item) => <div key={item.criterion}><dt>{item.criterion}</dt><dd>{Math.round(item.score * 100)}% · {item.note}</dd></div>)}</dl>
            ) : null}
          </section>
        ) : null}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}

        <footer className="question-footer">
          <p>{evaluation ? (evaluation.status === "correct" ? "Đã mastery câu này." : "Câu sẽ quay lại sau hai câu khác.") : currentQuestion.hint ? `Gợi ý: ${currentQuestion.hint}` : "Trả lời để nhận feedback."}</p>
          <div>
            {showCoach && evaluation ? (
              <button className="secondary-button" type="button" onClick={() => void onAskCoach?.(currentQuestion, evaluation)}>
                <MessageCircle size={16} /> Hỏi ChatGPT
              </button>
            ) : null}
            {evaluation ? (
              <button className="primary-button" type="button" onClick={continueLesson}>Tiếp tục <ChevronRight size={16} /></button>
            ) : (
              <button className="primary-button" type="button" onClick={() => void submitAnswer()} disabled={submitting}>
                {submitting ? "Đang chấm…" : "Chấm câu trả lời"}
              </button>
            )}
          </div>
        </footer>
      </article>

      {lesson.sourceReferences.length ? (
        <details className="lesson-sources">
          <summary>Nguồn của bài học</summary>
          <ul>{lesson.sourceReferences.map((source) => <li key={source.id}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}</li>)}</ul>
        </details>
      ) : null}
    </section>
  );
}
