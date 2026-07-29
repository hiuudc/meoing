import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pipette, X } from "lucide-react";
import { isValidHex, normalizeHex } from "../theme";
import type { Collection, Document, StudyItem, StudyKind, Unit } from "../types";
import { HsvColorPicker } from "./HsvColorPicker";
import { cleanUnitName } from "../unit";
import { AnimatedModal } from "./AnimatedModal";
import {
  getSupportedLanguage,
  SUPPORTED_LANGUAGE_NAMES,
} from "../learning/languages";
import { normalizeLearningProfile } from "../learning/profile";

const DocumentEditor = lazy(() => import("./DocumentEditor").then((module) => ({
  default: module.DocumentEditor,
})));

export type EditorState =
  | { type: "collection"; value?: Collection }
  | { type: "unit"; value?: Unit; collectionId: string }
  | { type: "document"; value?: Document; unitId: string }
  | { type: "studyItem"; value?: StudyItem; unitId: string; kind: StudyKind };

interface EntityEditorModalProps {
  editor: EditorState | null;
  onClose: () => void;
  onSubmit: (value: Record<string, string>) => void;
  onAccentPreview: (accent: string | null) => void;
  targetLanguage: string;
}

const accentOptions = ["#8B7CF6", "#E7AD67", "#72BDA3", "#EB7198", "#69A9E8"];
const ACCENT_PICKER_WIDTH = 274;
const ACCENT_PICKER_HEIGHT = 258;
const ACCENT_PICKER_MARGIN = 8;

