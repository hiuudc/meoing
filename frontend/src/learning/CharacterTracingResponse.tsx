import { LoaderCircle, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
}

interface DrawnStroke {
  points: Point[];
}

const DRAWING_SIZE = 280;

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

function FreeShapeCanvas({
  data,
  disabled,
  onComplete,
  onStart,
}: {
  data: CharacterJson;
  disabled?: boolean;
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
}: CharacterTracingResponseProps) {
  const targetRef = useRef<HTMLDivElement>(null);
  const writerRef = useRef<import("hanzi-writer").default | null>(null);
  const [data, setData] = useState<CharacterJson | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState(question.unavailableReason ?? "");
  const completed = answer === "passed";

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
        setStatus("ready");
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Stroke data could not be loaded.");
        setStatus("error");
      });
    return () => {
      active = false;
      writerRef.current?.cancelQuiz();
      writerRef.current = null;
    };
  }, [language, question.character, question.unavailableReason]);

  useEffect(() => {
    if (!question.requireStrokeOrder || !data || !targetRef.current || disabled) return;
    let active = true;
    const target = targetRef.current;
    target.replaceChildren();
    void import("hanzi-writer").then(({ default: HanziWriter }) => {
      if (!active) return;
      const writer = HanziWriter.create(target, question.character, {
        width: DRAWING_SIZE,
        height: DRAWING_SIZE,
        padding: 16,
        showCharacter: false,
        showOutline: true,
        strokeColor: "#6e5de7",
        outlineColor: "#aaa5bb",
        drawingColor: "#6e5de7",
        highlightColor: "#e2668d",
        charDataLoader: () => data,
      });
      writerRef.current = writer;
      void writer.quiz({
        showHintAfterMisses: 2,
        highlightOnComplete: true,
        onComplete: () => onChange("passed"),
      });
    });
    return () => {
      active = false;
      writerRef.current?.cancelQuiz();
      writerRef.current = null;
    };
  }, [data, disabled, onChange, question.character, question.requireStrokeOrder]);

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
          <div className="hanzi-writer-target" ref={targetRef} onPointerDown={onStart} />
          <div className="tracing-instruction">
            <p>{completed ? "Tracing complete." : "Follow the stroke order. A hint appears after two misses."}</p>
            <button
              type="button"
              className="icon-text-button"
              onClick={() => {
                const writer = writerRef.current;
                if (!writer) return;
                writer.cancelQuiz();
                void writer.animateCharacter({
                  onComplete: () => {
                    if (disabled || completed) return;
                    void writer.quiz({
                      showHintAfterMisses: 2,
                      highlightOnComplete: true,
                      onComplete: () => onChange("passed"),
                    });
                  },
                });
              }}
              disabled={disabled}
            >
              <Play size={15} /> Animate strokes
            </button>
          </div>
        </>
      ) : null}
      {status === "ready" && data && !question.requireStrokeOrder ? (
        <FreeShapeCanvas data={data} disabled={disabled || completed} onStart={onStart} onComplete={() => onChange("passed")} />
      ) : null}
    </section>
  );
}
