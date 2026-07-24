import {
  Headphones,
  Keyboard,
  Mic,
  RotateCcw,
  Volume2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CharacterTracingResponse } from "./CharacterTracingResponse";
import { SpeakingRecorder, supportsSpeechRecognition } from "./SpeakingRecorder";
import { languageTagForSpeech } from "./speech";
import type {
  AnswerBank,
  ChoiceOption,
  LessonQuestion,
  QuestionAnswer,
  SpeakingSubmission,
} from "./types";

interface QuestionRendererProps {
  question: LessonQuestion;
  answer: QuestionAnswer;
  language: string;
  disabled?: boolean;
  evaluated?: boolean;
  onChange: (answer: QuestionAnswer) => void;
  onAnswerActivate?: (text: string) => void;
  onSpeakTarget?: (text: string) => void;
  onSpeakingChange?: (submission: SpeakingSubmission | null) => void;
  onRequireAlternate?: () => void;
  renderText?: (text: string, interactive?: boolean) => ReactNode;
  answerInputMode?: AnswerInputMode;
}

type TextRenderer = (text: string, interactive?: boolean) => ReactNode;
export type AnswerInputMode = "keyboard" | "bank";

export function answerBankForQuestion(question: LessonQuestion): AnswerBank | undefined {
  if (question.answerBank) return question.answerBank;
  if (question.type !== "freeWriting" || !question.supportBank?.length) return undefined;
  return {
    tokens: question.supportBank,
    separator: question.supportBankSeparator ?? "space",
    defaultMode: "keyboard",
  };
}

function stringAnswer(answer: QuestionAnswer): string {
  return typeof answer === "string" ? answer : "";
}

function stringArrayAnswer(answer: QuestionAnswer): string[] {
  return Array.isArray(answer) ? answer : [];
}

function mapAnswer(answer: QuestionAnswer): Record<string, string> {
  return answer && typeof answer === "object" && !Array.isArray(answer) ? answer : {};
}

function TextResponse({
  value,
  onChange,
  disabled,
  label,
  multiline = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  multiline?: boolean;
}) {
  return (
    <label className="question-text-response">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={5} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} />
      ) : (
        <input value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} autoComplete="off" />
      )}
    </label>
  );
}

function moveItem(values: string[], sourceId: string, targetIndex: number): string[] {
  const sourceIndex = values.indexOf(sourceId);
  if (sourceIndex < 0) return values;
  const next = [...values];
  next.splice(sourceIndex, 1);
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, sourceId);
  return next;
}

interface PointerDrag {
  id: string;
  label: string;
  origin: "tray" | "bank";
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
}

interface DragPreview {
  id: string;
  label: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

export function OrderedAnswerComposer({
  options,
  value,
  onChange,
  onAnswerActivate,
  disabled,
  evaluated,
  renderText,
  maxSelections,
}: {
  options: ChoiceOption[];
  value: string[];
  onChange: (value: string[]) => void;
  onAnswerActivate?: (text: string) => void;
  disabled?: boolean;
  evaluated?: boolean;
  renderText: TextRenderer;
  maxSelections?: number;
}) {
  const labels = useMemo(() => new Map(options.map((option) => [option.id, option.label])), [options]);
  const trayRef = useRef<HTMLDivElement>(null);
  const bankRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef("");
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function announce(message: string) {
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement(message));
  }

  function moveBy(id: string, direction: -1 | 1) {
    const index = value.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    announce(`${labels.get(id) ?? id} moved to position ${target + 1}.`);
  }

  function insertionIndex(clientX: number, clientY: number, excludedId?: string): number {
    const elements = Array.from(
      trayRef.current?.querySelectorAll<HTMLElement>("[data-answer-token-id]") ?? [],
    ).filter((element) => element.dataset.answerTokenId !== excludedId);
    const target = elements.find((element) => {
      const rect = element.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2
        || (clientY <= rect.bottom && clientX < rect.left + rect.width / 2);
    });
    if (!target) return elements.length;
    return elements.indexOf(target);
  }

