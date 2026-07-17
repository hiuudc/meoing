import { BookOpenText, GraduationCap } from "lucide-react";

export type WorkspaceMode = "library" | "learn";

interface WorkspaceModeSwitchProps {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}

export function WorkspaceModeSwitch({ mode, onChange }: WorkspaceModeSwitchProps) {
  return (
    <div className="workspace-mode-switch" role="tablist" aria-label="Workspace mode">
      <button type="button" role="tab" aria-selected={mode === "library"} className={mode === "library" ? "is-active" : ""} onClick={() => onChange("library")}>
        <BookOpenText size={15} /> Library
      </button>
      <button type="button" role="tab" aria-selected={mode === "learn"} className={mode === "learn" ? "is-active" : ""} onClick={() => onChange("learn")}>
        <GraduationCap size={15} /> Learn
      </button>
    </div>
  );
}
