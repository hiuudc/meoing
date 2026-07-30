import { Check, LoaderCircle, UserRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import { apiErrorMessage } from "../api/client";
import { uploadProfileImage } from "../api/files";
import {
  changeUsername,
  checkUsernameAvailability,
  updateMainProfile,
} from "../api/profile";
import { AnimatedModal } from "../components/AnimatedModal";
import { useAuth } from "./AuthProvider";

const USERNAME_PATTERN = /^(?!.*\.\.)[a-z0-9._]{3,32}$/;

interface AccountSettingsModalProps {
  onClose: () => void;
}

type AvailabilityState = "idle" | "checking" | "available" | "unavailable";

export function AccountSettingsModal({ onClose }: AccountSettingsModalProps) {
  const auth = useAuth();
  const profile = auth.currentUser?.profile;
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [avatarAssetId, setAvatarAssetId] = useState(profile?.avatarAssetId ?? "");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [username, setUsername] = useState(profile?.username ?? "");
  const [availability, setAvailability] = useState<AvailabilityState>("idle");
  const [profileBusy, setProfileBusy] = useState(false);
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const normalizedUsername = username.trim().toLowerCase();
  const usernameValid = USERNAME_PATTERN.test(normalizedUsername);
  const usernameChanged = normalizedUsername !== profile?.username;
  const cooldownEndsAt = useMemo(() => {
    if (!profile?.usernameChangedAt) return null;
    const end = new Date(profile.usernameChangedAt);
    end.setDate(end.getDate() + 7);
    return end > new Date() ? end : null;
  }, [profile?.usernameChangedAt]);

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.api || !profile || !displayName.trim()) return;
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
        expectedRevision: profile.revision ?? 0,
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

  async function checkAvailability() {
    if (!auth.api || !usernameValid || !usernameChanged) return;
    setAvailability("checking");
    setError("");
    setNotice("");
    try {
      const response = await checkUsernameAvailability(auth.api, normalizedUsername);
      setAvailability(response.data.available ? "available" : "unavailable");
    } catch (caught) {
      setAvailability("idle");
      setError(apiErrorMessage(caught));
    }
  }

  async function saveUsername() {
    if (
      !auth.api
      || !usernameValid
      || !usernameChanged
      || availability !== "available"
      || cooldownEndsAt
    ) return;
    setUsernameBusy(true);
    setError("");
    setNotice("");
    try {
      await changeUsername(auth.api, normalizedUsername);
      await auth.refreshCurrentUser();
      setAvailability("idle");
      setNotice("Username changed. Your previous username remains reserved for 30 days.");
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setUsernameBusy(false);
    }
  }

  if (!profile) return null;

  return (
    <AnimatedModal
      open
      onClose={onClose}
      labelledBy="account-settings-title"
      backdropClassName="modal-backdrop"
      panelClassName="account-settings-modal"
    >
      <header className="modal-header">
        <div>
          <p>Your account</p>
          <h2 id="account-settings-title">Main profile</h2>
        </div>
        <button type="button" aria-label="Close account settings" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <div className="account-settings-body">
        {error ? <p className="auth-alert" role="alert">{error}</p> : null}
        {notice ? <p className="auth-notice" role="status">{notice}</p> : null}

        <form className="account-settings-section" onSubmit={(event) => void saveProfile(event)}>
          <div className="account-settings-heading">
            <UserRound size={19} />
            <div>
              <h3>Public details</h3>
              <p>Your main profile is visible only to people who share a collection with you.</p>
            </div>
          </div>
          <label>
            Display name
            <input
              value={displayName}
              maxLength={64}
              required
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label>
            Bio
            <textarea
              value={bio}
              maxLength={500}
              rows={3}
              onChange={(event) => setBio(event.target.value)}
            />
          </label>
          <label>
            Avatar image
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)}
            />
            <small>
              {avatarFile?.name ?? (avatarAssetId ? "A private main-profile avatar is set." : "No avatar set.")}
            </small>
          </label>
          {avatarAssetId || avatarFile ? (
            <button
              className="account-settings-clear"
              type="button"
              onClick={() => {
                setAvatarAssetId("");
                setAvatarFile(null);
              }}
            >
              Clear avatar
            </button>
          ) : null}
          <div className="account-settings-actions">
            <button className="primary-button" type="submit" disabled={profileBusy || !displayName.trim()}>
              {profileBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              Save profile
            </button>
          </div>
        </form>

        <section className="account-settings-section">
          <div className="account-settings-heading">
            <span className="profile-avatar">@</span>
            <div>
              <h3>Username</h3>
              <p>3–32 lowercase letters, numbers, dots or underscores; consecutive dots are not allowed.</p>
            </div>
          </div>
          <label>
            Username
            <input
              value={username}
              minLength={3}
              maxLength={32}
              pattern="(?!.*\.\.)[a-z0-9._]{3,32}"
              onChange={(event) => {
                setUsername(event.target.value.toLowerCase());
                setAvailability("idle");
              }}
            />
          </label>
          {cooldownEndsAt ? (
            <p className="account-settings-help">
              Username changes unlock on {cooldownEndsAt.toLocaleString()}.
            </p>
          ) : availability === "available" ? (
            <p className="account-settings-available" role="status">@{normalizedUsername} is available.</p>
          ) : availability === "unavailable" ? (
            <p className="auth-alert" role="alert">@{normalizedUsername} is unavailable.</p>
          ) : null}
          <div className="account-settings-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={!usernameValid || !usernameChanged || availability === "checking" || Boolean(cooldownEndsAt)}
              onClick={() => void checkAvailability()}
            >
              {availability === "checking" ? "Checking…" : "Check availability"}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={usernameBusy || availability !== "available" || Boolean(cooldownEndsAt)}
              onClick={() => void saveUsername()}
            >
              {usernameBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              Change username
            </button>
          </div>
        </section>
      </div>
    </AnimatedModal>
  );
}

export type { AccountSettingsModalProps };