  function startPointerDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    id: string,
    label: string,
    origin: PointerDrag["origin"],
  ) {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      id,
      label,
      origin,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragPreview({
      id,
      label,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
    });
  }

  function movePointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 7) {
      drag.moved = true;
      dragPreviewRef.current?.removeAttribute("hidden");
    }
    if (!drag.moved || !dragPreviewRef.current) return;
    dragPreviewRef.current.style.transform = `translate3d(${event.clientX - drag.offsetX}px, ${event.clientY - drag.offsetY}px, 0)`;
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragPreview(null);
    if (!drag?.moved) return;
    const trayRect = trayRef.current?.getBoundingClientRect();
    const bankRect = bankRef.current?.getBoundingClientRect();
    const overTray = Boolean(trayRect
      && event.clientX >= trayRect.left && event.clientX <= trayRect.right
      && event.clientY >= trayRect.top && event.clientY <= trayRect.bottom);
    const overBank = Boolean(bankRect
      && event.clientX >= bankRect.left && event.clientX <= bankRect.right
      && event.clientY >= bankRect.top && event.clientY <= bankRect.bottom);

    if (drag.origin === "bank" && overTray) {
      if (maxSelections === undefined || value.length < maxSelections) {
        const next = [...value];
        const targetIndex = insertionIndex(event.clientX, event.clientY);
        next.splice(targetIndex, 0, drag.id);
        onAnswerActivate?.(drag.label);
        onChange(next);
        announce(`${drag.label} added at position ${targetIndex + 1}.`);
      }
    } else if (drag.origin === "tray" && overBank) {
      onChange(value.filter((valueId) => valueId !== drag.id));
      announce(`${drag.label} returned to the word bank.`);
    } else if (drag.origin === "tray" && overTray) {
      const targetIndex = insertionIndex(event.clientX, event.clientY, drag.id);
      const next = moveItem(value, drag.id, targetIndex);
      onChange(next);
      announce(`${drag.label} moved to position ${next.indexOf(drag.id) + 1}.`);
    }
    suppressClickRef.current = drag.id;
  }

  function cancelPointerDrag() {
    dragRef.current = null;
    setDragPreview(null);
  }

  function handleSelectedKey(event: ReactKeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onChange(value.filter((valueId) => valueId !== id));
      announce(`${labels.get(id) ?? id} returned to the word bank.`);
      return;
    }
    if (!event.altKey || !["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    moveBy(id, event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
  }

  const portalTarget = document.querySelector<HTMLElement>(".app-shell") ?? document.body;
  return (
    <div className="answer-composer">
      <p className="sr-only">Selected order</p>
      <div className={value.length ? "answer-tray" : "answer-tray is-empty"} ref={trayRef} aria-label="Selected answer">
        {value.map((id, index) => (
          <button
            type="button"
            key={id}
            className="answer-token"
            data-answer-token-id={id}
            aria-label={`${labels.get(id) ?? id}, position ${index + 1}. Alt plus arrow keys reorders; Delete returns it to the bank.`}
            onPointerDown={(event) => startPointerDrag(event, id, labels.get(id) ?? id, "tray")}
            onPointerMove={movePointerDrag}
            onPointerUp={finishPointerDrag}
            onPointerCancel={cancelPointerDrag}
            onKeyDown={(event) => handleSelectedKey(event, id)}
            onClick={() => {
              if (suppressClickRef.current === id) {
                suppressClickRef.current = "";
                return;
              }
              onAnswerActivate?.(labels.get(id) ?? id);
              onChange(value.filter((valueId) => valueId !== id));
              announce(`${labels.get(id) ?? id} returned to the word bank.`);
            }}
            disabled={disabled}
          >
            {renderText(labels.get(id) ?? id, Boolean(evaluated))}
          </button>
        ))}
      </div>
      <div className="token-bank" ref={bankRef} aria-label="Available words">
        {options.map((option) => value.includes(option.id) ? (
          <span className="token-bank-placeholder" key={option.id} aria-hidden="true">
            {renderText(option.label, false)}
          </span>
        ) : (
          <button
            type="button"
            key={option.id}
            onPointerDown={(event) => startPointerDrag(event, option.id, option.label, "bank")}
            onPointerMove={movePointerDrag}
            onPointerUp={finishPointerDrag}
            onPointerCancel={cancelPointerDrag}
            onClick={() => {
              if (suppressClickRef.current === option.id) {
                suppressClickRef.current = "";
                return;
              }
              onAnswerActivate?.(option.label);
              if (maxSelections !== undefined && value.length >= maxSelections) return;
              onChange([...value, option.id]);
              announce(`${option.label} added at position ${value.length + 1}.`);
            }}
            disabled={disabled || (maxSelections !== undefined && value.length >= maxSelections)}
          >
            {renderText(option.label, Boolean(evaluated))}
          </button>
        ))}
      </div>
      {value.length ? (
        <button className="question-reset-button" type="button" onClick={() => onChange([])} disabled={disabled}>
          <RotateCcw size={14} /> Reset answer
        </button>
      ) : null}
      <p className="sr-only" aria-live="polite">{announcement}</p>
      {dragPreview ? createPortal(
        <div
          ref={dragPreviewRef}
          className="answer-token-drag-preview"
          hidden
          aria-hidden="true"
          style={{
            width: dragPreview.width,
            height: dragPreview.height,
            transform: `translate3d(${dragPreview.x}px, ${dragPreview.y}px, 0)`,
          }}
        >
          {renderText(dragPreview.label, false)}
        </div>,
        portalTarget,
      ) : null}
    </div>
  );
}

