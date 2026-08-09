import { useState } from "react";
import { createPortal } from "react-dom";
import { AccountSettingsModal, type AccountAppearanceController } from "./AccountSettingsModal";
import { useAuth } from "./AuthProvider";
import { ProfileAvatar } from "./ProfileAvatar";

interface AccountMenuProps {
  appearance?: AccountAppearanceController;
}

export function AccountMenu({ appearance }: AccountMenuProps) {
  const auth = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const profile = auth.currentUser?.profile;
  const displayName = profile?.displayName || profile?.username || "Meoing learner";
  const username = profile?.username ? `@${profile.username}` : "Signed in";
  const portalTarget = document.querySelector<HTMLElement>(".app-shell") ?? document.body;

  return (
    <div className="account-menu">
      <button
        className="app-account-button profile-row"
        type="button"
        aria-label="Open account settings"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen(true)}
      >
        <ProfileAvatar
          api={auth.api}
          assetId={profile?.avatarAssetId}
          displayName={displayName}
        />
        <span className="profile-copy">
          <strong>{displayName}</strong>
          <small>{username}</small>
        </span>
      </button>
      {settingsOpen
        ? createPortal(
            <AccountSettingsModal appearance={appearance} onClose={() => setSettingsOpen(false)} />,
            portalTarget,
          )
        : null}
    </div>
  );
}
