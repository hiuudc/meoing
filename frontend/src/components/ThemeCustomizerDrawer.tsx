import { Dice5, Minus, Moon, Plus, RotateCcw, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  addThemeStop,
  cloneTheme,
  isValidHex,
  markThemeCustom,
  removeThemeStop,
  surpriseTheme,
  updateThemeStop,
} from "../theme";
import type { ThemeConfig } from "../types";
import { HsvColorPicker } from "./HsvColorPicker";
import { useExitPresence } from "./useExitPresence";

interface ThemeCustomizerDrawerProps {
  savedTheme: ThemeConfig;
  open: boolean;
  draft: ThemeConfig | null;
  onChange: (theme: ThemeConfig) => void;
  onApply: () => void;
  onBack: () => void;
  onClose: () => void;
  onExited: () => void;
}

export function ThemeCustomizerDrawer({
  savedTheme,
  open,
  draft,
  onChange,
  onApply,
  onBack,
  onClose,
  onExited,
}: ThemeCustomizerDrawerProps) {
  const [retainedDraft, setRetainedDraft] = useState(draft ?? savedTheme);
  const activeDraft = draft ?? retainedDraft;
  const [activeStop, setActiveStop] = useState(Math.max(0, activeDraft.colorStops.length - 1));
  const { isMounted, presenceState, onAnimationEnd } = useExitPresence(open, { exitDuration: 180, onExited });
  const drawerRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const currentStop = activeDraft.colorStops[activeStop] ?? activeDraft.colorStops[0];

  useEffect(() => {
    if (draft) setRetainedDraft(draft);
  }, [draft]);

  useEffect(() => {
    if (activeStop >= activeDraft.colorStops.length) setActiveStop(Math.max(0, activeDraft.colorStops.length - 1));
  }, [activeDraft.colorStops.length, activeStop]);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    if (!isMounted || !open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLElement>("button")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isMounted, open]);

  useEffect(() => {
    if (isMounted || !previousFocus.current) return;
    previousFocus.current.focus();
    previousFocus.current = null;
  }, [isMounted]);

  function changeActiveColor(value: string) {
    onChange(updateThemeStop(activeDraft, activeStop, value));
  }

  function addColor() {
    if (activeDraft.colorStops.length >= 8) return;
    onChange(addThemeStop(activeDraft));
    setActiveStop(activeDraft.colorStops.length);
  }

  function removeColor(index: number) {
    if (activeDraft.colorStops.length <= 1) return;
    onChange(removeThemeStop(activeDraft, index));
    setActiveStop((current) => {
      if (index < current) return current - 1;
      return Math.min(current, activeDraft.colorStops.length - 2);
    });
  }

  if (!isMounted) return null;

  return (
    <aside
      className="theme-drawer"
      data-state={presenceState}
      ref={drawerRef}
      aria-label="Customize your theme"
      tabIndex={-1}
      onAnimationEnd={onAnimationEnd}
    >
      <header className="theme-drawer-heading">
        <h2>Customize your theme</h2>
        <button type="button" aria-label="Close theme customizer" onClick={onClose}><X size={19} /></button>
      </header>

      <div className="theme-drawer-scroll">
        <section className="drawer-section">
          <h3>Appearance</h3>
          <div className="surface-mode-toggle" role="group" aria-label="Surface appearance">
            <button
              className={activeDraft.base !== "light" ? "is-active" : ""}
              type="button"
              aria-label="Use dark appearance"
              onClick={() => onChange(markThemeCustom({ ...activeDraft, base: "dusk" }))}
            >
              <Moon size={16} />
            </button>
            <button
              className={activeDraft.base === "light" ? "is-active" : ""}
              type="button"
              aria-label="Use light appearance"
              onClick={() => onChange(markThemeCustom({ ...activeDraft, base: "light" }))}
            >
              <Sun size={16} />
            </button>
          </div>
        </section>

        <section className="drawer-section">
          <h3>Colors</h3>
          <HsvColorPicker value={currentStop} onChange={changeActiveColor} />

          <div className="drawer-color-list">
            {activeDraft.colorStops.map((stop, index) => (
              <HexColorRow
                active={activeStop === index}
                key={`${index}-${stop}`}
                value={stop}
                onFocus={() => setActiveStop(index)}
                onChange={(value) => onChange(updateThemeStop(activeDraft, index, value))}
                onRemove={() => removeColor(index)}
                removeDisabled={activeDraft.colorStops.length <= 1}
              />
            ))}
          </div>
          <button className="drawer-wide-button" type="button" onClick={addColor} disabled={activeDraft.colorStops.length >= 8}>
            <Plus size={16} /> Add color
          </button>
        </section>

        <section className="drawer-section">
          <h3>Controls</h3>
          <SliderRow
            label="Gradient direction"
            value={`${activeDraft.gradientDirection}°`}
            min={0}
            max={360}
            numericValue={activeDraft.gradientDirection}
            onChange={(gradientDirection) => onChange(markThemeCustom({ ...activeDraft, gradientDirection }))}
          />
          <SliderRow
            label="Color intensity"
            value={`${activeDraft.intensity}%`}
            min={20}
            max={100}
            numericValue={activeDraft.intensity}
            onChange={(intensity) => onChange(markThemeCustom({ ...activeDraft, intensity }))}
          />
        </section>

        <section className="drawer-actions-section">
          <button className="drawer-wide-button" type="button" onClick={() => onChange(surpriseTheme(activeDraft))}>
            <Dice5 size={16} /> Surprise me
          </button>
          <button className="drawer-wide-button" type="button" onClick={() => onChange(cloneTheme(savedTheme))}>
            <RotateCcw size={16} /> Reset
          </button>
        </section>
      </div>

      <footer className="theme-drawer-footer">
        <button className="secondary-button" type="button" onClick={onBack}>Back</button>
        <button className="primary-button" type="button" onClick={onApply}>Apply</button>
      </footer>
    </aside>
  );
}

function HexColorRow({
  active,
  value,
  onFocus,
  onChange,
  onRemove,
  removeDisabled,
}: {
  active: boolean;
  value: string;
  onFocus: () => void;
  onChange: (value: string) => void;
  onRemove: () => void;
  removeDisabled: boolean;
}) {
  const [inputValue, setInputValue] = useState(value);

  useEffect(() => setInputValue(value), [value]);

  return (
    <div className={`drawer-color-row ${active ? "is-active" : ""}`}>
      <button className="drawer-swatch" style={{ background: value }} type="button" aria-label={`Select ${value}`} onClick={onFocus} />
      <input
        value={inputValue}
        onFocus={onFocus}
        onChange={(event) => {
          const nextValue = event.target.value.toUpperCase();
          setInputValue(nextValue);
          if (isValidHex(nextValue)) onChange(nextValue);
        }}
        onBlur={() => setInputValue(value)}
        aria-label={`Color value ${value}`}
      />
      <button type="button" aria-label={`Remove ${value}`} onClick={onRemove} disabled={removeDisabled}><Minus size={16} /></button>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  numericValue,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  numericValue: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="drawer-slider-row">
      <span><strong>{label}</strong><b>{value}</b></span>
      <input type="range" min={min} max={max} value={numericValue} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
