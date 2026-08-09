import type { CSSProperties, ReactNode } from "react";
import { themeStyle } from "../theme";
import type { ThemeConfig } from "../types";

interface WorkspaceStatusShellProps {
  children: ReactNode;
  sidebarWidth?: number;
  theme: ThemeConfig;
}

export function WorkspaceStatusShell({ children, sidebarWidth, theme }: WorkspaceStatusShellProps) {
  return (
    <div
      className="app-shell app-shell-status"
      style={{
        ...themeStyle(theme),
        ...(sidebarWidth ? { "--sidebar-width": `${sidebarWidth}px` } : {}),
      } as CSSProperties}
    >
      {children}
    </div>
  );
}
