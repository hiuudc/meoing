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
import { parseMultiClozeTemplate, stripBlankMarkers } from "./multiCloze";
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
  onComplete?: (answer: QuestionAnswer) => void;
  renderText?: (text: string, interactive?: boolean) => ReactNode;
  answerInputMode?: AnswerInputMode;
}

type TextRenderer = (text: string, interactive?: boolean) => ReactNode;
export type AnswerInputMode = "keyboard" | "bank";

function TargetStimulusRow({
  children,
  speechText,
  onSpeak,
}: {
  children: ReactNode;
  speechText: string;
  onSpeak?: (text: string) => void;
}) {
  return (
    <div className="question-target-stimulus-row">
      <button
        type="button"
        aria-label="Play target-language prompt"
        onClick={() => onSpeak?.(stripBlankMarkers(speechText))}
        disabled={!onSpeak}
      >
        <Volume2 size={20} />
      </button>
      <div>{children}</div>
    </div>
  );
}

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
        <textarea data-question-answer-input rows={5} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} />
      ) : (
        <input data-question-answer-input value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} autoComplete="off" />
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

type DragDropTarget = "tray" | "bank" | null;

const DRAG_DROP_MARGIN = 32;
const TYPEAHEAD_RESET_MS = 1_500;

function pointInRect(rect: DOMRect | undefined, x: number, y: number, margin = 0): boolean {
  return Boolean(rect
    && x >= rect.left - margin
    && x <= rect.right + margin
    && y >= rect.top - margin
    && y <= rect.bottom + margin);
}

