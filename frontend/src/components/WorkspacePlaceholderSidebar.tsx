import { Search, X } from "lucide-react";
import type { ReactNode } from "react";

interface WorkspacePlaceholderSidebarProps {
  accountMenu: ReactNode;
  loading: boolean;
  openOnMobile: boolean;
  onCloseMobile: () => void;
}

export function WorkspacePlaceholderSidebar({
  accountMenu,
  loading,
  openOnMobile,
  onCloseMobile,
}: WorkspacePlaceholderSidebarProps) {
  return (
    <aside
      className={`workspace-sidebar workspace-placeholder-sidebar ${openOnMobile ? "is-mobile-open" : ""}`}
      aria-label="Workspace navigation"
    >
      <div className="sidebar-heading">
        <span>Workspace</span>
        <button className="mobile-sidebar-close" type="button" onClick={onCloseMobile} aria-label="Close navigation">
          <X size={18} />
        </button>
      </div>
      <label className="sidebar-search" aria-disabled="true">
        <Search size={14} />
        <input aria-label="Find anything" placeholder="Find anything" disabled />
        <kbd>Ctrl K</kbd>
      </label>
      <nav className="sidebar-scroll">
        <p className="sidebar-section-label">Collections</p>
        <p className="sidebar-empty">
          {loading ? "Loading your collections..." : "Create a collection from the + button to begin."}
        </p>
      </nav>
      <div className="sidebar-footer">{accountMenu}</div>
    </aside>
  );
}