function joinedTokenText(bank: AnswerBank, ids: string[]): string {
  const labels = new Map(bank.tokens.map((token) => [token.id, token.label]));
  return ids.map((id) => labels.get(id) ?? "").filter(Boolean).join(bank.separator === "none" ? "" : " ");
}

function composedBankText(bank: AnswerBank, baseText: string, ids: string[]): string {
  const selected = joinedTokenText(bank, ids);
  const separator = bank.separator === "none" ? "" : " ";
  return baseText && selected ? `${baseText.trimEnd()}${separator}${selected}` : baseText || selected;
}

function AnswerBankResponse({
  bank,
  value,
  onChange,
  inputMode,
  label,
  multiline,
  disabled,
  evaluated,
  onAnswerActivate,
  renderText,
}: {
  bank?: AnswerBank;
  value: string;
  onChange: (value: string) => void;
  inputMode?: AnswerInputMode;
  label: string;
  multiline?: boolean;
  disabled?: boolean;
  evaluated?: boolean;
  onAnswerActivate?: (text: string) => void;
  renderText: TextRenderer;
}) {
  const mode = inputMode ?? bank?.defaultMode ?? "keyboard";
  const [keyboardDraft, setKeyboardDraft] = useState(value);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const previousModeRef = useRef(mode);
  const bankDraft = bank ? composedBankText(bank, "", selectedIds) : "";

  useEffect(() => {
    if (!bank || previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    onChange(mode === "keyboard" ? keyboardDraft : bankDraft);
  }, [bank, bankDraft, keyboardDraft, mode, onChange]);

  if (!bank) return <TextResponse value={value} onChange={onChange} label={label} multiline={multiline} disabled={disabled} />;

  function updateBank(ids: string[]) {
    setSelectedIds(ids);
    onChange(composedBankText(bank!, "", ids));
  }

  return (
    <div className="answer-bank-response">
      {mode === "keyboard" ? (
        <TextResponse
          value={keyboardDraft}
          onChange={(next) => {
            setKeyboardDraft(next);
            onChange(next);
          }}
          label={label}
          multiline={multiline}
          disabled={disabled}
        />
      ) : (
        <OrderedAnswerComposer
          options={bank.tokens}
          value={selectedIds}
          onChange={updateBank}
          onAnswerActivate={onAnswerActivate}
          disabled={disabled}
          evaluated={evaluated}
          renderText={renderText}
        />
      )}
    </div>
  );
}

function MultiClozeResponse({
  question,
  answer,
  onChange,
  inputMode,
  disabled,
  evaluated,
  onAnswerActivate,
  renderText,
}: {
  question: Extract<LessonQuestion, { type: "multiCloze" }>;
  answer: QuestionAnswer;
  onChange: (answer: QuestionAnswer) => void;
  inputMode?: AnswerInputMode;
  disabled?: boolean;
  evaluated?: boolean;
  onAnswerActivate?: (text: string) => void;
  renderText: TextRenderer;
}) {
  const values = mapAnswer(answer);
  const bank = question.answerBank;
  const mode = inputMode ?? bank?.defaultMode ?? "keyboard";
  const [keyboardValues, setKeyboardValues] = useState(values);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const previousModeRef = useRef(mode);

  useEffect(() => {
    if (!bank || previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    if (mode === "keyboard") {
      onChange(keyboardValues);
      return;
    }
    const labels = new Map(bank.tokens.map((token) => [token.id, token.label]));
    onChange(Object.fromEntries(question.blanks.map((blank, index) => [blank.id, labels.get(selectedIds[index]) ?? ""])));
  }, [bank, keyboardValues, mode, onChange, question.blanks, selectedIds]);

  function updateBank(ids: string[]) {
    if (!bank) return;
    setSelectedIds(ids);
    const labels = new Map(bank.tokens.map((token) => [token.id, token.label]));
    onChange(Object.fromEntries(question.blanks.map((blank, index) => [blank.id, labels.get(ids[index]) ?? ""])));
  }

  return (
    <div className="multi-cloze-response">
      <p>{renderText(question.template)}</p>
      {mode === "keyboard" || !bank ? (
        <div className="cloze-input-grid">
          {question.blanks.map((blank, index) => (
            <TextResponse
              key={blank.id}
              label={`Blank ${index + 1}`}
              value={keyboardValues[blank.id] ?? ""}
              onChange={(value) => {
                const next = { ...keyboardValues, [blank.id]: value };
                setKeyboardValues(next);
                onChange(next);
              }}
              disabled={disabled}
            />
          ))}
        </div>
      ) : (
        <OrderedAnswerComposer
          options={bank.tokens}
          value={selectedIds}
          onChange={updateBank}
          onAnswerActivate={onAnswerActivate}
          disabled={disabled}
          evaluated={evaluated}
          renderText={renderText}
          maxSelections={question.blanks.length}
        />
      )}
    </div>
  );
}

interface PairItem {
  leftId: string;
  leftText: string;
  rightId: string;
  rightText: string;
}

function stableShuffle<T extends { rightId: string }>(items: T[], seed: string): T[] {
  const hash = (value: string) => [...value].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) | 0, 7);
  return [...items].sort((left, right) => hash(`${seed}:${left.rightId}`) - hash(`${seed}:${right.rightId}`));
}

