import { LoaderCircle, Play, RotateCcw, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { CharacterJson, Point } from "hanzi-writer";
import type { CharacterTracingQuestion, QuestionAnswer } from "./types";
import { loadStrokeCharacterData } from "./strokeData";

interface CharacterTracingResponseProps {
  question: CharacterTracingQuestion;
  language: string;
  answer: QuestionAnswer;
  disabled?: boolean;
  onChange: (answer: QuestionAnswer) => void;
  onUnavailable?: () => void;
  onStart?: () => void;
  strokeTolerance?: number;
  showStrokeGuide?: boolean;
}

interface DrawnStroke {
  points: Point[];
}

const DRAWING_SIZE = 280;
const DRAWING_PADDING = 16;
const CHARACTER_CENTER = { x: 512, y: 388 };
const MAX_CENTER_OFFSET = 48;
const TRACING_AVERAGE_DISTANCE_THRESHOLD = 500;
const FORGIVING_TOLERANCE_THRESHOLD = 1.5;
const FORGIVING_MISS_LIMIT = 4;

function quizInstructions(strokeTolerance: number): string {
  return strokeTolerance >= FORGIVING_TOLERANCE_THRESHOLD
    ? "Follow the stroke order. A hint appears after two misses; repeated attempts will advance."
    : "Follow the stroke order. A hint appears after two misses.";
}

function averageDistance(points: Point[], median: number[][]): number {
  if (!points.length || !median.length) return Number.POSITIVE_INFINITY;
  const sampled = median.filter((_, index) => index % Math.max(1, Math.floor(median.length / 12)) === 0);
  return sampled.reduce((total, [targetX, targetY]) => {
    const nearest = points.reduce((distance, point) => Math.min(
      distance,
      Math.hypot(point.x - targetX, point.y - targetY),
    ), Number.POSITIVE_INFINITY);
    return total + nearest;
  }, 0) / sampled.length;
}

function shapeScore(data: CharacterJson, strokes: DrawnStroke[]): number {
  const points = strokes.flatMap((stroke) => stroke.points);
  if (!points.length) return 0;
  const distances = data.medians.map((median) => averageDistance(points, median));
  const covered = distances.filter((distance) => distance <= 125).length;
  return covered / Math.max(1, data.medians.length);
}

interface TraceOffset {
  x: number;
  y: number;
}

function clampCenterOffset(value: number): number {
  return Math.max(-MAX_CENTER_OFFSET, Math.min(MAX_CENTER_OFFSET, value));
}

export function characterCenterOffset(
  data: CharacterJson,
  drawingSize = DRAWING_SIZE,
  padding = DRAWING_PADDING,
): TraceOffset {
  const points = data.medians.flat();
  if (!points.length) return { x: 0, y: 0 };
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const scale = (drawingSize - padding * 2) / 1_024;
  return {
    x: clampCenterOffset((CHARACTER_CENTER.x - centerX) * scale),
    y: clampCenterOffset((centerY - CHARACTER_CENTER.y) * scale),
  };
}

function internalPointToDrawingPoint([x, y]: number[]): [number, number] {
  const scale = (DRAWING_SIZE - DRAWING_PADDING * 2) / 1_024;
  const xOffset = DRAWING_PADDING;
  const yOffset = DRAWING_PADDING + 124 * scale;
  return [
    xOffset + x * scale,
    DRAWING_SIZE - yOffset - y * scale,
  ];
}

function offsetStyle(offset: TraceOffset): CSSProperties {
  return {
    transform: `translate(${offset.x}px, ${offset.y}px)`,
  };
}

function StrokeGuide({ median, offset }: { median?: number[][]; offset: TraceOffset }) {
  const markerId = `stroke-guide-${useId().replace(/[^a-z0-9_-]/gi, "")}`;
  if (!median?.length) return null;
  const points = median.map(internalPointToDrawingPoint);
  const start = points[0];
  const directionTarget = points.find(([x, y]) => Math.hypot(x - start[0], y - start[1]) >= 12)
    ?? points[points.length - 1];
  const directionLength = Math.max(1, Math.hypot(directionTarget[0] - start[0], directionTarget[1] - start[1]));
  const directionEnd: [number, number] = [
    start[0] + ((directionTarget[0] - start[0]) / directionLength) * 22,
    start[1] + ((directionTarget[1] - start[1]) / directionLength) * 22,
  ];

  return (
    <svg
      className="stroke-guide"
      viewBox={`0 0 ${DRAWING_SIZE} ${DRAWING_SIZE}`}
      style={offsetStyle(offset)}
      aria-hidden="true"
    >
      <defs>
        <marker id={markerId} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 Z" />
        </marker>
      </defs>
      <polyline
        className="stroke-guide-path"
        points={points.map(([x, y]) => `${x},${y}`).join(" ")}
        markerEnd={`url(#${markerId})`}
      />
      <circle className="stroke-guide-start" cx={start[0]} cy={start[1]} r="11" />
      <line
        className="stroke-guide-direction"
        x1={start[0] - 2}
        y1={start[1]}
        x2={directionEnd[0]}
        y2={directionEnd[1]}
        markerEnd={`url(#${markerId})`}
      />
    </svg>
  );
}

function FreeShapeCanvas({
  data,
  disabled,
  offset,
  onComplete,
  onStart,
}: {
  data: CharacterJson;
  disabled?: boolean;
  offset: TraceOffset;
  onComplete: () => void;
  onStart?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<DrawnStroke[]>([]);
  const [drawing, setDrawing] = useState<DrawnStroke | null>(null);
  const [status, setStatus] = useState("Trace the whole character. Stroke order is not checked.");

  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 1_024,
      y: 900 - ((event.clientY - rect.top) / rect.height) * 1_024,
    };
  }

  function redraw(nextStrokes: DrawnStroke[], active?: DrawnStroke | null) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = canvas.width / 1_024;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#6e5de7";
    context.lineWidth = 18;
    context.lineCap = "round";
    context.lineJoin = "round";
    [...nextStrokes, ...(active ? [active] : [])].forEach((stroke) => {
      if (stroke.points.length < 2) return;
      context.beginPath();
      stroke.points.forEach((point, index) => {
        const x = point.x * scale;
        const y = (900 - point.y) * scale;
        if (!index) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    });
  }

  function finishStroke() {
    if (!drawing) return;
    const next = drawing.points.length > 1 ? [...strokes, drawing] : strokes;
    setStrokes(next);
    setDrawing(null);
    redraw(next);
    const score = shapeScore(data, next);
    if (score >= .78) {
      setStatus("Shape complete.");
      onComplete();
    } else {
      setStatus(`${Math.round(score * 100)}% covered. Continue tracing the missing strokes.`);
    }
  }

  return (
    <div className="free-tracing">
      <div className="tracing-canvas-stack">
        <div className="tracing-offset-layer" style={offsetStyle(offset)}>
          <svg viewBox="0 0 1024 1024" aria-hidden="true">
            <g transform="translate(0 962) scale(1 -1)">
              {data.strokes.map((path, index) => <path d={path} key={`${index}-${path.slice(0, 12)}`} />)}
            </g>
          </svg>
          <canvas
            ref={canvasRef}
            width={DRAWING_SIZE}
            height={DRAWING_SIZE}
            aria-label="Trace the character"
            onPointerDown={(event) => {
              if (disabled) return;
              onStart?.();
              event.currentTarget.setPointerCapture(event.pointerId);
              const next = { points: [canvasPoint(event)] };
              setDrawing(next);
              redraw(strokes, next);
            }}
            onPointerMove={(event) => {
              if (!drawing || disabled) return;
              const next = { points: [...drawing.points, canvasPoint(event)] };
              setDrawing(next);
              redraw(strokes, next);
            }}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
          />
        </div>
      </div>
      <div className="tracing-status-row">
        <p role="status">{status}</p>
        <button type="button" className="icon-text-button" onClick={() => {
          setStrokes([]);
          setDrawing(null);
          setStatus("Trace the whole character. Stroke order is not checked.");
          redraw([]);
        }} disabled={disabled || !strokes.length}>
          <RotateCcw size={15} /> Reset
        </button>
      </div>
    </div>
  );
}

export function CharacterTracingResponse({
  question,
  language,
  answer,
  disabled,
  onChange,
  onUnavailable,
  onStart,
  strokeTolerance = 1,
  showStrokeGuide = true,
}: CharacterTracingResponseProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const writerRef = useRef<import("hanzi-writer").default | null>(null);
  const animationRunRef = useRef(0);
  const centerOffsetRef = useRef<TraceOffset>({ x: 0, y: 0 });
  const [data, setData] = useState<CharacterJson | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState(question.unavailableReason ?? "");
  const [quizMessage, setQuizMessage] = useState(() => quizInstructions(strokeTolerance));
  const [animating, setAnimating] = useState(false);
  const [loopAnimation, setLoopAnimation] = useState(false);
  const [currentStroke, setCurrentStroke] = useState(0);
  const [centerOffset, setCenterOffset] = useState<TraceOffset>({ x: 0, y: 0 });
  const [reducedMotion, setReducedMotion] = useState(false);
  const completed = answer === "passed";

  const startQuiz = useCallback((writer: import("hanzi-writer").default) => {
    animationRunRef.current += 1;
    setAnimating(false);
    setCurrentStroke(0);
    setQuizMessage(quizInstructions(strokeTolerance));
    void writer.quiz({
      leniency: strokeTolerance,
      averageDistanceThreshold: TRACING_AVERAGE_DISTANCE_THRESHOLD,
      showHintAfterMisses: 2,
      markStrokeCorrectAfterMisses: strokeTolerance >= FORGIVING_TOLERANCE_THRESHOLD
        ? FORGIVING_MISS_LIMIT
        : false,
      highlightOnComplete: true,
      onMistake: ({ strokeNum, mistakesOnStroke }) => {
        if (writerRef.current !== writer) return;
        setQuizMessage(`Stroke ${strokeNum + 1} was not recognized. Miss ${mistakesOnStroke}; follow the highlighted path.`);
      },
      onCorrectStroke: ({ strokeNum, strokesRemaining }) => {
        if (writerRef.current !== writer) return;
        setCurrentStroke(strokeNum + 1);
        setQuizMessage(strokesRemaining
          ? `Stroke ${strokeNum + 1} accepted. ${strokesRemaining} remaining.`
          : "Final stroke accepted.");
      },
      onComplete: () => {
        if (writerRef.current !== writer) return;
        setQuizMessage("Tracing complete.");
        onChange("passed");
      },
    });
  }, [onChange, strokeTolerance]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    centerOffsetRef.current = centerOffset;
  }, [centerOffset]);

  useEffect(() => {
    let active = true;
    if (question.unavailableReason) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    loadStrokeCharacterData(language, question.character)
      .then((next) => {
        if (!active) return;
        setData(next);
        setCenterOffset(characterCenterOffset(next));
        setStatus("ready");
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Stroke data could not be loaded.");
        setStatus("error");
      });
    return () => {
      active = false;
      animationRunRef.current += 1;
      writerRef.current?.cancelQuiz();
      void writerRef.current?.hideCharacter({ duration: 0 });
      writerRef.current = null;
    };
  }, [language, question.character, question.unavailableReason]);

  useEffect(() => {
    if (!question.requireStrokeOrder || !data || !targetRef.current || disabled) return;
    let active = true;
    let centerFrame: number | null = null;
    setAnimating(false);
    const target = targetRef.current;
    target.replaceChildren();
    void import("hanzi-writer").then(({ default: HanziWriter }) => {
      if (!active) return;
      const writer = HanziWriter.create(target, question.character, {
        width: DRAWING_SIZE,
        height: DRAWING_SIZE,
        padding: DRAWING_PADDING,
        showCharacter: false,
        showOutline: true,
        strokeColor: "#6e5de7",
        outlineColor: "#aaa5bb",
        drawingColor: "#6e5de7",
        highlightColor: "#e2668d",
        strokeAnimationSpeed: reducedMotion ? 8 : 1,
        delayBetweenStrokes: reducedMotion ? 0 : 350,
        delayBetweenLoops: reducedMotion ? 0 : 800,
        charDataLoader: () => data,
      });
      writerRef.current = writer;
      startQuiz(writer);
      const centerRenderedCharacter = (attempt = 0) => {
        centerFrame = window.requestAnimationFrame(() => {
          if (writerRef.current !== writer || !gridRef.current) return;
          const pathRects = Array.from(target.querySelectorAll<SVGPathElement>("path"))
            .map((path) => path.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0);
          if (!pathRects.length) {
            if (attempt < 12) centerRenderedCharacter(attempt + 1);
            return;
          }
          const bounds = pathRects.reduce((current, rect) => ({
            left: Math.min(current.left, rect.left),
            right: Math.max(current.right, rect.right),
            top: Math.min(current.top, rect.top),
            bottom: Math.max(current.bottom, rect.bottom),
          }), {
            left: Number.POSITIVE_INFINITY,
            right: Number.NEGATIVE_INFINITY,
            top: Number.POSITIVE_INFINITY,
            bottom: Number.NEGATIVE_INFINITY,
          });
          const grid = gridRef.current.getBoundingClientRect();
          const current = centerOffsetRef.current;
          setCenterOffset({
            x: clampCenterOffset(current.x + (grid.left + grid.width / 2 - (bounds.left + bounds.right) / 2)),
            y: clampCenterOffset(current.y + (grid.top + grid.height / 2 - (bounds.top + bounds.bottom) / 2)),
          });
        });
      };
      centerRenderedCharacter();
    });
    return () => {
      active = false;
      if (centerFrame !== null) window.cancelAnimationFrame(centerFrame);
      animationRunRef.current += 1;
      writerRef.current?.cancelQuiz();
      void writerRef.current?.hideCharacter({ duration: 0 });
      writerRef.current = null;
    };
  }, [data, disabled, question.character, question.requireStrokeOrder, reducedMotion, startQuiz]);

  function toggleAnimation() {
    const writer = writerRef.current;
    if (!writer) return;
    if (animating) {
      startQuiz(writer);
      return;
    }
    const run = animationRunRef.current + 1;
    animationRunRef.current = run;
    setAnimating(true);
    setCurrentStroke(0);
    setQuizMessage(loopAnimation && !reducedMotion
      ? "Looping the complete stroke order..."
      : "Animating the complete stroke order...");
    writer.cancelQuiz();
    if (loopAnimation && !reducedMotion) {
      void writer.loopCharacterAnimation().then(() => {
        if (writerRef.current !== writer || animationRunRef.current !== run) return;
        startQuiz(writer);
      });
      return;
    }
    void writer.animateCharacter({
      onComplete: ({ canceled }) => {
        if (writerRef.current !== writer || animationRunRef.current !== run) return;
        setAnimating(false);
        if (canceled || disabled || completed) return;
        startQuiz(writer);
      },
    });
  }

  return (
    <section className="character-tracing-response" aria-label={`Trace ${question.character}`}>
      <div className="character-tracing-heading">
        <div>
          <strong>{question.character}</strong>
          {question.reading ? <span>{question.reading}</span> : null}
        </div>
        {question.meaning ? <p>{question.meaning}</p> : null}
      </div>
      {status === "loading" ? <p className="tracing-loading"><LoaderCircle className="spin" size={18} /> Loading local stroke data...</p> : null}
      {status === "error" ? (
        <div className="tracing-unavailable" role="status">
          <p>{error || "Character tracing is unavailable for this language."}</p>
          {onUnavailable ? <button type="button" className="secondary-button" onClick={onUnavailable}><Play size={15} /> Use alternate exercise</button> : null}
        </div>
      ) : null}
      {status === "ready" && data && question.requireStrokeOrder ? (
        <>
          <div className="tracing-grid" ref={gridRef}>
            <div
              className="hanzi-writer-target"
              ref={targetRef}
              style={offsetStyle(centerOffset)}
              onPointerDown={onStart}
            />
            {showStrokeGuide && !completed && !animating ? (
              <StrokeGuide median={data.medians[currentStroke]} offset={centerOffset} />
            ) : null}
          </div>
          <div className="tracing-instruction">
            <p role="status">{completed ? "Tracing complete." : quizMessage}</p>
            <div className="tracing-animation-controls">
              <label title={reducedMotion ? "Loop is unavailable while reduced motion is enabled." : undefined}>
                <input
                  type="checkbox"
                  checked={loopAnimation}
                  onChange={(event) => setLoopAnimation(event.target.checked)}
                  disabled={disabled || animating || reducedMotion}
                />
                Loop
              </label>
              <button
                type="button"
                className="icon-text-button"
                onClick={toggleAnimation}
                disabled={disabled}
              >
                {animating
                  ? loopAnimation && !reducedMotion
                    ? <Square size={14} />
                    : <LoaderCircle className="spin" size={15} />
                  : <Play size={15} />}
                {animating ? "Stop animation" : "Animate strokes"}
              </button>
            </div>
          </div>
        </>
      ) : null}
      {status === "ready" && data && !question.requireStrokeOrder ? (
        <FreeShapeCanvas
          data={data}
          disabled={disabled || completed}
          offset={centerOffset}
          onStart={onStart}
          onComplete={() => onChange("passed")}
        />
      ) : null}
    </section>
  );
}
