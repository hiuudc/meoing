import { Check, Palette, RotateCcw } from "lucide-react";
import { COLOR_THEME_PRESETS, resetTheme, selectBaseTheme, selectColorTheme } from "../theme";
import type { BaseTheme, ThemeConfig } from "../types";

const BASE_THEMES: { id: BaseTheme; label: string; color: string }[] = [
  { id: "light", label: "Light", color: "#F7F6F8" },
  { id: "dusk", label: "Dusk", color: "#303139" },
  { id: "midnight", label: "Midnight", color: "#151B29" },
  { id: "black", label: "Pure black", color: "#08080A" },
];

interface AppearanceSettingsPanelProps {
  draft: ThemeConfig;
  onChange: (theme: ThemeConfig) => void;
  onApply: (theme: ThemeConfig) => void | Promise<void>;
  onOpenCustomizer: (theme: ThemeConfig) => void;
}

export function AppearanceSettingsPanel({
  draft,
  onChange,
  onApply,
  onOpenCustomizer,
}: AppearanceSettingsPanelProps) {
  return (
    <div className="appearance-main account-appearance-panel">
      <section className="settings-section">
        <h4>Base themes</h4>
        <div className="base-theme-grid">
          {BASE_THEMES.map((base) => {
            const selected = draft.selection.kind === "base" && draft.selection.id === base.id;
            return (
              <button
                className={`base-theme-option ${selected ? "is-selected" : ""}`}
                type="button"
                key={base.id}
                onClick={() => onChange(selectBaseTheme(draft, base.id))}
                aria-label={base.label}
                aria-pressed={selected}
                title={base.label}
              >
                <span style={{ background: base.color }} />
                {selected ? <i><Check size={13} /></i> : null}
              </button>
            );
          })}
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
            className={`palette-option custom-palette ${draft.selection.kind === "custom" ? "is-selected" : ""}`}
            type="button"
            onClick={() => onOpenCustomizer(draft)}
            aria-label="Customize palette"
            aria-pressed={draft.selection.kind === "custom"}
          >
            <Palette size={18} />
            {draft.selection.kind === "custom" ? <i><Check size={13} /></i> : null}
          </button>
          {COLOR_THEME_PRESETS.map((palette, index) => {
            const selected = draft.selection.kind === "palette" && draft.selection.id === palette.id;
            return (
              <button
                className={`palette-option ${selected ? "is-selected" : ""}`}
                style={{ background: `linear-gradient(135deg, ${palette.colorStops.join(", ")})` }}
                type="button"
                key={palette.id}
                onClick={() => onChange(selectColorTheme(draft, palette.id))}
                aria-label={`Select color theme ${index + 1}`}
                aria-pressed={selected}
              >
                {selected ? <i><Check size={13} /></i> : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-toggles">
        <ToggleRow
          label="Sync theme across devices"
          checked={draft.syncAcrossDevices}
          onChange={(syncAcrossDevices) => onChange({ ...draft, syncAcrossDevices })}
        />
        <ToggleRow
          label="Use collection accent colors"
          checked={draft.useCollectionAccents}
          onChange={(useCollectionAccents) => onChange({ ...draft, useCollectionAccents })}
        />
      </section>

      <footer className="appearance-footer">
        <button className="secondary-button" type="button" onClick={() => onChange(resetTheme())}>Reset</button>
        <button className="primary-button" type="button" onClick={() => void onApply(draft)}>Apply theme</button>
      </footer>
    </div>
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