function normalizeTypeahead(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase();
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
  const composerRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const bankRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef("");
  const typeaheadTimerRef = useRef<number | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [dragDropTarget, setDragDropTarget] = useState<DragDropTarget>(null);
  const [typeahead, setTypeahead] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const availableOptions = options.filter((option) => !value.includes(option.id));
  const matchingOptionIds = new Set(typeahead
    ? availableOptions
      .filter((option) => normalizeTypeahead(option.label).startsWith(typeahead))
      .map((option) => option.id)
    : []);

  function announce(message: string) {
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement(message));
  }

  function focusComposer() {
    window.requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  }

  function clearTypeahead() {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = null;
    setTypeahead("");
  }

  function scheduleTypeaheadReset() {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = window.setTimeout(() => {
      typeaheadTimerRef.current = null;
      setTypeahead("");
    }, TYPEAHEAD_RESET_MS);
  }

  function addToken(id: string, label: string, targetIndex = value.length) {
    if (value.includes(id) || (maxSelections !== undefined && value.length >= maxSelections)) return;
    const next = [...value];
    const safeIndex = Math.max(0, Math.min(targetIndex, next.length));
    next.splice(safeIndex, 0, id);
    onAnswerActivate?.(label);
    onChange(next);
    announce(`${label} added at position ${safeIndex + 1}.`);
    focusComposer();
  }

  function removeToken(id: string) {
    const label = labels.get(id) ?? id;
    onChange(value.filter((valueId) => valueId !== id));
    announce(`${label} returned to the word bank.`);
    focusComposer();
  }

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function moveBy(id: string, direction: -1 | 1) {
    const index = value.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    announce(`${labels.get(id) ?? id} moved to position ${target + 1}.`);
  }

  function dropTargetFor(origin: PointerDrag["origin"], clientX: number, clientY: number): DragDropTarget {
    const trayRect = trayRef.current?.getBoundingClientRect();
    const bankRect = bankRef.current?.getBoundingClientRect();
    const overTray = pointInRect(trayRect, clientX, clientY);
    const overBank = pointInRect(bankRect, clientX, clientY);
    if (origin === "bank") {
      if (overTray || (!overBank && pointInRect(trayRect, clientX, clientY, DRAG_DROP_MARGIN))) return "tray";
      return null;
    }
    if (overBank || (!overTray && pointInRect(bankRect, clientX, clientY, DRAG_DROP_MARGIN))) return "bank";
    if (overTray || pointInRect(trayRect, clientX, clientY, DRAG_DROP_MARGIN)) return "tray";
    return null;
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
    const nextTarget = dropTargetFor(drag.origin, event.clientX, event.clientY);
    setDragDropTarget((current) => current === nextTarget ? current : nextTarget);
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragPreview(null);
    setDragDropTarget(null);
    if (!drag?.moved) return;
    const dropTarget = dropTargetFor(drag.origin, event.clientX, event.clientY);

    if (drag.origin === "bank" && dropTarget === "tray") {
      if (maxSelections === undefined || value.length < maxSelections) {
        const targetIndex = insertionIndex(event.clientX, event.clientY);
        addToken(drag.id, drag.label, targetIndex);
      }
    } else if (drag.origin === "tray" && dropTarget === "bank") {
      removeToken(drag.id);
    } else if (drag.origin === "tray" && dropTarget === "tray") {
      const targetIndex = insertionIndex(event.clientX, event.clientY, drag.id);
      const next = moveItem(value, drag.id, targetIndex);
      onChange(next);
      announce(`${drag.label} moved to position ${next.indexOf(drag.id) + 1}.`);
      focusComposer();
    }
    suppressClickRef.current = drag.id;
  }

  function cancelPointerDrag() {
    dragRef.current = null;
    setDragPreview(null);
    setDragDropTarget(null);
  }

  function handleSelectedKey(event: ReactKeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeToken(id);
      return;
    }
    if (!event.altKey || !["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    moveBy(id, event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
  }

  function handleComposerKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.key === "Escape" && typeahead) {
      event.preventDefault();
      clearTypeahead();
      announce("Word bank filter cleared.");
      return;
    }
    if (event.key === "Backspace") {
      if (target?.closest("[data-answer-token-id]")) return;
      event.preventDefault();
      if (typeahead) {
        const next = typeahead.slice(0, -1);
        setTypeahead(next);
        if (next) scheduleTypeaheadReset();
        else clearTypeahead();
        announce(next ? `Word bank prefix ${next}.` : "Word bank filter cleared.");
      } else if (value.length) {
        removeToken(value[value.length - 1]);
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1 || !/[\p{L}\p{N}]/u.test(event.key)) return;
    event.preventDefault();
    if (maxSelections !== undefined && value.length >= maxSelections) {
      announce("The answer tray is full.");
      return;
    }
    const next = `${typeahead}${normalizeTypeahead(event.key)}`;
    const matches = availableOptions.filter((option) => normalizeTypeahead(option.label).startsWith(next));
    setTypeahead(next);
    if (matches.length === 1) {
      clearTypeahead();
      addToken(matches[0].id, matches[0].label);
      return;
    }
    scheduleTypeaheadReset();
    announce(matches.length
      ? `${matches.length} words match ${next}: ${matches.map((option) => option.label).join(", ")}.`
      : `No available word matches ${next}.`);
  }

  const portalTarget = document.querySelector<HTMLElement>(".app-shell") ?? document.body;
  return (
    <div
      className="answer-composer"
      ref={composerRef}
      tabIndex={0}
      onKeyDownCapture={handleComposerKey}
      data-typeahead-active={typeahead ? "true" : undefined}
      aria-label="Word bank composer. Type a word prefix to select it."
    >
      <p className="sr-only">Selected order</p>
      <div className={`${value.length ? "answer-tray" : "answer-tray is-empty"}${dragDropTarget === "tray" ? " is-drop-target" : ""}`} ref={trayRef} aria-label="Selected answer">
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
            onLostPointerCapture={cancelPointerDrag}
            onKeyDown={(event) => handleSelectedKey(event, id)}
            onClick={() => {
              if (suppressClickRef.current === id) {
                suppressClickRef.current = "";
                return;
              }
              removeToken(id);
            }}
            disabled={disabled}
          >
            {renderText(labels.get(id) ?? id, Boolean(evaluated))}
          </button>
        ))}
      </div>
      <div className={`token-bank${dragDropTarget === "bank" ? " is-drop-target" : ""}`} ref={bankRef} aria-label="Available words">
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
            onLostPointerCapture={cancelPointerDrag}
            onClick={() => {
              if (suppressClickRef.current === option.id) {
                suppressClickRef.current = "";
                return;
              }
              addToken(option.id, option.label);
            }}
            className={typeahead
              ? matchingOptionIds.has(option.id) ? "is-typeahead-match" : "is-typeahead-dimmed"
              : undefined}
            disabled={disabled || (maxSelections !== undefined && value.length >= maxSelections)}
          >
            {renderText(option.label, Boolean(evaluated))}
          </button>
        ))}
      </div>
      {value.length ? (
        <button className="question-reset-button" type="button" onClick={() => {
          clearTypeahead();
          onChange([]);
          announce("Answer reset.");
          focusComposer();
        }} disabled={disabled}>
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
  onSpeakTarget,
  renderText,
}: {
  question: Extract<LessonQuestion, { type: "multiCloze" }>;
  answer: QuestionAnswer;
  onChange: (answer: QuestionAnswer) => void;
  inputMode?: AnswerInputMode;
  disabled?: boolean;
  evaluated?: boolean;
  onAnswerActivate?: (text: string) => void;
  onSpeakTarget?: (text: string) => void;
  renderText: TextRenderer;
}) {
  const values = mapAnswer(answer);
  const bank = question.answerBank;
  const mode = inputMode ?? bank?.defaultMode ?? "keyboard";
  const [keyboardValues, setKeyboardValues] = useState(values);
  const [assignments, setAssignments] = useState<Record<string, string>>(() => {
    if (!bank) return {};
    const used = new Set<string>();
    return Object.fromEntries(question.blanks.flatMap((blank) => {
      const token = bank.tokens.find((candidate) => !used.has(candidate.id) && candidate.label === values[blank.id]);
      if (!token) return [];
      used.add(token.id);
      return [[blank.id, token.id]];
    }));
  });
  const [activeBlankId, setActiveBlankId] = useState(question.blanks[0]?.id ?? "");
  const [drag, setDrag] = useState<{
    tokenId: string;
    label: string;
    originBlankId?: string;
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    moved: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const blankRefs = useRef(new Map<string, HTMLElement>());
  const bankRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef("");
  const typeaheadTimerRef = useRef<number | null>(null);
  const previousModeRef = useRef(mode);
  const [typeahead, setTypeahead] = useState("");
  const labels = useMemo(() => new Map(bank?.tokens.map((token) => [token.id, token.label]) ?? []), [bank]);
  const parsedTemplate = useMemo(
    () => parseMultiClozeTemplate(question.template, question.blanks.map((blank) => blank.id)),
    [question.blanks, question.template],
  );

  useEffect(() => {
    if (!bank || previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    if (mode === "keyboard") {
      onChange(keyboardValues);
      return;
    }
    onChange(Object.fromEntries(question.blanks.map((blank) => [blank.id, labels.get(assignments[blank.id]) ?? ""])));
  }, [assignments, bank, keyboardValues, labels, mode, onChange, question.blanks]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
  }, []);

  function announce(message: string) {
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement(message));
  }

  function clearTypeahead() {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = null;
    setTypeahead("");
  }

  function scheduleTypeaheadReset() {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = window.setTimeout(() => {
      typeaheadTimerRef.current = null;
      setTypeahead("");
    }, TYPEAHEAD_RESET_MS);
  }

  function nextEmptyBlank(currentId: string, nextAssignments: Record<string, string>): string {
    const currentIndex = question.blanks.findIndex((blank) => blank.id === currentId);
    const ordered = [
      ...question.blanks.slice(currentIndex + 1),
      ...question.blanks.slice(0, Math.max(0, currentIndex + 1)),
    ];
    return ordered.find((blank) => !nextAssignments[blank.id])?.id ?? currentId;
  }

  function publishAssignments(nextAssignments: Record<string, string>) {
    setAssignments(nextAssignments);
    onChange(Object.fromEntries(question.blanks.map((blank) => [
      blank.id,
      labels.get(nextAssignments[blank.id]) ?? "",
    ])));
  }

  function assignToken(tokenId: string, blankId: string, speakToken: boolean) {
    if (!bank || !blankId) return;
    const sourceBlankId = Object.entries(assignments).find(([, assignedId]) => assignedId === tokenId)?.[0];
    const replacedTokenId = assignments[blankId];
    const next = { ...assignments };
    if (sourceBlankId) delete next[sourceBlankId];
    if (sourceBlankId && replacedTokenId && sourceBlankId !== blankId) next[sourceBlankId] = replacedTokenId;
    next[blankId] = tokenId;
    publishAssignments(next);
    setActiveBlankId(nextEmptyBlank(blankId, next));
    const label = labels.get(tokenId) ?? tokenId;
    if (speakToken && !sourceBlankId) onAnswerActivate?.(label);
    announce(`${label} placed in ${blankId}.`);
  }

  function removeToken(blankId: string) {
    const tokenId = assignments[blankId];
    if (!tokenId) return;
    const next = { ...assignments };
    delete next[blankId];
    publishAssignments(next);
    setActiveBlankId(blankId);
    announce(`${labels.get(tokenId) ?? tokenId} returned to the word bank.`);
  }

  function startDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    tokenId: string,
    label: string,
    originBlankId?: string,
  ) {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      tokenId,
      label,
      originBlankId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      moved: false,
      x: rect.left,
      y: rect.top,
    });
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    setDrag((current) => {
      if (!current || current.pointerId !== event.pointerId) return current;
      const moved = current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 7;
      return {
        ...current,
        moved,
        x: event.clientX - current.offsetX,
        y: event.clientY - current.offsetY,
      };
    });
  }

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const completedDrag = drag;
    setDrag(null);
    if (!completedDrag.moved) return;
    const targetBlank = question.blanks.find((blank) => (
      pointInRect(blankRefs.current.get(blank.id)?.getBoundingClientRect(), event.clientX, event.clientY, DRAG_DROP_MARGIN)
    ));
    const overBank = pointInRect(bankRef.current?.getBoundingClientRect(), event.clientX, event.clientY, DRAG_DROP_MARGIN);
    if (targetBlank) {
      assignToken(completedDrag.tokenId, targetBlank.id, !completedDrag.originBlankId);
    } else if (completedDrag.originBlankId && overBank) {
      removeToken(completedDrag.originBlankId);
    }
    suppressClickRef.current = completedDrag.tokenId;
  }

  function cancelDrag() {
    setDrag(null);
  }

  function handleTypeahead(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (mode !== "bank" || !bank || disabled || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.key === "Escape" && typeahead) {
      event.preventDefault();
      clearTypeahead();
      announce("Word bank filter cleared.");
      return;
    }
    if (event.key === "Backspace") {
      if (target?.closest("[data-multi-cloze-token]")) return;
      event.preventDefault();
      if (typeahead) {
        const next = typeahead.slice(0, -1);
        setTypeahead(next);
        if (next) scheduleTypeaheadReset();
        else clearTypeahead();
        announce(next ? `Word bank prefix ${next}.` : "Word bank filter cleared.");
        return;
      }
      const lastFilled = [...question.blanks].reverse().find((blank) => assignments[blank.id]);
      if (lastFilled) removeToken(lastFilled.id);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1 || !/[\p{L}\p{N}]/u.test(event.key)) return;
    event.preventDefault();
    const next = `${typeahead}${normalizeTypeahead(event.key)}`;
    const used = new Set(Object.values(assignments));
    const matches = bank.tokens.filter((token) => (
      !used.has(token.id) && normalizeTypeahead(token.label).startsWith(next)
    ));
    setTypeahead(next);
    if (matches.length === 1) {
      clearTypeahead();
      const targetBlank = assignments[activeBlankId]
        ? question.blanks.find((blank) => !assignments[blank.id])?.id ?? activeBlankId
        : activeBlankId;
      assignToken(matches[0].id, targetBlank, true);
      return;
    }
    scheduleTypeaheadReset();
    announce(matches.length
      ? `${matches.length} words match ${next}: ${matches.map((token) => token.label).join(", ")}.`
      : `No available word matches ${next}.`);
  }

  function renderBlank(blankId: string, index: number) {
    if (mode === "keyboard" || !bank) {
      return (
        <label
          className={`multi-cloze-inline-blank${activeBlankId === blankId ? " is-active" : ""}`}
          key={`${blankId}-${index}`}
          ref={(element) => {
            if (element) blankRefs.current.set(blankId, element);
            else blankRefs.current.delete(blankId);
          }}
        >
          <span className="sr-only">Blank {index + 1}</span>
          <input
            data-question-answer-input
            data-multi-cloze-input={blankId}
            value={keyboardValues[blankId] ?? ""}
            onFocus={() => setActiveBlankId(blankId)}
            onChange={(event) => {
              const next = { ...keyboardValues, [blankId]: event.target.value };
              setKeyboardValues(next);
              onChange(next);
            }}
            disabled={disabled}
            autoComplete="off"
          />
        </label>
      );
    }
    const tokenId = assignments[blankId];
    const label = tokenId ? labels.get(tokenId) ?? tokenId : "";
    return (
      <span
        className={`multi-cloze-inline-blank is-bank${activeBlankId === blankId ? " is-active" : ""}${tokenId ? " is-filled" : ""}`}
        key={`${blankId}-${index}`}
        ref={(element) => {
          if (element) blankRefs.current.set(blankId, element);
          else blankRefs.current.delete(blankId);
        }}
      >
        {tokenId ? (
          <button
            type="button"
            data-multi-cloze-token={tokenId}
            onPointerDown={(event) => startDrag(event, tokenId, label, blankId)}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={cancelDrag}
            onClick={() => {
              if (suppressClickRef.current === tokenId) {
                suppressClickRef.current = "";
                return;
              }
              removeToken(blankId);
            }}
            disabled={disabled}
          >
            {renderText(label, Boolean(evaluated))}
          </button>
        ) : (
          <button type="button" aria-label={`Select blank ${index + 1}`} onClick={() => setActiveBlankId(blankId)} disabled={disabled} />
        )}
      </span>
    );
  }

  const markerIndexById = new Map(question.blanks.map((blank, index) => [blank.id, index]));
  const markerIds = parsedTemplate?.markerIds ?? question.blanks.map((blank) => blank.id);
  const segments = parsedTemplate?.segments ?? [question.template, ...question.blanks.map(() => "")];
  const usedTokenIds = new Set(Object.values(assignments));
  const portalTarget = document.querySelector<HTMLElement>(".app-shell") ?? document.body;

  return (
    <div
      className="multi-cloze-response"
      onKeyDownCapture={handleTypeahead}
      data-typeahead-active={typeahead ? "true" : undefined}
    >
      {question.targetPrompt || onSpeakTarget ? (
        <TargetStimulusRow speechText={question.targetPrompt ?? question.template} onSpeak={onSpeakTarget}>
          <p className="multi-cloze-template" data-question-primary-focus tabIndex={-1}>
            {segments.map((segment, index) => (
              <span className="multi-cloze-template-part" key={`${index}-${markerIds[index] ?? "tail"}`}>
                {renderText(segment)}
                {markerIds[index]
                  ? renderBlank(markerIds[index], markerIndexById.get(markerIds[index]) ?? index)
                  : null}
              </span>
            ))}
          </p>
        </TargetStimulusRow>
      ) : (
        <p className="multi-cloze-template" data-question-primary-focus tabIndex={-1}>
          {segments.map((segment, index) => (
            <span className="multi-cloze-template-part" key={`${index}-${markerIds[index] ?? "tail"}`}>
              {renderText(segment)}
              {markerIds[index]
                ? renderBlank(markerIds[index], markerIndexById.get(markerIds[index]) ?? index)
                : null}
            </span>
          ))}
        </p>
      )}
      {mode === "bank" && bank ? (
        <div className="multi-cloze-bank" ref={bankRef} aria-label="Available words">
          {bank.tokens.map((token) => usedTokenIds.has(token.id) ? (
            <span className="token-bank-placeholder" key={token.id} aria-hidden="true">
              {renderText(token.label, false)}
            </span>
          ) : (
            <button
              type="button"
              key={token.id}
              onPointerDown={(event) => startDrag(event, token.id, token.label)}
              onPointerMove={moveDrag}
              onPointerUp={finishDrag}
              onPointerCancel={cancelDrag}
              onClick={() => {
                if (suppressClickRef.current === token.id) {
                  suppressClickRef.current = "";
                  return;
                }
                const target = assignments[activeBlankId]
                  ? question.blanks.find((blank) => !assignments[blank.id])?.id ?? activeBlankId
                  : activeBlankId;
                assignToken(token.id, target, true);
              }}
              className={typeahead
                ? normalizeTypeahead(token.label).startsWith(typeahead) ? "is-typeahead-match" : "is-typeahead-dimmed"
                : undefined}
              disabled={disabled}
            >
              {renderText(token.label, Boolean(evaluated))}
            </button>
          ))}
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">{announcement}</p>
      {drag?.moved ? createPortal(
        <div
          className="answer-token-drag-preview"
          aria-hidden="true"
          style={{
            width: drag.width,
            height: drag.height,
            transform: `translate3d(${drag.x}px, ${drag.y}px, 0)`,
          }}
        >
          {renderText(drag.label, false)}
        </div>,
        portalTarget,
      ) : null}
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
  onComplete,
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
  onComplete?: (value: Record<string, string>) => void;
}) {
  const [selectedLeft, setSelectedLeft] = useState("");
  const [selectedRight, setSelectedRight] = useState("");
  const [wrong, setWrong] = useState<string[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const numberTimerRef = useRef<number | null>(null);
  const numberBufferRef = useRef("");
  const rightItems = useMemo(() => stableShuffle(pairs, id), [id, pairs]);
  const lockedRightIds = new Set(Object.values(value));

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    if (numberTimerRef.current !== null) window.clearTimeout(numberTimerRef.current);
  }, []);

  function tryPair(leftId: string, rightId: string) {
    const pair = pairs.find((candidate) => candidate.leftId === leftId);
    if (pair?.rightId === rightId) {
      const next = { ...value, [leftId]: rightId };
      onChange(next);
      setSelectedLeft("");
      setSelectedRight("");
      if (pairs.every((candidate) => next[candidate.leftId] === candidate.rightId)) {
        window.queueMicrotask(() => onComplete?.(next));
      }
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

  function activateNumber(index: number) {
    if (index < 1 || index > pairs.length + rightItems.length) return;
    if (index <= pairs.length) chooseLeft(pairs[index - 1]);
    else chooseRight(rightItems[index - pairs.length - 1]);
  }

  function handleNumberKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const digit = event.code.startsWith("Numpad") ? event.code.slice(6) : event.key;
    if (!/^\d$/.test(digit)) return;
    event.preventDefault();
    if (numberTimerRef.current !== null) window.clearTimeout(numberTimerRef.current);
    const nextBuffer = `${numberBufferRef.current}${digit}`.replace(/^0+/, "");
    numberBufferRef.current = nextBuffer;
    const maxIndex = pairs.length + rightItems.length;
    const numeric = Number(nextBuffer);
    const hasLongerCandidate = nextBuffer.length === 1
      && Array.from({ length: maxIndex }, (_, index) => String(index + 1)).some((label) => (
        label.length > nextBuffer.length && label.startsWith(nextBuffer)
      ));
    if (numeric >= 1 && numeric <= maxIndex && !hasLongerCandidate) {
      numberBufferRef.current = "";
      activateNumber(numeric);
      return;
    }
    numberTimerRef.current = window.setTimeout(() => {
      const pending = Number(numberBufferRef.current);
      numberBufferRef.current = "";
      numberTimerRef.current = null;
      if (pending >= 1 && pending <= maxIndex) activateNumber(pending);
    }, 420);
  }

  return (
    <div
      className="pair-matching"
      role="group"
      aria-label="Select matching pairs"
      tabIndex={0}
      data-question-primary-focus
      onKeyDownCapture={handleNumberKey}
    >
      <div className="pair-grid">
        {pairs.map((pair, index) => {
          const locked = Boolean(value[pair.leftId]);
          const rightPair = rightItems[index];
          const rightLocked = lockedRightIds.has(rightPair.rightId);
          return (
            <div className="pair-grid-row" key={`${pair.leftId}-${rightPair.rightId}`}>
              <button
                type="button"
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
              <button
                type="button"
                className={`${selectedRight === rightPair.rightId ? "is-selected " : ""}${wrong.includes(rightPair.rightId) ? "is-wrong " : ""}${rightLocked ? "is-locked" : ""}`}
                aria-pressed={selectedRight === rightPair.rightId}
                onClick={() => chooseRight(rightPair)}
                disabled={disabled || rightLocked}
              >
                <span className="pair-index">{pairs.length + index + 1}</span>
                {renderText(rightPair.rightText, Boolean(evaluated))}
              </button>
            </div>
          );
        })}
      </div>
      <p className="sr-only" aria-live="polite">{wrong.length ? "Those items do not match. Try again." : ""}</p>
    </div>
  );
}

function CategorizeResponse({
  question,
  value,
  onChange,
  disabled,
  evaluated,
  renderText,
  onAnswerActivate,
  onComplete,
}: {
  question: Extract<LessonQuestion, { type: "categorize" }>;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  disabled?: boolean;
  evaluated?: boolean;
  renderText: TextRenderer;
  onAnswerActivate?: (text: string) => void;
  onComplete?: (value: Record<string, string>) => void;
}) {
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [wrong, setWrong] = useState<string[]>([]);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  function tryCategory(itemId: string, categoryId: string) {
    const item = question.items.find((candidate) => candidate.id === itemId);
    if (item?.categoryId === categoryId) {
      const next = { ...value, [itemId]: categoryId };
      onChange(next);
      setSelectedItemId("");
      setSelectedCategoryId("");
      if (question.items.every((candidate) => next[candidate.id] === candidate.categoryId)) {
        window.queueMicrotask(() => onComplete?.(next));
      }
      return;
    }
    setWrong([itemId, categoryId]);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setWrong([]);
      setSelectedItemId("");
      setSelectedCategoryId("");
    }, 420);
  }

  function chooseItem(item: Extract<LessonQuestion, { type: "categorize" }>["items"][number]) {
    if (value[item.id]) return;
    onAnswerActivate?.(item.label);
    if (selectedCategoryId) tryCategory(item.id, selectedCategoryId);
    else setSelectedItemId(item.id);
  }

  function chooseCategory(category: Extract<LessonQuestion, { type: "categorize" }>["categories"][number]) {
    onAnswerActivate?.(category.label);
    if (selectedItemId) tryCategory(selectedItemId, category.id);
    else setSelectedCategoryId(category.id);
  }

  return (
    <div className="categorize-matching" role="group" aria-label="Select an item, then its category" tabIndex={0} data-question-primary-focus>
      <div className="categorize-items">
        {question.items.map((item, index) => {
          const locked = Boolean(value[item.id]);
          return (
            <button
              type="button"
              key={item.id}
              className={`${selectedItemId === item.id ? "is-selected " : ""}${wrong.includes(item.id) ? "is-wrong " : ""}${locked ? "is-locked" : ""}`}
              aria-pressed={selectedItemId === item.id}
              onClick={() => chooseItem(item)}
              disabled={disabled || locked}
            >
              <span className="pair-index">{index + 1}</span>
              {renderText(item.label, Boolean(evaluated))}
            </button>
          );
        })}
      </div>
      <div className="categorize-categories" aria-label="Categories">
        {question.categories.map((category) => (
          <button
            type="button"
            key={category.id}
            className={`${selectedCategoryId === category.id ? "is-selected " : ""}${wrong.includes(category.id) ? "is-wrong" : ""}`}
            aria-pressed={selectedCategoryId === category.id}
            onClick={() => chooseCategory(category)}
            disabled={disabled}
          >
            {category.label}
          </button>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">{wrong.length ? "That item does not belong in this category. Try again." : ""}</p>
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
  onComplete,
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
          <legend className={question.targetPrompt ? "sr-only" : undefined}>
            {question.targetPrompt ? "Choose true or false" : render(question.statement)}
          </legend>
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
          {question.targetPrompt || onSpeakTarget ? (
            <TargetStimulusRow speechText={question.targetPrompt ?? question.template} onSpeak={onSpeakTarget}>
              <p>{render(question.template)}</p>
            </TargetStimulusRow>
          ) : <p>{render(question.template)}</p>}
          <AnswerBankResponse bank={question.answerBank} value={stringAnswer(answer)} onChange={onChange} inputMode={answerInputMode} label="Missing word or phrase" disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} renderText={render} />
        </div>
      );
    case "selectBlank": {
      const selectedId = stringAnswer(answer);
      const selectedOption = question.options.find((option) => option.id === selectedId);
      const [before, after] = question.template.split("{{blank}}");
      return (
        <div className="select-blank-response">
          {question.targetPrompt || onSpeakTarget ? (
            <TargetStimulusRow speechText={question.targetPrompt ?? question.template} onSpeak={onSpeakTarget}>
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
            </TargetStimulusRow>
          ) : (
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
          )}
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
      return <MultiClozeResponse question={question} answer={answer} onChange={onChange} inputMode={answerInputMode} disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} onSpeakTarget={onSpeakTarget} renderText={render} />;
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
          onComplete={onComplete}
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
      return <CategorizeResponse question={question} value={mapAnswer(answer)} onChange={onChange} disabled={disabled} evaluated={evaluated} renderText={render} onAnswerActivate={onAnswerActivate} onComplete={onComplete} />;
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
          {question.targetPrompt ? null : <blockquote className="incorrect-source">{render(question.incorrectText)}</blockquote>}
          <AnswerBankResponse bank={question.answerBank} value={stringAnswer(answer)} onChange={onChange} inputMode={answerInputMode} label="Corrected sentence" disabled={disabled} evaluated={evaluated} onAnswerActivate={onAnswerActivate} renderText={render} />
        </div>
      );
    case "sentenceTransformation":
      return (
        <div className="open-response">
          {question.targetPrompt ? null : <blockquote>{render(question.sourceText)}</blockquote>}
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
          {question.targetPrompt ? null : <blockquote>{render(question.modelText)}</blockquote>}
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
          onComplete={onComplete}
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
