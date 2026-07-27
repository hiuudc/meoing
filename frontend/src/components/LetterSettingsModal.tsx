import { X } from "lucide-react";
import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  MAX_LETTERS_PRACTICE_QUESTIONS,
  MAX_STROKE_TOLERANCE,
  MIN_LETTERS_PRACTICE_QUESTIONS,
  MIN_STROKE_TOLERANCE,
  STROKE_TOLERANCE_PRESETS,
  normalizeLettersPracticeQuestionCount,
  strokeToleranceForKey,
  strokeToleranceFromPosition,
  strokeToleranceLabel,
  strokeTolerancePosition,
  type LetterSettings,
} from "../learning/letters";
import { AnimatedModal } from "./AnimatedModal";

interface LetterSettingsModalProps {
  open: boolean;
  collectionName: string;
  language: string;
  value: LetterSettings;
  onClose: () => void;
  onExited?: () => void;
  onApply: (settings: LetterSettings) => void;
}

export function LetterSettingsModal({
  open,
  collectionName,
  language,
  value,
  onClose,
  onExited,
  onApply,
}: LetterSettingsModalProps) {
  const [draft, setDraft] = useState<LetterSettings>(() => ({ ...value }));

  useEffect(() => {
    if (!open) return;
    setDraft({ ...value });
  }, [
    language,
    open,
    value.practiceQuestionCount,
    value.requireStrokeOrder,
    value.showStrokeGuide,
    value.strokeTolerance,
  ]);

  function updateStrokeTolerance(value: number) {
    setDraft((current) => ({ ...current, strokeTolerance: value }));
  }

  function handleToleranceKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const next = strokeToleranceForKey(draft.strokeTolerance, event.key);
    if (next === null) return;
    event.preventDefault();
    updateStrokeTolerance(next);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onApply(draft);
  }

  return createPortal(
    <AnimatedModal
      open={open}
      onClose={onClose}
      onExited={onExited}
      labelledBy="letter-settings-title"
      backdropClassName="modal-backdrop letter-settings-backdrop"
      panelClassName="letter-settings-modal"
    >
      <form onSubmit={submit}>
        <header className="letter-settings-header">
          <div>
            <p>Letters</p>
            <h2 id="letter-settings-title">Letter settings</h2>
            <span>{collectionName} · {language}</span>
          </div>
          <button className="icon-button" type="button" aria-label="Close Letter settings" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="letter-settings-content">
          <section aria-labelledby="letter-settings-practice-title">
            <div className="letter-settings-section-heading">
              <div>
                <h3 id="letter-settings-practice-title">Practice</h3>
                <p>Practice length applies when the next Letters lesson starts.</p>
              </div>
            </div>
            <label className="letter-settings-row" htmlFor="letter-settings-practice-length">
              <span>
                <strong>Practice length</strong>
                <small>Questions in each practice session</small>
              </span>
              <input
                id="letter-settings-practice-length"
                type="number"
                min={MIN_LETTERS_PRACTICE_QUESTIONS}
                max={MAX_LETTERS_PRACTICE_QUESTIONS}
                step={1}
                value={draft.practiceQuestionCount}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  practiceQuestionCount: normalizeLettersPracticeQuestionCount(
                    event.currentTarget.valueAsNumber,
                  ),
                }))}
              />
            </label>
          </section>

          <section aria-labelledby="letter-settings-strokes-title">
            <div className="letter-settings-section-heading">
              <div>
                <h3 id="letter-settings-strokes-title">Stroke guidance</h3>
                <p>These changes apply immediately to the current character after Apply.</p>
              </div>
            </div>
            <label className="letter-settings-check-row">
              <span>
                <strong>Require stroke order</strong>
                <small>Check each stroke against the bundled character data</small>
              </span>
              <input
                autoFocus
                type="checkbox"
                checked={draft.requireStrokeOrder}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  requireStrokeOrder: event.target.checked,
                }))}
              />
            </label>

            <fieldset
              className={`letter-settings-dependent ${draft.requireStrokeOrder ? "" : "is-disabled"}`}
              disabled={!draft.requireStrokeOrder}
              aria-describedby={!draft.requireStrokeOrder ? "letter-settings-dependent-status" : undefined}
            >
              <div className="letter-settings-tolerance">
                <div>
                  <label htmlFor="letter-settings-stroke-tolerance">Stroke tolerance</label>
                  <output htmlFor="letter-settings-stroke-tolerance">
                    {strokeToleranceLabel(draft.strokeTolerance)}
                  </output>
                </div>
                <input
                  id="letter-settings-stroke-tolerance"
                  type="range"
                  min={0}
                  max={100}
                  step="any"
                  value={strokeTolerancePosition(draft.strokeTolerance)}
                  aria-valuemin={MIN_STROKE_TOLERANCE}
                  aria-valuemax={MAX_STROKE_TOLERANCE}
                  aria-valuenow={draft.strokeTolerance}
                  aria-valuetext={strokeToleranceLabel(draft.strokeTolerance)}
                  onChange={(event) => updateStrokeTolerance(
                    strokeToleranceFromPosition(event.currentTarget.valueAsNumber),
                  )}
                  onKeyDown={handleToleranceKeyDown}
                />
                <div className="letters-tolerance-presets" aria-label="Stroke tolerance presets">
                  {STROKE_TOLERANCE_PRESETS.map(({ label, value: presetValue }) => (
                    <button
                      type="button"
                      key={label}
                      style={{ left: `${strokeTolerancePosition(presetValue)}%` }}
                      aria-pressed={draft.strokeTolerance === presetValue}
                      onClick={() => updateStrokeTolerance(presetValue)}
                    >
                      <span>{label}</span>
                      <small>{presetValue.toFixed(1)}x</small>
                    </button>
                  ))}
                </div>
              </div>

              <label className="letter-settings-check-row">
                <span>
                  <strong>Show drag direction</strong>
                  <small>Display the path and moving arrow while tracing</small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.showStrokeGuide}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    showStrokeGuide: event.target.checked,
                  }))}
                />
              </label>
            </fieldset>
            {!draft.requireStrokeOrder ? (
              <p id="letter-settings-dependent-status" className="letter-settings-disabled-note">
                Stroke tolerance and drag direction are unavailable while stroke order is off.
              </p>
            ) : null}
          </section>
        </div>

        <footer className="letter-settings-footer">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit">Apply settings</button>
        </footer>
      </form>
    </AnimatedModal>,
    document.querySelector<HTMLElement>(".app-shell") ?? document.body,
  );
}