export function EntityEditorModal({
  editor,
  onClose,
  onSubmit,
  onAccentPreview,
  targetLanguage,
}: EntityEditorModalProps) {
  const [retainedEditor, setRetainedEditor] = useState(editor);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [accentInput, setAccentInput] = useState(accentOptions[0]);
  const [accentPickerOpen, setAccentPickerOpen] = useState(false);
  const [accentPickerPosition, setAccentPickerPosition] = useState({ top: 0, left: 0 });
  const [error, setError] = useState("");
  const accentPickerButtonRef = useRef<HTMLButtonElement>(null);
  const accentPickerRef = useRef<HTMLDivElement>(null);
  const documentValueRef = useRef({ content: "", plainText: "" });
  const activeEditor = editor ?? retainedEditor;

  useEffect(() => {
    if (editor) setRetainedEditor(editor);
  }, [editor]);

  useEffect(() => {
    if (!editor) setAccentPickerOpen(false);
  }, [editor]);

  useEffect(() => {
    if (!activeEditor) return;
    if (activeEditor.type === "collection") {
      const accent = normalizeHex(activeEditor.value?.accent ?? accentOptions[0], accentOptions[0]);
      const profile = normalizeLearningProfile(activeEditor.value?.learningProfile);
      setFields({
        name: activeEditor.value?.name ?? "",
        icon: activeEditor.value?.icon ?? "",
        accent,
        targetLanguage: profile.targetLanguage,
        sourceLanguage: profile.sourceLanguage,
      });
      setAccentInput(accent);
      onAccentPreview(accent);
    } else if (activeEditor.type === "unit") {
      onAccentPreview(null);
      setFields({
        name: cleanUnitName(activeEditor.value?.name ?? ""),
        description: activeEditor.value?.description ?? "",
        instructionOverride: activeEditor.value?.instructionOverride ?? "",
      });
    } else if (activeEditor.type === "document") {
      onAccentPreview(null);
      documentValueRef.current = {
        content: activeEditor.value?.content ?? "",
        plainText: activeEditor.value?.body ?? "",
      };
      setFields({
        title: activeEditor.value?.title ?? "",
        documentType: activeEditor.value?.type ?? "Notes",
        body: activeEditor.value?.body ?? "",
        content: activeEditor.value?.content ?? "",
      });
    } else {
      onAccentPreview(null);
      setFields({ text: activeEditor.value?.text ?? "", translation: activeEditor.value?.translation ?? "", notes: activeEditor.value?.notes ?? "" });
    }
    setAccentPickerOpen(false);
    setError("");
  }, [activeEditor, onAccentPreview]);

  const title = activeEditor ? getTitle(activeEditor) : "";
  const activeAccent = normalizeHex(fields.accent ?? accentOptions[0], accentOptions[0]);
  const hasPresetAccent = accentOptions.includes(activeAccent);

  function updateField(key: string, value: string) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  function updateAccent(value: string) {
    const accent = normalizeHex(value, activeAccent);
    updateField("accent", accent);
    setAccentInput(accent);
    onAccentPreview(accent);
  }

  function updateAccentInput(value: string) {
    const nextValue = value.toUpperCase();
    setAccentInput(nextValue);
    if (isValidHex(nextValue)) {
      const accent = normalizeHex(nextValue);
      updateField("accent", accent);
      onAccentPreview(accent);
    }
  }

  const positionAccentPicker = useCallback(() => {
    const anchor = accentPickerButtonRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const below = rect.bottom + ACCENT_PICKER_MARGIN;
    const top = below + ACCENT_PICKER_HEIGHT <= window.innerHeight
      ? below
      : rect.top - ACCENT_PICKER_HEIGHT - ACCENT_PICKER_MARGIN;
    setAccentPickerPosition({
      top: Math.max(ACCENT_PICKER_MARGIN, Math.min(top, window.innerHeight - ACCENT_PICKER_HEIGHT - ACCENT_PICKER_MARGIN)),
      left: Math.max(ACCENT_PICKER_MARGIN, Math.min(rect.left, window.innerWidth - ACCENT_PICKER_WIDTH - ACCENT_PICKER_MARGIN)),
    });
  }, []);

  useEffect(() => {
    if (!accentPickerOpen) return;
    positionAccentPicker();
    const animationFrame = window.requestAnimationFrame(() => {
      accentPickerRef.current?.querySelector<HTMLElement>(".interactive-color-picker")?.focus();
    });

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (!accentPickerRef.current?.contains(target) && !accentPickerButtonRef.current?.contains(target)) {
        setAccentPickerOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setAccentPickerOpen(false);
      accentPickerButtonRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", positionAccentPicker);
    window.addEventListener("scroll", positionAccentPicker, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", positionAccentPicker);
      window.removeEventListener("scroll", positionAccentPicker, true);
    };
  }, [accentPickerOpen, positionAccentPicker]);

  function handleAccentPickerKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusableElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[tabindex]:not([tabindex="-1"]), input:not([disabled])'),
    );
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      setAccentPickerOpen(false);
      accentPickerButtonRef.current?.focus();
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeEditor) return;
    const required =
      activeEditor.type === "collection"
        ? ["name", "icon", "targetLanguage", "sourceLanguage"]
        : activeEditor.type === "unit"
          ? ["name"]
          : activeEditor.type === "document"
            ? ["title", "documentType"]
            : ["text", "translation"];
    if (required.some((field) => !fields[field]?.trim())) {
      setError("Fill in the required fields before saving.");
      return;
    }
    setAccentPickerOpen(false);
    onSubmit(activeEditor.type === "document"
      ? {
        ...fields,
        body: documentValueRef.current.plainText,
        content: documentValueRef.current.content,
      }
      : fields);
  }

  if (!activeEditor) return null;

  return (
    <>
    <AnimatedModal
      open={Boolean(editor)}
      onClose={onClose}
      labelledBy="entity-modal-title"
      backdropClassName="modal-backdrop"
      panelClassName={`entity-modal${activeEditor.type === "document" ? " entity-modal-document" : ""}`}
    >
        <header className="modal-header">
          <div>
            <p>{activeEditor.value ? "Edit details" : "Create new"}</p>
            <h2 id="entity-modal-title">{title}</h2>
          </div>
          <button type="button" aria-label="Close editor" onClick={onClose}><X size={18} /></button>
        </header>
        <form onSubmit={submit}>
          {activeEditor.type === "collection" ? (
            <>
              <Field label="Collection name" value={fields.name} onChange={(value) => updateField("name", value)} autoFocus />
              <Field label="Collection icon" value={fields.icon} onChange={(value) => updateField("icon", value.slice(0, 2))} hint="Use one or two characters." />
              <SelectField
                label="Language learning"
                value={fields.targetLanguage}
                options={!fields.targetLanguage || getSupportedLanguage(fields.targetLanguage)
                  ? SUPPORTED_LANGUAGE_NAMES
                  : [fields.targetLanguage, ...SUPPORTED_LANGUAGE_NAMES]}
                onChange={(value) => updateField("targetLanguage", value)}
              />
              <SelectField
                label="Language speaking"
                value={fields.sourceLanguage}
                options={SUPPORTED_LANGUAGE_NAMES}
                onChange={(value) => updateField("sourceLanguage", value)}
              />
              <fieldset className="accent-fieldset">
                <legend>Accent color</legend>
                <div className="accent-options">
                  {accentOptions.map((accent) => (
                    <label className="accent-preset-option" key={accent}>
                      <input type="radio" name="accent" value={accent} checked={activeAccent === accent} onChange={() => {
                        updateAccent(accent);
                        setAccentPickerOpen(false);
                      }} aria-label={`${accent} accent`} />
                      <span className="accent-swatch" style={{ background: accent }} />
                    </label>
                  ))}
                  <button
                    className={`accent-custom-picker${hasPresetAccent ? "" : " is-selected"}`}
                    type="button"
                    ref={accentPickerButtonRef}
                    aria-label="Choose custom accent color"
                    aria-expanded={accentPickerOpen}
                    aria-haspopup="dialog"
                    title="Choose custom accent color"
                    onClick={() => setAccentPickerOpen((current) => !current)}
                  >
                    <span className="accent-swatch accent-custom-swatch" style={{ background: activeAccent }}><Pipette size={14} /></span>
                  </button>
                  <label className="accent-hex-field">
                    <span>Custom hex</span>
                    <input
                      type="text"
                      value={accentInput}
                      onChange={(event) => updateAccentInput(event.target.value)}
                      onBlur={() => setAccentInput(activeAccent)}
                      maxLength={7}
                      spellCheck={false}
                    />
                  </label>
                </div>
              </fieldset>
            </>
          ) : null}
          {activeEditor.type === "unit" ? (
            <>
              <Field label="Unit name" value={fields.name} onChange={(value) => updateField("name", value)} autoFocus />
              <TextArea label="Description" value={fields.description} onChange={(value) => updateField("description", value)} />
              <TextArea
                label="Unit-specific learning request"
                value={fields.instructionOverride}
                onChange={(value) => updateField("instructionOverride", value)}
              />
            </>
          ) : null}
          {activeEditor.type === "document" ? (
            <>
              <div className="document-meta-fields">
                <Field label="Document title" value={fields.title} onChange={(value) => updateField("title", value)} autoFocus />
                <Field label="Document type" value={fields.documentType} onChange={(value) => updateField("documentType", value)} />
              </div>
              <div className="form-field document-content-field">
                <span>Document content</span>
                <Suspense fallback={<div className="document-editor-loading" role="status">Loading editor...</div>}>
                  <DocumentEditor
                    key={activeEditor.value?.id ?? "new-document"}
                    content={fields.content}
                    language={targetLanguage}
                    plainText={fields.body}
                    onChange={(value) => {
                      documentValueRef.current = value;
                    }}
                  />
                </Suspense>
              </div>
            </>
          ) : null}
          {activeEditor.type === "studyItem" ? (
            <>
              <Field label={activeEditor.kind === "word" ? "Word" : activeEditor.kind === "phrase" ? "Phrase" : "Sentence"} value={fields.text} onChange={(value) => updateField("text", value)} autoFocus />
              <Field label="Translation" value={fields.translation} onChange={(value) => updateField("translation", value)} />
              <TextArea label="Notes" value={fields.notes} onChange={(value) => updateField("notes", value)} />
            </>
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
          <footer className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="submit">Save changes</button>
          </footer>
        </form>
    </AnimatedModal>
    {accentPickerOpen ? createPortal(
      <div
        className="accent-picker-popover"
        ref={accentPickerRef}
        role="dialog"
        aria-label="Custom accent color picker"
        style={{ top: accentPickerPosition.top, left: accentPickerPosition.left }}
        onKeyDown={handleAccentPickerKeyDown}
      >
        <HsvColorPicker value={activeAccent} onChange={updateAccent} />
        <label className="accent-popover-hex-field">
          <span>Hex color</span>
          <input
            type="text"
            value={accentInput}
            onChange={(event) => updateAccentInput(event.target.value)}
            onBlur={() => setAccentInput(activeAccent)}
            maxLength={7}
            spellCheck={false}
            aria-label="Custom accent hex color"
          />
        </label>
      </div>,
      document.querySelector(".app-shell") ?? document.body,
    ) : null}
    </>
  );
}

function getTitle(editor: EditorState): string {
  if (editor.type === "collection") return "Collection";
  if (editor.type === "unit") return "Unit";
  if (editor.type === "document") return "Document";
  return editor.kind[0].toUpperCase() + editor.kind.slice(1);
}

function Field({
  label,
  value = "",
  onChange,
  hint,
  autoFocus,
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-modal-autofocus={autoFocus ? "" : undefined}
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function TextArea({ label, value = "", onChange }: { label: string; value?: string; onChange: (value: string) => void }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={5} />
    </label>
  );
}

function SelectField({
  label,
  value = "",
  options,
  onChange,
}: {
  label: string;
  value?: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option value={option} key={option}>{option}</option>)}
      </select>
    </label>
  );
}