export function PairMatchingResponse({
  id,
  pairs,
  value,
  onChange,
  disabled,
  evaluated,
  renderText,
  onSpeakLeft,
  onSpeakRight,
  audioLeft = false,
}: {
  id: string;
  pairs: PairItem[];
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  disabled?: boolean;
  evaluated?: boolean;
  renderText: TextRenderer;
  onSpeakLeft?: (text: string) => void;
  onSpeakRight?: (text: string) => void;
  audioLeft?: boolean;
}) {
  const [selectedLeft, setSelectedLeft] = useState("");
  const [selectedRight, setSelectedRight] = useState("");
  const [wrong, setWrong] = useState<string[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const rightItems = useMemo(() => stableShuffle(pairs, id), [id, pairs]);
  const lockedRightIds = new Set(Object.values(value));

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  function tryPair(leftId: string, rightId: string) {
    const pair = pairs.find((candidate) => candidate.leftId === leftId);
    if (pair?.rightId === rightId) {
      onChange({ ...value, [leftId]: rightId });
      setSelectedLeft("");
      setSelectedRight("");
      return;
    }
    setWrong([leftId, rightId]);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setWrong([]);
      setSelectedLeft("");
      setSelectedRight("");
    }, 420);
  }

  function chooseLeft(pair: PairItem) {
    if (value[pair.leftId]) return;
    onSpeakLeft?.(pair.leftText);
    if (selectedRight) tryPair(pair.leftId, selectedRight);
    else setSelectedLeft(pair.leftId);
  }

  function chooseRight(pair: PairItem) {
    if (lockedRightIds.has(pair.rightId)) return;
    onSpeakRight?.(pair.rightText);
    if (selectedLeft) tryPair(selectedLeft, pair.rightId);
    else setSelectedRight(pair.rightId);
  }

  return (
    <div className="pair-matching" role="group" aria-label="Select matching pairs">
      <div className="pair-column">
        {pairs.map((pair, index) => {
          const locked = Boolean(value[pair.leftId]);
          return (
            <button
              type="button"
              key={pair.leftId}
              className={`${selectedLeft === pair.leftId ? "is-selected " : ""}${wrong.includes(pair.leftId) ? "is-wrong " : ""}${locked ? "is-locked" : ""}`}
              aria-pressed={selectedLeft === pair.leftId}
              onClick={() => chooseLeft(pair)}
              disabled={disabled || locked}
            >
              <span className="pair-index">{index + 1}</span>
              {audioLeft ? (
                <span className="pair-audio-content">
                  <Volume2 size={19} />
                  <AudioWaveform text={pair.leftText} />
                </span>
              ) : renderText(pair.leftText, Boolean(evaluated))}
            </button>
          );
        })}
      </div>
      <div className="pair-column">
        {rightItems.map((pair, index) => {
          const locked = lockedRightIds.has(pair.rightId);
          return (
            <button
              type="button"
              key={pair.rightId}
              className={`${selectedRight === pair.rightId ? "is-selected " : ""}${wrong.includes(pair.rightId) ? "is-wrong " : ""}${locked ? "is-locked" : ""}`}
              aria-pressed={selectedRight === pair.rightId}
              onClick={() => chooseRight(pair)}
              disabled={disabled || locked}
            >
              <span className="pair-index">{pairs.length + index + 1}</span>
              {renderText(pair.rightText, Boolean(evaluated))}
            </button>
          );
        })}
      </div>
      <p className="sr-only" aria-live="polite">{wrong.length ? "Those items do not match. Try again." : ""}</p>
    </div>
  );
}

