import { Check, Palette, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { COLOR_THEME_PRESETS, resetTheme, selectBaseTheme, selectColorTheme } from "../theme";
import type { BaseTheme, ThemeConfig } from "../types";
import { AnimatedModal } from "./AnimatedModal";

const BASE_THEMES: { id: BaseTheme; label: string; color: string }[] = [
  { id: "light", label: "Light", color: "#F7F6F8" },
  { id: "dusk", label: "Dusk", color: "#303139" },
  { id: "midnight", label: "Midnight", color: "#151B29" },
  { id: "black", label: "Pure black", color: "#08080A" },
];

interface AppearanceModalProps {
  open: boolean;
  draft: ThemeConfig | null;
  onClose: () => void;
  onExited: () => void;
  onChange: (theme: ThemeConfig) => void;
  onApply: (theme: ThemeConfig) => void;
  onOpenCustomizer: (theme: ThemeConfig) => void;
}

export function AppearanceModal({ open, draft, onClose, onExited, onChange, onApply, onOpenCustomizer }: AppearanceModalProps) {
  const [retainedDraft, setRetainedDraft] = useState(draft);
  const activeDraft = draft ?? retainedDraft;

  useEffect(() => {
    if (draft) setRetainedDraft(draft);
  }, [draft]);

  if (!activeDraft) return null;

  function applyDraft() {
    if (activeDraft) onApply(activeDraft);
  }

  return (
    <AnimatedModal
      open={open}
      onClose={onClose}
      onExited={onExited}
      labelledBy="appearance-title"
      backdropClassName="appearance-backdrop"
      panelClassName="appearance-modal"
    >
        <header className="appearance-header">
          <div>
            <p>Workspace settings</p>
            <h2 id="appearance-title">Appearance</h2>
          </div>
          <button type="button" aria-label="Close appearance settings" onClick={onClose}><X size={20} /></button>
        </header>

        <div className="appearance-layout">
          <div className="appearance-main">
            <div className="appearance-title-row">
              <div>
                <h3>Theme</h3>
                <p>Choose a look for your study space.</p>
              </div>
            </div>

            <section className="settings-section">
              <h4>Base themes</h4>
              <div className="base-theme-grid">
                {BASE_THEMES.map((base) => (
                  <button
                    className={`base-theme-option ${activeDraft.selection.kind === "base" && activeDraft.selection.id === base.id ? "is-selected" : ""}`}
                    type="button"
                    key={base.id}
                    onClick={() => onChange(selectBaseTheme(activeDraft, base.id))}
                    aria-label={base.label}
                    aria-pressed={activeDraft.selection.kind === "base" && activeDraft.selection.id === base.id}
                    title={base.label}
                  >
                    <span style={{ background: base.color }} />
                    {activeDraft.selection.kind === "base" && activeDraft.selection.id === base.id ? <i><Check size={13} /></i> : null}
                  </button>
                ))}
                <button
                  className="base-theme-option refresh-theme"
                  type="button"
                  aria-label="Reset theme"
                  title="Reset theme"
                  onClick={() => onChange(resetTheme())}
                >
                  <RotateCcw size={18} />
                </button>
              </div>
            </section>

            <section className="settings-section">
              <h4>Color themes</h4>
              <p>Make your workspace feel like yours.</p>
              <div className="palette-grid">
                <button
                  className={`palette-option custom-palette ${activeDraft.selection.kind === "custom" ? "is-selected" : ""}`}
                  type="button"
                  onClick={() => onOpenCustomizer(activeDraft)}
                  aria-label="Customize palette"
                  aria-pressed={activeDraft.selection.kind === "custom"}
                >
                  <Palette size={18} />
                  {activeDraft.selection.kind === "custom" ? <i><Check size={13} /></i> : null}
                </button>
                {COLOR_THEME_PRESETS.map((palette, index) => (
                  <button
                    className={`palette-option ${activeDraft.selection.kind === "palette" && activeDraft.selection.id === palette.id ? "is-selected" : ""}`}
                    style={{ background: `linear-gradient(135deg, ${palette.colorStops.join(", ")})` }}
                    type="button"
                    key={palette.id}
                    onClick={() => onChange(selectColorTheme(activeDraft, palette.id))}
                    aria-label={`Select color theme ${index + 1}`}
                    aria-pressed={activeDraft.selection.kind === "palette" && activeDraft.selection.id === palette.id}
                  >
                    {activeDraft.selection.kind === "palette" && activeDraft.selection.id === palette.id ? <i><Check size={13} /></i> : null}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-toggles">
              <ToggleRow
                label="Sync theme across devices"
                checked={activeDraft.syncAcrossDevices}
                onChange={(syncAcrossDevices) => onChange({ ...activeDraft, syncAcrossDevices })}
              />
              <ToggleRow
                label="Use collection accent colors"
                checked={activeDraft.useCollectionAccents}
                onChange={(useCollectionAccents) => onChange({ ...activeDraft, useCollectionAccents })}
              />
            </section>

            <footer className="appearance-footer">
              <button className="secondary-button" type="button" onClick={() => onChange(resetTheme())}>Reset</button>
              <button className="primary-button" type="button" onClick={applyDraft}>Apply theme</button>
            </footer>
          </div>
        </div>
    </AnimatedModal>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}
