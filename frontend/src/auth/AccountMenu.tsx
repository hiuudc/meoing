import { useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "../api/client";
import { clearProgressOutboxForUser } from "../api/progressOutbox";
import { AccountSettingsModal } from "./AccountSettingsModal";
import { useAuth } from "./AuthProvider";

export function AccountMenu() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const profile = auth.currentUser?.profile;
  const displayName = profile?.displayName || profile?.username || "Meoing learner";
  const username = profile?.username ? `@${profile.username}` : "Signed in";
  const initial = displayName.trim().charAt(0).toUpperCase() || "M";

  useEffect(() => {
    if (!open) return;
    function close(event: PointerEvent) {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function requestDeletion() {
    if (!auth.api || !window.confirm(
      "Schedule account deletion? App access will lock immediately. You can cancel during the next 30 days.",
    )) return;
    setBusy(true);
    setError("");
    try {
      await auth.api.post("/v1/me/deletion", { confirmation: "DELETE" });
      const userId = auth.currentUser?.profile.id;
      if (userId) await clearProgressOutboxForUser(userId).catch(() => undefined);
      await auth.refreshCurrentUser();
      setOpen(false);
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-menu" ref={hostRef}>
      <button
        className="app-account-button profile-row"
        type="button"
        aria-label="Open account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="profile-avatar" aria-hidden="true">{initial}</span>
        <span className="profile-copy">
          <strong>{displayName}</strong>
          <small>{username}</small>
        </span>
      </button>
      {open ? (
        <div className="account-menu-popover" role="menu">
          <strong>{auth.currentUser?.profile.displayName || `@${auth.currentUser?.profile.username}`}</strong>
          <span>{auth.currentUser?.email}</span>
          {error ? <p role="alert">{error}</p> : null}
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
          >
            Edit main profile
          </button>
          <a role="menuitem" href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a>
          <a role="menuitem" href="/terms.html" target="_blank" rel="noreferrer">Terms</a>
          <a role="menuitem" href="/delete-data.html" target="_blank" rel="noreferrer">Deletion policy</a>
          <button role="menuitem" type="button" disabled={busy} onClick={() => void auth.signOut()}>
            Sign out
          </button>
          <button className="is-danger" role="menuitem" type="button" disabled={busy} onClick={() => void requestDeletion()}>
            {busy ? "Scheduling…" : "Delete account"}
          </button>
        </div>
      ) : null}
      {settingsOpen ? <AccountSettingsModal onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