function FreeWritingResponse({
  question,
  value,
  onChange,
  inputMode,
  onAnswerActivate,
  disabled,
  evaluated,
  renderText,
}: {
  question: Extract<LessonQuestion, { type: "freeWriting" }>;
  value: string;
  onChange: (value: string) => void;
  inputMode?: AnswerInputMode;
  onAnswerActivate?: (text: string) => void;
  disabled?: boolean;
  evaluated?: boolean;
  renderText: TextRenderer;
}) {
  const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0;
  return (
    <div className="open-response free-writing-response">
      <AnswerBankResponse
        bank={answerBankForQuestion(question)}
        value={value}
        onChange={onChange}
        inputMode={inputMode}
        label="Writing response"
        multiline
        disabled={disabled}
        evaluated={evaluated}
        onAnswerActivate={onAnswerActivate}
        renderText={renderText}
      />
      <p className="rubric-copy">{wordCount}/{question.minWords}-{question.maxWords} words · {question.rubric.join(" · ")}</p>
    </div>
  );
}

function waveformBars(text: string, count = 18): number[] {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return Array.from({ length: count }, (_, index) => {
    hash ^= index + 1;
    hash = Math.imul(hash, 16777619);
    return 26 + (Math.abs(hash) % 75);
  });
}

export function AudioWaveform({ text }: { text: string }) {
  const bars = useMemo(() => waveformBars(text), [text]);
  return (
    <span className="audio-waveform" aria-hidden="true">
      {bars.map((height, index) => <span style={{ height: `${height}%` }} key={`${index}-${height}`} />)}
    </span>
  );
}

function AudioPrompt({ text, onSpeak, label = "Play audio" }: { text: string; onSpeak?: (text: string) => void; label?: string }) {
  return (
    <button className="question-audio-prompt" type="button" onClick={() => onSpeak?.(text)} disabled={!onSpeak} aria-label={label}>
      <Headphones size={22} />
      <AudioWaveform text={text} />
    </button>
  );
}

function ReadOnlyTranscript({ value }: { value: string }) {
  return (
    <p className="speaking-transcript" aria-live="polite">
      <span>Recognized transcript</span>
      {value || "Start recording to capture your answer."}
    </p>
  );
}

