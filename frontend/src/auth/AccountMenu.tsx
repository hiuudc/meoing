import { useState } from "react";
import { AccountSettingsModal } from "./AccountSettingsModal";
import { useAuth } from "./AuthProvider";
import { ProfileAvatar } from "./ProfileAvatar";

export function AccountMenu() {
  const auth = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const profile = auth.currentUser?.profile;
  const displayName = profile?.displayName || profile?.username || "Meoing learner";
  const username = profile?.username ? `@${profile.username}` : "Signed in";

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
      {settingsOpen ? <AccountSettingsModal onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
