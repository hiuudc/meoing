import {
  AtSign,
  Camera,
  Database,
  KeyRound,
  LoaderCircle,
  LogOut,
  Mail,
  Palette,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { apiErrorMessage } from "../api/client";
import { uploadProfileImage } from "../api/files";
import { updateMainProfile } from "../api/profile";
import { AnimatedModal } from "../components/AnimatedModal";
import { AppearanceSettingsPanel } from "../components/AppearanceSettingsPanel";
import type { ThemeConfig } from "../types";
import {
  DeleteAccountDialog,
  EmailDialog,
  PasswordDialog,
  UsernameDialog,
} from "./AccountSettingsDialogs";
import { useAuth } from "./AuthProvider";
import { ProfileAvatar } from "./ProfileAvatar";

interface AccountSettingsModalProps {
  onClose: () => void;
  appearance?: AccountAppearanceController;
}

export interface AccountAppearanceController {
  draft: ThemeConfig;
  onOpen: () => void;
  onChange: (theme: ThemeConfig) => void;
  onApply: (theme: ThemeConfig) => void | Promise<void>;
  onDiscard: () => void;
  onOpenCustomizer: (theme: ThemeConfig) => void;
}

type AccountSection = "profile" | "account" | "security" | "privacy" | "appearance";
type AccountDialog = "username" | "email" | "password" | "delete" | null;

const SECTIONS: Array<{
  id: AccountSection;
  label: string;
  icon: typeof UserRound;
}> = [
  { id: "profile", label: "Main Profile", icon: UserRound },
  { id: "account", label: "Account Info", icon: AtSign },
  { id: "security", label: "Password & Security", icon: KeyRound },
  { id: "privacy", label: "Data & Privacy", icon: ShieldCheck },
  { id: "appearance", label: "Appearance", icon: Palette },
];

export function AccountSettingsModal({ onClose, appearance }: AccountSettingsModalProps) {
  const auth = useAuth();
  const profile = auth.currentUser?.profile;
  const [section, setSection] = useState<AccountSection>("profile");
  const [dialog, setDialog] = useState<AccountDialog>(null);
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [avatarAssetId, setAvatarAssetId] = useState(profile?.avatarAssetId ?? "");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!profile) return null;

  function closeTopLayer() {
    if (dialog) setDialog(null);
    else {
      appearance?.onDiscard();
      onClose();
    }
  }

  function showSuccess(message: string) {
    setError("");
    setNotice(message);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.api || !displayName.trim()) return;
    let uploadedAssetId: string | null = null;
    setProfileBusy(true);
    setError("");
    setNotice("");
    try {
      const nextAvatarAssetId = avatarFile
        ? await uploadProfileImage(auth.api, avatarFile, null, (assetId) => {
            uploadedAssetId = assetId;
          })
        : avatarAssetId || null;
      await updateMainProfile(auth.api, {
        displayName: displayName.trim(),
        bio: bio.trim() || null,
        avatarAssetId: nextAvatarAssetId,
        expectedRevision: profile?.revision ?? 0,
      });
      setAvatarAssetId(nextAvatarAssetId ?? "");
      setAvatarFile(null);
      await auth.refreshCurrentUser();
      setNotice("Main profile updated.");
    } catch (caught) {
      if (uploadedAssetId) {
        await auth.api.delete(`/v1/files/${encodeURIComponent(uploadedAssetId)}`).catch(() => undefined);
      }
      setError(apiErrorMessage(caught));
    } finally {
      setProfileBusy(false);
    }
  }

  async function signOut() {
    setSignOutBusy(true);
    setError("");
    try {
      await auth.signOut();
      onClose();
    } catch (caught) {
      setError(apiErrorMessage(caught));
      setSignOutBusy(false);
    }
  }

  const currentDisplayName = auth.currentUser?.profile.displayName || displayName || profile.username || "Meoing learner";

  return (
    <AnimatedModal
      open
      onClose={closeTopLayer}
      labelledBy="account-settings-title"
      backdropClassName="modal-backdrop account-settings-backdrop"
      panelClassName="account-settings-modal"
    >
      <aside className="account-settings-sidebar">
        <div className="account-settings-identity">
          <ProfileAvatar
            api={auth.api}
            assetId={avatarAssetId}
            displayName={displayName || currentDisplayName}
            file={avatarFile}
            className="account-settings-avatar"
          />
          <span>
            <strong>{currentDisplayName}</strong>
            <small>@{profile.username}</small>
          </span>
        </div>
        <nav aria-label="Account settings">
          {SECTIONS.filter(({ id }) => id !== "appearance" || appearance).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={section === id ? "is-active" : undefined}
              aria-current={section === id ? "page" : undefined}
              onClick={() => {
                setSection(id);
                if (id === "appearance") appearance?.onOpen();
              }}
            >
              <Icon size={18} /> {label}
            </button>
          ))}
        </nav>
        <button className="account-settings-logout" type="button" disabled={signOutBusy} onClick={() => void signOut()}>
          <LogOut size={18} /> {signOutBusy ? "Logging out..." : "Log out"}
        </button>
      </aside>

      <section className="account-settings-main">
        <header className="account-settings-topbar">
          <h2 id="account-settings-title">Account</h2>
          <button type="button" aria-label="Close account settings" onClick={closeTopLayer}><X size={24} /></button>
        </header>
        <div className="account-settings-content">
          {error ? <p className="auth-alert" role="alert">{error}</p> : null}
          {notice ? <p className="auth-notice" role="status">{notice}</p> : null}

          {section === "profile" ? (
            <form className="account-settings-page" onSubmit={(event) => void saveProfile(event)}>
              <div className="account-settings-page-heading">
                <p>Profile</p>
                <h3>Main Profile</h3>
                <span>This is how people see you in shared collections.</span>
              </div>
              <div className="account-profile-editor">
                <ProfileAvatar
                  api={auth.api}
                  assetId={avatarAssetId}
                  displayName={displayName || currentDisplayName}
                  file={avatarFile}
                  className="account-profile-avatar-preview"
                />
                <label className="secondary-button account-avatar-picker">
                  <Camera size={17} /> Change avatar
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)}
                  />
                </label>
                {avatarAssetId || avatarFile ? (
                  <button className="account-settings-clear" type="button" onClick={() => {
                    setAvatarAssetId("");
                    setAvatarFile(null);
                  }}>
                    Remove avatar
                  </button>
                ) : null}
              </div>
              <label>Name
                <input
                  value={displayName}
                  minLength={1}
                  maxLength={64}
                  required
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <label>Bio
                <textarea value={bio} maxLength={500} rows={5} onChange={(event) => setBio(event.target.value)} />
                <small>{bio.length}/500</small>
              </label>
              <div className="account-settings-actions">
                <button className="primary-button" type="submit" disabled={profileBusy || !displayName.trim()}>
                  {profileBusy ? <LoaderCircle className="spin" size={16} /> : null} Save changes
                </button>
              </div>
            </form>
          ) : null}

          {section === "account" ? (
            <div className="account-settings-page">
              <div className="account-settings-page-heading">
                <p>Account</p>
                <h3>Account Info</h3>
                <span>Manage the credentials associated with your account.</span>
              </div>
              <div className="account-settings-rows">
                <div>
                  <AtSign size={19} />
                  <span><strong>Username</strong><small>@{profile.username}</small></span>
                  <button className="secondary-button" type="button" onClick={() => setDialog("username")}>Edit</button>
                </div>
                <div>
                  <Mail size={19} />
                  <span><strong>Email</strong><small>{auth.currentUser?.email ?? "Unavailable"}</small></span>
                  <button className="secondary-button" type="button" onClick={() => setDialog("email")}>Edit</button>
                </div>
              </div>
            </div>
          ) : null}

          {section === "security" ? (
            <div className="account-settings-page">
              <div className="account-settings-page-heading">
                <p>Security</p>
                <h3>Password & Security</h3>
                <span>Use a unique password and verify sensitive account changes.</span>
              </div>
              <div className="account-settings-rows">
                <div>
                  <KeyRound size={19} />
                  <span>
                    <strong>Password</strong>
                    <small>{auth.hasPassword ? "A password is set for this account." : "Add password sign-in to this OAuth account."}</small>
                  </span>
                  <button className="secondary-button" type="button" onClick={() => setDialog("password")}>
                    {auth.hasPassword ? "Update" : "Set password"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {section === "privacy" ? (
            <div className="account-settings-page">
              <div className="account-settings-page-heading">
                <p>Privacy</p>
                <h3>Data & Privacy</h3>
                <span>Review Meoing policies and manage your account data.</span>
              </div>
              <div className="account-settings-links">
                <a href="/privacy.html" target="_blank" rel="noreferrer"><ShieldCheck size={19} /> Privacy policy</a>
                <a href="/terms.html" target="_blank" rel="noreferrer"><Database size={19} /> Terms of service</a>
                <a href="/delete-data.html" target="_blank" rel="noreferrer"><Database size={19} /> Deletion policy</a>
              </div>
              <div className="account-danger-zone">
                <div>
                  <strong>Delete account</strong>
                  <p>Schedule permanent account deletion. Access locks immediately and can be restored for 30 days.</p>
                </div>
                <button className="danger-button" type="button" onClick={() => setDialog("delete")}>Delete account</button>
              </div>
            </div>
          ) : null}

          {section === "appearance" && appearance ? (
            <div className="account-settings-page">
              <div className="account-settings-page-heading">
                <p>Experience</p>
                <h3>Appearance</h3>
                <span>Choose a theme and control how collection accents appear.</span>
              </div>
              <AppearanceSettingsPanel
                draft={appearance.draft}
                onChange={appearance.onChange}
                onApply={appearance.onApply}
                onOpenCustomizer={appearance.onOpenCustomizer}
              />
            </div>
          ) : null}
        </div>
      </section>

      {dialog === "username" ? <UsernameDialog onClose={() => setDialog(null)} onSuccess={showSuccess} /> : null}
      {dialog === "email" ? <EmailDialog onClose={() => setDialog(null)} onSuccess={showSuccess} /> : null}
      {dialog === "password" ? <PasswordDialog onClose={() => setDialog(null)} onSuccess={showSuccess} /> : null}
      {dialog === "delete" ? <DeleteAccountDialog onClose={() => setDialog(null)} onSuccess={showSuccess} /> : null}
    </AnimatedModal>
  );
}

export type { AccountSettingsModalProps };