export function QuestionRenderer({
  question,
  answer,
  language,
  disabled,
  evaluated,
  onChange,
  onAnswerActivate,
  onSpeakTarget,
  onSpeakingChange,
  onRequireAlternate,
  renderText,
  answerInputMode,
}: QuestionRendererProps) {
  const render = renderText ?? ((text: string) => text);
  const answerInteractive = Boolean(evaluated);

  switch (question.type) {
    case "singleChoice":
      return (
        <fieldset className="choice-list" disabled={disabled}>
          <legend className="sr-only">Choose one answer</legend>
          {question.options.map((option) => (
            <label key={option.id} className={stringAnswer(answer) === option.id ? "is-selected" : ""}>
              <input
                type="radio"
                name={question.id}
                value={option.id}
                checked={stringAnswer(answer) === option.id}
                onClick={() => onAnswerActivate?.(option.label)}
                onChange={() => onChange(option.id)}
              />
              <span>{render(option.label, answerInteractive)}</span>
            </label>
          ))}
        </fieldset>
      );
    case "multipleChoice": {
      const selected = stringArrayAnswer(answer);
      return (
        <fieldset className="choice-list" disabled={disabled}>
          <legend className="question-control-label">Choose all matching answers</legend>
          {question.options.map((option) => (
            <label key={option.id} className={selected.includes(option.id) ? "is-selected" : ""}>
              <input
                type="checkbox"
                value={option.id}
                checked={selected.includes(option.id)}
                onChange={(event) => {
                  onAnswerActivate?.(option.label);
                  onChange(event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id));
                }}
              />
              <span>{render(option.label, answerInteractive)}</span>
            </label>
          ))}
        </fieldset>
      );
    }
    case "trueFalse":
      return (
        <fieldset className="choice-list choice-list-inline" disabled={disabled}>
          <legend>{render(question.statement)}</legend>
          {[{ value: true, label: "True" }, { value: false, label: "False" }].map((option) => (
            <label key={String(option.value)} className={answer === option.value ? "is-selected" : ""}>
              <input
                type="radio"
                name={question.id}
                checked={answer === option.value}
                onClick={() => onAnswerActivate?.(option.label)}
                onChange={() => onChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      );
    case "fillBlank":
      return (
        <div className="blank-response">
          <p>{render(question.template)}</p>
          <AnswerBankResponse bank={question.answerBank} value={stringAnswer(answer)} onChange={onChange} inputMode={answerInputMode} label="Missing word or phrase" disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} renderText={render} />
        </div>
      );
    case "selectBlank": {
      const selectedId = stringAnswer(answer);
      const selectedOption = question.options.find((option) => option.id === selectedId);
      const [before, after] = question.template.split("{{blank}}");
      return (
        <div className="select-blank-response">
          <p className="select-blank-sentence">
            <span>{render(before)}</span>
            {selectedOption ? (
              <button
                type="button"
                className="select-blank-slot is-filled"
                aria-label={`Remove ${selectedOption.label} from the blank`}
                onClick={() => onChange("")}
                disabled={disabled}
              >
                {render(selectedOption.label, answerInteractive)}
              </button>
            ) : <span className="select-blank-slot" aria-label="Empty answer" />}
            <span>{render(after)}</span>
          </p>
          <div className="select-blank-options" role="group" aria-label="Blank choices">
            {question.options.map((option) => selectedId === option.id ? (
              <span className="select-blank-option-placeholder" key={option.id} aria-hidden="true">
                {render(option.label, false)}
              </span>
            ) : (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  onAnswerActivate?.(option.label);
                  onChange(option.id);
                }}
                disabled={disabled}
              >
                {render(option.label, answerInteractive)}
              </button>
            ))}
          </div>
        </div>
      );
    }
    case "multiCloze":
      return <MultiClozeResponse question={question} answer={answer} onChange={onChange} inputMode={answerInputMode} disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} renderText={render} />;
    case "wordBank":
    case "reorderTokens":
      return <OrderedAnswerComposer options={question.tokens} value={stringArrayAnswer(answer)} onChange={onChange} onAnswerActivate={onAnswerActivate} disabled={disabled} evaluated={evaluated} renderText={render} />;
    case "matching":
      return (
        <PairMatchingResponse
          id={question.id}
          pairs={question.pairs.map((pair) => ({ leftId: pair.leftId, leftText: pair.left, rightId: pair.rightId, rightText: pair.right }))}
          value={mapAnswer(answer)}
          onChange={onChange}
          disabled={disabled}
          evaluated={evaluated}
          renderText={render}
          onSpeakLeft={onAnswerActivate}
          onSpeakRight={onAnswerActivate}
        />
      );
    case "reorderDialogue":
      return (
        <OrderedAnswerComposer
          options={question.turns.map((turn) => ({ id: turn.id, label: `${turn.speaker}: ${turn.label}` }))}
          value={stringArrayAnswer(answer)}
          onChange={onChange}
          onAnswerActivate={onAnswerActivate}
          disabled={disabled}
          evaluated={evaluated}
          renderText={render}
        />
      );
    case "categorize": {
      const values = mapAnswer(answer);
      return (
        <div className="mapping-response" role="group" aria-label="Categorize items">
          {question.items.map((item) => (
            <label key={item.id}>
              <span>{render(item.label, answerInteractive)}</span>
              <select value={values[item.id] ?? ""} onChange={(event) => {
                const selected = question.categories.find((category) => category.id === event.target.value);
                if (selected) onAnswerActivate?.(selected.label);
                onChange({ ...values, [item.id]: event.target.value });
              }} disabled={disabled}>
                <option value="">Choose a category...</option>
                {question.categories.map((category) => <option value={category.id} key={category.id}>{category.label}</option>)}
              </select>
            </label>
          ))}
        </div>
      );
    }
    case "translation":
      return (
        <div className="open-response">
          <blockquote>{render(question.sourceText)}</blockquote>
          <AnswerBankResponse bank={question.answerBank} value={stringAnswer(answer)} onChange={onChange} inputMode={answerInputMode} label={`${question.targetLanguage} translation`} multiline disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} renderText={render} />
          <p className="rubric-copy">ChatGPT rubric: {question.rubric.join(" · ")}</p>
        </div>
      );
    case "shortAnswer":
      return (
        <div className="open-response">
          <AnswerBankResponse bank={question.answerBank} value={stringAnswer(answer)} onChange={onChange} inputMode={answerInputMode} label="Answer" multiline disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} renderText={render} />
          <p className="rubric-copy">Required ideas: {question.requiredIdeas.join(" · ")}</p>
        </div>
      );
    case "errorCorrection":
      return (
        <div className="open-response">
          <blockquote className="incorrect-source">{render(question.incorrectText)}</blockquote>
          <AnswerBankResponse bank={question.answerBank} value={stringAnswer(answer)} onChange={onChange} inputMode={answerInputMode} label="Corrected sentence" disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} renderText={render} />
        </div>
      );
    case "sentenceTransformation":
      return (
        <div className="open-response">
          <blockquote>{render(question.sourceText)}</blockquote>
          <p className="constraint-copy">Constraint: {render(question.constraint)}</p>
          <AnswerBankResponse bank={question.answerBank} value={stringAnswer(answer)} onChange={onChange} inputMode={answerInputMode} label="New sentence" disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} renderText={render} />
        </div>
      );
    case "dictation":
      return (
        <div className="open-response">
          <AudioPrompt text={question.transcript} onSpeak={onSpeakTarget} label="Play dictation audio" />
          <AnswerBankResponse bank={question.answerBank} value={stringAnswer(answer)} onChange={onChange} inputMode={answerInputMode} label="What you heard" disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} renderText={render} />
          <details className="transcript-fallback"><summary>Cannot hear it? Show the fallback transcript</summary><p>{render(question.transcript)}</p></details>
        </div>
      );
    case "freeWriting":
      return <FreeWritingResponse question={question} value={stringAnswer(answer)} onChange={onChange} inputMode={answerInputMode} onAnswerActivate={onAnswerActivate} disabled={disabled} evaluated={evaluated} renderText={render} />;
    case "speakingRepeat":
      return (
        <div className="speaking-response">
          <blockquote>{render(question.modelText)}</blockquote>
          <SpeakingRecorder language={languageTagForSpeech(language)} disabled={disabled} requireRecognition onUnavailable={onRequireAlternate} onChange={(submission) => onSpeakingChange?.(submission)} onTranscriptChange={onChange} />
          <ReadOnlyTranscript value={stringAnswer(answer)} />
        </div>
      );
    case "speakingRoleplay":
      return (
        <div className="speaking-response">
          <dl className="roleplay-brief">
            <div><dt>Role</dt><dd>{render(question.role)}</dd></div>
            <div><dt>Scenario</dt><dd>{render(question.scenario)}</dd></div>
            <div><dt>Goal</dt><dd>{render(question.goal)}</dd></div>
          </dl>
          <SpeakingRecorder language={languageTagForSpeech(language)} disabled={disabled} requireRecognition onUnavailable={onRequireAlternate} onChange={(submission) => onSpeakingChange?.(submission)} onTranscriptChange={onChange} />
          <ReadOnlyTranscript value={stringAnswer(answer)} />
        </div>
      );
    case "listenSelect":
    case "soundDiscrimination": {
      const selectedId = stringAnswer(answer);
      return (
        <div className="listening-choice-response">
          <AudioPrompt text={question.audioText} onSpeak={onSpeakTarget} />
          <fieldset className="choice-list" disabled={disabled}>
            <legend className="sr-only">Choose the text you heard</legend>
            {question.options.map((option) => (
              <label key={option.id} className={selectedId === option.id ? "is-selected" : ""}>
                <input
                  type="radio"
                  name={question.id}
                  checked={selectedId === option.id}
                  onClick={() => onAnswerActivate?.(option.label)}
                  onChange={() => onChange(option.id)}
                />
                <span>{render(option.label, answerInteractive)}</span>
              </label>
            ))}
          </fieldset>
        </div>
      );
    }
    case "audioMatching":
      return (
        <PairMatchingResponse
          id={question.id}
          pairs={question.pairs.map((pair) => ({ leftId: pair.audioId, leftText: pair.audioText, rightId: pair.matchId, rightText: pair.label }))}
          value={mapAnswer(answer)}
          onChange={onChange}
          disabled={disabled}
          evaluated={evaluated}
          renderText={render}
          onSpeakLeft={onSpeakTarget}
          onSpeakRight={onAnswerActivate}
          audioLeft
        />
      );
    case "flashcardRecall":
      return <FlashcardRecallResponse question={question} value={stringAnswer(answer)} language={language} disabled={disabled} onChange={onChange} onSpeakingChange={onSpeakingChange} />;
    case "characterTracing":
      return <CharacterTracingResponse question={question} language={language} answer={answer} disabled={disabled} onChange={onChange} onUnavailable={onRequireAlternate} />;
  }
}

