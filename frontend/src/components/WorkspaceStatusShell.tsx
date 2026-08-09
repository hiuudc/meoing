import type { ReactNode } from "react";
import { themeStyle } from "../theme";
import type { ThemeConfig } from "../types";

interface WorkspaceStatusShellProps {
  children: ReactNode;
  theme: ThemeConfig;
}

export function WorkspaceStatusShell({ children, theme }: WorkspaceStatusShellProps) {
  return (
    <div className="app-shell app-shell-status" style={themeStyle(theme)}>
      {children}
    </div>
  );
}
