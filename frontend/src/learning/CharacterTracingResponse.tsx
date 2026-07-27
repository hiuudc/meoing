import { LoaderCircle, Play, RotateCcw, Square, Volume2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { CharacterJson, Point } from "hanzi-writer";
import type { CharacterTracingQuestion, QuestionAnswer } from "./types";
import {
  loadStrokeCharacterData,
  type LoadedStrokeCharacterData,
} from "./strokeData";
import {
  createStrokeProgressCells,
  createStrokeGuideSamples,
  projectPointerToStrokeGuide,
  strokeGuidePath,
  strokeGuidePosition,
  strokeProgressCellPath,
  type StrokeGuidePoint,
  type StrokeGuidePosition,
} from "./strokeGuide";

interface CharacterTracingResponseProps {
  question: CharacterTracingQuestion;
  language: string;
  answer: QuestionAnswer;
  disabled?: boolean;
  onChange: (answer: QuestionAnswer) => void;
  onUnavailable?: () => void;
  onStart?: () => void;
  onSpeak?: (character: string) => void;
  requireStrokeOrder?: boolean;
  strokeTolerance?: number;
  showStrokeGuide?: boolean;
}

interface DrawnStroke {
  points: Point[];
}

type HanziWriterInstance = import("hanzi-writer").default;

const DRAWING_SIZE = 280;
const DRAWING_PADDING = 16;
const CHARACTER_CENTER = { x: 512, y: 388 };
const MAX_CENTER_OFFSET = 48;
const TRACING_AVERAGE_DISTANCE_THRESHOLD = 500;
const FORGIVING_TOLERANCE_THRESHOLD = 1.5;
const FORGIVING_MISS_LIMIT = 4;
const STROKE_ANIMATION_COLOR = "#6e5de7";
const STROKE_HIGHLIGHT_COLOR = "#e2668d";
const LOGICAL_STROKE_DELAY = 350;
const LOOP_ANIMATION_DELAY = 800;
const GUIDE_START_DISTANCE = 44;
const STROKE_DATA_SCALE = (DRAWING_SIZE - DRAWING_PADDING * 2) / 1_024;
const STROKE_DATA_BASELINE = DRAWING_SIZE - DRAWING_PADDING - 124 * STROKE_DATA_SCALE;
const STROKE_PATH_TRANSFORM = [
  `translate(${DRAWING_PADDING} ${STROKE_DATA_BASELINE})`,
  `scale(${STROKE_DATA_SCALE} ${-STROKE_DATA_SCALE})`,
].join(" ");
const STROKE_PROGRESS_BOUNDS = {
  minX: 0,
  minY: 0,
  maxX: DRAWING_SIZE,
  maxY: DRAWING_SIZE,
} as const;

function animationDelay(duration: number): Promise<void> {
  if (duration <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}

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

function StrokeGuide({
  median,
  strokePath,
  offset,
  containerRef,
}: {
  median?: number[][];
  strokePath?: string;
  offset: TraceOffset;
  containerRef: RefObject<HTMLDivElement>;
}) {
  const id = useId().replace(/[^a-z0-9_-]/gi, "");
  const markerId = `stroke-guide-marker-${id}`;
  const clipId = `stroke-guide-clip-${id}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const handleRef = useRef<SVGGElement>(null);
  const progressCellRefs = useRef(new Map<number, SVGPathElement>());
  const activePointerRef = useRef<number | null>(null);
  const progressIndexRef = useRef(0);
  const revealedProgressIndexRef = useRef(-1);
  const frameRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<StrokeGuidePosition | null>(null);
  const pendingRevealIndexRef = useRef(-1);
  const points = useMemo<StrokeGuidePoint[]>(() => (
    median?.map((point) => {
      const [x, y] = internalPointToDrawingPoint(point);
      return { x, y };
    }) ?? []
  ), [median]);
  const samples = useMemo(() => createStrokeGuideSamples(points), [points]);
  const path = useMemo(() => strokeGuidePath(samples), [samples]);
  const progressCells = useMemo(
    () => createStrokeProgressCells(samples, STROKE_PROGRESS_BOUNDS),
    [samples],
  );

  const setProgressCellVisibility = useCallback((nextIndex: number) => {
    const previousIndex = revealedProgressIndexRef.current;
    if (nextIndex === previousIndex) return;
    progressCellRefs.current.forEach((cell, sampleIndex) => {
      if (
        (sampleIndex <= previousIndex) === (sampleIndex <= nextIndex)
      ) {
        return;
      }
      const revealed = sampleIndex <= nextIndex;
      cell.setAttribute("opacity", revealed ? "1" : "0");
      cell.dataset.revealed = revealed ? "true" : "false";
    });
    revealedProgressIndexRef.current = nextIndex;
  }, []);

  const queueGuidePosition = useCallback((
    position: StrokeGuidePosition | null,
    revealIndex: number,
  ) => {
    pendingPositionRef.current = position;
    pendingRevealIndexRef.current = revealIndex;
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const next = pendingPositionRef.current;
      if (!next || !handleRef.current) return;
      handleRef.current.setAttribute(
        "transform",
        `translate(${next.x.toFixed(2)} ${next.y.toFixed(2)}) rotate(${next.angle.toFixed(2)})`,
      );
      setProgressCellVisibility(pendingRevealIndexRef.current);
    });
  }, [setProgressCellVisibility]);

  useEffect(() => {
    progressIndexRef.current = 0;
    revealedProgressIndexRef.current = -1;
    progressCellRefs.current.forEach((cell) => {
      cell.setAttribute("opacity", "0");
      cell.dataset.revealed = "false";
    });
    queueGuidePosition(strokeGuidePosition(samples, 0), -1);
  }, [progressCells, queueGuidePosition, samples]);

  useEffect(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg || samples.length < 2) return;

    const pointerInGuide = (event: PointerEvent): StrokeGuidePoint | null => {
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return null;
      return {
        x: (event.clientX - bounds.left) * DRAWING_SIZE / bounds.width,
        y: (event.clientY - bounds.top) * DRAWING_SIZE / bounds.height,
      };
    };
    const reset = (event?: PointerEvent) => {
      if (event && activePointerRef.current !== event.pointerId) return;
      activePointerRef.current = null;
      progressIndexRef.current = 0;
      queueGuidePosition(strokeGuidePosition(samples, 0), -1);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button > 0 || activePointerRef.current !== null) return;
      const pointer = pointerInGuide(event);
      if (!pointer || Math.hypot(pointer.x - samples[0].x, pointer.y - samples[0].y) > GUIDE_START_DISTANCE) {
        return;
      }
      activePointerRef.current = event.pointerId;
      progressIndexRef.current = 0;
      const position = projectPointerToStrokeGuide(samples, pointer, 0);
      queueGuidePosition(position, position?.index ?? -1);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (activePointerRef.current !== event.pointerId) return;
      const pointer = pointerInGuide(event);
      if (!pointer) return;
      const position = projectPointerToStrokeGuide(samples, pointer, progressIndexRef.current);
      if (!position) return;
      progressIndexRef.current = position.index;
      queueGuidePosition(position, position.index);
    };

    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", reset);
    window.addEventListener("pointercancel", reset);
    return () => {
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", reset);
      window.removeEventListener("pointercancel", reset);
      activePointerRef.current = null;
    };
  }, [containerRef, queueGuidePosition, samples]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  if (!path) return null;

  return (
    <svg
      ref={svgRef}
      className="stroke-guide"
      viewBox={`0 0 ${DRAWING_SIZE} ${DRAWING_SIZE}`}
      style={offsetStyle(offset)}
      aria-hidden="true"
    >
      <defs>
        {strokePath ? (
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            <path d={strokePath} transform={STROKE_PATH_TRANSFORM} />
          </clipPath>
        ) : null}
        <marker id={markerId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M 0 0 L 6 3 L 0 6 Z" />
        </marker>
      </defs>
      {strokePath && progressCells.length ? (
        <g
          className="stroke-guide-progress-cells"
          clipPath={`url(#${clipId})`}
        >
          {progressCells.map((cell) => (
            <path
              key={cell.sampleIndex}
              ref={(node) => {
                if (node) progressCellRefs.current.set(cell.sampleIndex, node);
                else progressCellRefs.current.delete(cell.sampleIndex);
              }}
              className="stroke-guide-progress-cell"
              d={strokeProgressCellPath(cell.points)}
              data-sample-index={cell.sampleIndex}
              data-revealed="false"
              opacity="0"
            />
          ))}
        </g>
      ) : null}
      <path
        className="stroke-guide-path"
        d={path}
        markerEnd={`url(#${markerId})`}
      />
      <g ref={handleRef} className="stroke-guide-handle">
        <circle r="9" />
        <path d="M -4 0 H 3 M 0 -3 L 3 0 L 0 3" />
      </g>
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
  onSpeak,
  requireStrokeOrder: requireStrokeOrderOverride,
  strokeTolerance = 1,
  showStrokeGuide = true,
}: CharacterTracingResponseProps) {
  const requireStrokeOrder = requireStrokeOrderOverride ?? question.requireStrokeOrder;
  const gridRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const animationTargetRef = useRef<HTMLDivElement>(null);
  const writerRef = useRef<HanziWriterInstance | null>(null);
  const animationWriterRef = useRef<HanziWriterInstance | null>(null);
  const animationRunRef = useRef(0);
  const centerOffsetRef = useRef<TraceOffset>({ x: 0, y: 0 });
  const [data, setData] = useState<LoadedStrokeCharacterData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState(question.unavailableReason ?? "");
  const [quizMessage, setQuizMessage] = useState(() => quizInstructions(strokeTolerance));
  const [animating, setAnimating] = useState(false);
  const [hinting, setHinting] = useState(false);
  const [loopAnimation, setLoopAnimation] = useState(false);
  const [currentStroke, setCurrentStroke] = useState(0);
  const [centerOffset, setCenterOffset] = useState<TraceOffset>({ x: 0, y: 0 });
  const [reducedMotion, setReducedMotion] = useState(false);
  const completed = answer === "passed";

  const cancelVisualAnimation = useCallback(() => {
    animationRunRef.current += 1;
    setHinting(false);
    void animationWriterRef.current?.hideCharacter({ duration: 0 });
  }, []);

  const playAnimationGroups = useCallback(async (
    animationWriter: HanziWriterInstance,
    groups: number[][],
    run: number,
    color: string,
    groupDelay: number,
  ): Promise<boolean> => {
    await animationWriter.updateColor("strokeColor", color, { duration: 0 });
    await animationWriter.hideCharacter({ duration: 0 });
    if (animationRunRef.current !== run) return false;

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      for (const rawStrokeIndex of groups[groupIndex]) {
        if (animationRunRef.current !== run) return false;
        const result = await animationWriter.animateStroke(rawStrokeIndex);
        if (animationRunRef.current !== run || result?.canceled) return false;
      }
      if (groupIndex < groups.length - 1 && groupDelay > 0) {
        await animationDelay(groupDelay);
        if (animationRunRef.current !== run) return false;
      }
    }
    return animationRunRef.current === run;
  }, []);

  const playStrokeHint = useCallback((strokeNum: number) => {
    const animationWriter = animationWriterRef.current;
    const group = data?.animationGroups[strokeNum];
    if (!animationWriter || !group?.length) return;
    const run = animationRunRef.current + 1;
    animationRunRef.current = run;
    setHinting(true);
    void (async () => {
      const played = await playAnimationGroups(
        animationWriter,
        [group],
        run,
        STROKE_HIGHLIGHT_COLOR,
        0,
      );
      if (!played) return;
      await animationDelay(reducedMotion ? 0 : 240);
      if (animationRunRef.current !== run) return;
      await animationWriter.hideCharacter({ duration: 0 });
      if (animationRunRef.current === run) setHinting(false);
    })();
  }, [data, playAnimationGroups, reducedMotion]);

  const startQuiz = useCallback((writer: HanziWriterInstance) => {
    cancelVisualAnimation();
    setAnimating(false);
    setCurrentStroke(0);
    setQuizMessage(quizInstructions(strokeTolerance));
    void writer.quiz({
      leniency: strokeTolerance,
      averageDistanceThreshold: TRACING_AVERAGE_DISTANCE_THRESHOLD,
      showHintAfterMisses: false,
      markStrokeCorrectAfterMisses: strokeTolerance >= FORGIVING_TOLERANCE_THRESHOLD
        ? FORGIVING_MISS_LIMIT
        : false,
      highlightOnComplete: true,
      onMistake: ({ strokeNum, mistakesOnStroke }) => {
        if (writerRef.current !== writer) return;
        setQuizMessage(`Stroke ${strokeNum + 1} was not recognized. Miss ${mistakesOnStroke}; follow the highlighted path.`);
        if (mistakesOnStroke >= 2) playStrokeHint(strokeNum);
      },
      onCorrectStroke: ({ strokeNum, strokesRemaining }) => {
        if (writerRef.current !== writer) return;
        cancelVisualAnimation();
        setCurrentStroke(strokeNum + 1);
        setQuizMessage(strokesRemaining
          ? `Stroke ${strokeNum + 1} accepted. ${strokesRemaining} remaining.`
          : "Final stroke accepted.");
      },
      onComplete: () => {
        if (writerRef.current !== writer) return;
        cancelVisualAnimation();
        setQuizMessage("Tracing complete.");
        onChange("passed");
      },
    });
  }, [cancelVisualAnimation, onChange, playStrokeHint, strokeTolerance]);

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
        setCenterOffset(characterCenterOffset(next.logicalData));
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
      void animationWriterRef.current?.hideCharacter({ duration: 0 });
      writerRef.current = null;
      animationWriterRef.current = null;
    };
  }, [language, question.character, question.unavailableReason]);

  useEffect(() => {
    if (
      !requireStrokeOrder
      || !data
      || !targetRef.current
      || !animationTargetRef.current
      || disabled
    ) return;
    let active = true;
    let centerFrame: number | null = null;
    setAnimating(false);
    setHinting(false);
    const target = targetRef.current;
    const animationTarget = animationTargetRef.current;
    target.replaceChildren();
    animationTarget.replaceChildren();
    void import("hanzi-writer").then(({ default: HanziWriter }) => {
      if (!active) return;
      const writer = HanziWriter.create(target, question.character, {
        width: DRAWING_SIZE,
        height: DRAWING_SIZE,
        padding: DRAWING_PADDING,
        showCharacter: false,
        showOutline: true,
        strokeColor: STROKE_ANIMATION_COLOR,
        outlineColor: "#aaa5bb",
        drawingColor: STROKE_ANIMATION_COLOR,
        highlightColor: STROKE_HIGHLIGHT_COLOR,
        strokeAnimationSpeed: reducedMotion ? 8 : 1,
        delayBetweenStrokes: reducedMotion ? 0 : LOGICAL_STROKE_DELAY,
        delayBetweenLoops: reducedMotion ? 0 : LOOP_ANIMATION_DELAY,
        charDataLoader: () => data.logicalData,
      });
      const animationWriter = HanziWriter.create(animationTarget, question.character, {
        width: DRAWING_SIZE,
        height: DRAWING_SIZE,
        padding: DRAWING_PADDING,
        showCharacter: false,
        showOutline: false,
        strokeColor: STROKE_ANIMATION_COLOR,
        outlineColor: "#000000",
        strokeAnimationSpeed: reducedMotion ? 8 : 1,
        delayBetweenStrokes: 0,
        delayBetweenLoops: 0,
        charDataLoader: () => data.animationData,
      });
      writerRef.current = writer;
      animationWriterRef.current = animationWriter;
      void animationWriter.hideCharacter({ duration: 0 });
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
      void animationWriterRef.current?.hideCharacter({ duration: 0 });
      writerRef.current = null;
      animationWriterRef.current = null;
    };
  }, [data, disabled, question.character, reducedMotion, requireStrokeOrder, startQuiz]);

  function toggleAnimation() {
    const writer = writerRef.current;
    const animationWriter = animationWriterRef.current;
    if (!writer || !animationWriter || !data) return;
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
    void writer.hideCharacter({ duration: 0 });
    setHinting(false);
    void (async () => {
      const shouldLoop = loopAnimation && !reducedMotion;
      do {
        const played = await playAnimationGroups(
          animationWriter,
          data.animationGroups,
          run,
          STROKE_ANIMATION_COLOR,
          reducedMotion ? 0 : LOGICAL_STROKE_DELAY,
        );
        if (!played) return;
        if (!shouldLoop) break;
        await animationDelay(LOOP_ANIMATION_DELAY);
      } while (
        writerRef.current === writer
        && animationWriterRef.current === animationWriter
        && animationRunRef.current === run
      );
      if (
        writerRef.current !== writer
        || animationWriterRef.current !== animationWriter
        || animationRunRef.current !== run
      ) return;
      if (disabled || completed) {
        setAnimating(false);
        await animationWriter.hideCharacter({ duration: 0 });
        return;
      }
      startQuiz(writer);
    })();
  }

  function handleTracingStart() {
    if (animating) return;
    cancelVisualAnimation();
    onStart?.();
  }

  return (
    <section className="character-tracing-response" aria-label={`Trace ${question.character}`}>
      <div className="character-tracing-heading">
        <div className="character-tracing-identity">
          {onSpeak ? (
            <button
              type="button"
              aria-label={`Play ${question.character} pronunciation`}
              title="Play pronunciation"
              onClick={() => onSpeak(question.character)}
            >
              <Volume2 size={18} />
            </button>
          ) : null}
          <div className="character-tracing-glyph">
            <strong>{question.character}</strong>
            {question.reading ? <span>{question.reading}</span> : null}
          </div>
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
      {status === "ready" && data && requireStrokeOrder ? (
        <>
          <div className="tracing-grid" ref={gridRef}>
            <div
              className="hanzi-writer-target"
              ref={targetRef}
              style={offsetStyle(centerOffset)}
              onPointerDown={handleTracingStart}
            />
            <div
              className="hanzi-writer-animation-target"
              ref={animationTargetRef}
              style={offsetStyle(centerOffset)}
              aria-hidden="true"
            />
            {showStrokeGuide && !completed && !animating && !hinting ? (
              <StrokeGuide
                median={data.logicalData.medians[currentStroke]}
                strokePath={data.logicalData.strokes[currentStroke]}
                offset={centerOffset}
                containerRef={gridRef}
              />
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
      {status === "ready" && data && !requireStrokeOrder ? (
        <FreeShapeCanvas
          data={data.logicalData}
          disabled={disabled || completed}
          offset={centerOffset}
          onStart={onStart}
          onComplete={() => onChange("passed")}
        />
      ) : null}
    </section>
  );
}
