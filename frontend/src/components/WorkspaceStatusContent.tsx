import { Menu } from "lucide-react";

interface WorkspaceStatusContentProps {
  error: string | null;
  loading: boolean;
  onOpenMobileNavigation: () => void;
  onRetry: () => void;
}

export function WorkspaceStatusContent({
  error,
  loading,
  onOpenMobileNavigation,
  onRetry,
}: WorkspaceStatusContentProps) {
  const status = loading ? (
    <div className="workspace-status-copy" role="status">
      <span className="cloud-workspace-spinner" />
      <h1>Loading your workspace</h1>
      <p>Meoing is fetching the latest collections and units.</p>
    </div>
  ) : error ? (
    <div className="workspace-status-copy" role="alert">
      <h1>Workspace unavailable</h1>
      <p>{error}</p>
      <button className="auth-primary" type="button" onClick={onRetry}>Try again</button>
    </div>
  ) : (
    <div className="workspace-status-copy">
      <h1>No collections yet</h1>
      <p>Use the + button in the collection rail to create your first collection.</p>
    </div>
  );

  return (
    <main className="workspace-main workspace-status-main">
      <header className="main-topbar">
        <button
          className="mobile-nav-trigger"
          type="button"
          onClick={onOpenMobileNavigation}
          aria-label="Open navigation"
        >
          <Menu size={19} />
        </button>
        <strong>Workspace</strong>
      </header>
      <div className="workspace-status-content">{status}</div>
    </main>
  );
}