function FlashcardRecallResponse({
  question,
  value,
  language,
  disabled,
  onChange,
  onSpeakingChange,
}: {
  question: Extract<LessonQuestion, { type: "flashcardRecall" }>;
  value: string;
  language: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSpeakingChange?: (submission: SpeakingSubmission | null) => void;
}) {
  const [keyboardFallback, setKeyboardFallback] = useState(() => !supportsSpeechRecognition());
  return (
    <div className="flashcard-recall">
      <blockquote>{question.cue}</blockquote>
      {!keyboardFallback ? (
        <>
          <p className="flashcard-mode-label"><Mic size={15} /> Answer in {language}</p>
          <SpeakingRecorder
            language={languageTagForSpeech(language)}
            disabled={disabled}
            requireRecognition
            onUnavailable={() => setKeyboardFallback(true)}
            onChange={(submission) => onSpeakingChange?.(submission)}
            onTranscriptChange={onChange}
          />
          <ReadOnlyTranscript value={value} />
          <button className="icon-text-button" type="button" onClick={() => setKeyboardFallback(true)} disabled={disabled}><Keyboard size={15} /> Use keyboard instead</button>
        </>
      ) : (
        <>
          <TextResponse label={`Answer in ${language}`} value={value} onChange={onChange} disabled={disabled} />
          {supportsSpeechRecognition() ? <button className="icon-text-button" type="button" onClick={() => setKeyboardFallback(false)} disabled={disabled}><Mic size={15} /> Use voice</button> : null}
        </>
      )}
    </div>
  );
}
