import { Check, LoaderCircle, X } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { apiErrorMessage } from "../api/client";
import { clearProgressOutboxForUser } from "../api/progressOutbox";
import { changeUsername, checkUsernameAvailability } from "../api/profile";
import { AnimatedModal } from "../components/AnimatedModal";
import { useAuth } from "./AuthProvider";

const USERNAME_PATTERN = /^(?!.*\.\.)[a-z0-9._]{3,32}$/;

interface ActionDialogProps {
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
}

function ActionDialog({ title, description, onClose, children }: ActionDialogProps) {
  const titleId = `account-action-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <AnimatedModal
      open
      onClose={onClose}
      labelledBy={titleId}
      backdropClassName="modal-backdrop account-action-backdrop"
      panelClassName="account-action-modal"
    >
      <header>
        <div>
          <h2 id={titleId}>{title}</h2>
          <p>{description}</p>
        </div>
        <button type="button" aria-label={`Close ${title}`} onClick={onClose}><X size={22} /></button>
      </header>
      {children}
    </AnimatedModal>
  );
}

interface SettingsDialogProps {
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export function UsernameDialog({ onClose, onSuccess }: SettingsDialogProps) {
  const auth = useAuth();
  const profile = auth.currentUser?.profile;
  const [username, setUsername] = useState(profile?.username ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [availability, setAvailability] = useState<"idle" | "checking" | "available" | "unavailable">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const normalizedUsername = username.trim().toLowerCase();
  const usernameValid = USERNAME_PATTERN.test(normalizedUsername);
  const cooldownEndsAt = useMemo(() => {
    if (!profile?.usernameChangedAt) return null;
    const end = new Date(profile.usernameChangedAt);
    end.setDate(end.getDate() + 7);
    return end > new Date() ? end : null;
  }, [profile?.usernameChangedAt]);

  async function checkAvailability() {
    if (!auth.api || !usernameValid || normalizedUsername === profile?.username) return;
    setAvailability("checking");
    setError("");
    try {
      const response = await checkUsernameAvailability(auth.api, normalizedUsername);
      setAvailability(response.data.available ? "available" : "unavailable");
    } catch (caught) {
      setAvailability("idle");
      setError(apiErrorMessage(caught));
    }
  }

  async function sendCode() {
    setBusy(true);
    setError("");
    try {
      await auth.sendEmailOtp();
      setCodeSent(true);
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!auth.api || availability !== "available" || cooldownEndsAt) return;
    setBusy(true);
    setError("");
    try {
      if (auth.hasPassword) await auth.verifyCurrentPassword(password);
      else await auth.verifyEmailOtp(code);
      await changeUsername(auth.api, normalizedUsername);
      await auth.refreshCurrentUser();
      onSuccess("Username changed. Your previous username remains reserved for 30 days.");
      onClose();
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionDialog title="Change your username" description="Choose a new username and verify this account." onClose={onClose}>
      <form className="account-action-form" onSubmit={(event) => void submit(event)}>
        <label>Username
          <input
            data-modal-autofocus
            value={username}
            minLength={3}
            maxLength={32}
            pattern="(?!.*\.\.)[a-z0-9._]{3,32}"
            onChange={(event) => {
              setUsername(event.target.value.toLowerCase());
              setAvailability("idle");
            }}
            required
          />
          <small>Use lowercase letters, numbers, underscores or periods.</small>
        </label>
        {cooldownEndsAt ? <p className="auth-alert">Changes unlock on {cooldownEndsAt.toLocaleString()}.</p> : null}
        {!auth.hasPassword && !codeSent ? (
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void sendCode()}>
            Send verification code
          </button>
        ) : auth.hasPassword ? (
          <label>Current password
            <input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required />
          </label>
        ) : (
          <label>Email verification code
            <input inputMode="numeric" value={code} autoComplete="one-time-code" onChange={(event) => setCode(event.target.value)} required />
          </label>
        )}
        {availability === "available" ? <p className="auth-notice">@{normalizedUsername} is available.</p> : null}
        {availability === "unavailable" ? <p className="auth-alert">@{normalizedUsername} is unavailable.</p> : null}
        {error ? <p className="auth-alert" role="alert">{error}</p> : null}
        <div className="account-action-buttons">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button
            className="secondary-button"
            type="button"
            disabled={!usernameValid || normalizedUsername === profile?.username || availability === "checking" || Boolean(cooldownEndsAt)}
            onClick={() => void checkAvailability()}
          >
            {availability === "checking" ? "Checking..." : "Check availability"}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || availability !== "available" || Boolean(cooldownEndsAt) || (!auth.hasPassword && !codeSent)}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Done
          </button>
        </div>
      </form>
    </ActionDialog>
  );
}

export function EmailDialog({ onClose, onSuccess }: SettingsDialogProps) {
  const auth = useAuth();
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function sendCode() {
    setBusy(true);
    setError("");
    try {
      await auth.sendEmailOtp();
      setCodeSent(true);
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await auth.verifyEmailOtp(code);
      await auth.changeEmail(email);
      onSuccess("Email change requested. Confirm the messages sent to your current and new addresses.");
      onClose();
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionDialog title="Change your email" description={`Verify ${auth.currentUser?.email ?? "your current email"} before changing it.`} onClose={onClose}>
      {!codeSent ? (
        <div className="account-action-form">
          {error ? <p className="auth-alert" role="alert">{error}</p> : null}
          <div className="account-action-buttons">
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="button" disabled={busy} onClick={() => void sendCode()}>
              Send verification code
            </button>
          </div>
        </div>
      ) : (
        <form className="account-action-form" onSubmit={(event) => void submit(event)}>
          <label>Verification code
            <input data-modal-autofocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required />
          </label>
          <label>New email
            <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          {error ? <p className="auth-alert" role="alert">{error}</p> : null}
          <div className="account-action-buttons">
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="submit" disabled={busy || !code.trim() || !email.trim()}>Done</button>
          </div>
        </form>
      )}
    </ActionDialog>
  );
}

export function PasswordDialog({ onClose, onSuccess }: SettingsDialogProps) {
  const auth = useAuth();
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const passwordValid = newPassword.length >= 8
    && newPassword === confirmation
    && (!auth.hasPassword || newPassword !== currentPassword);

  async function sendCode() {
    setBusy(true);
    setError("");
    try {
      await auth.sendReauthenticationCode();
      setCodeSent(true);
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!passwordValid) return;
    setBusy(true);
    setError("");
    try {
      if (auth.hasPassword) await auth.changePassword(currentPassword, newPassword);
      else await auth.setPasswordWithCode(newPassword, code);
      onSuccess(auth.hasPassword ? "Password updated." : "Password created for this account.");
      onClose();
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!auth.hasPassword && !codeSent) {
    return (
      <ActionDialog title="Create a password" description="Verify your email before adding a password to this account." onClose={onClose}>
        <div className="account-action-form">
          {error ? <p className="auth-alert" role="alert">{error}</p> : null}
          <div className="account-action-buttons">
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="button" disabled={busy} onClick={() => void sendCode()}>Send verification code</button>
          </div>
        </div>
      </ActionDialog>
    );
  }

  return (
    <ActionDialog
      title={auth.hasPassword ? "Update your password" : "Create a password"}
      description={auth.hasPassword ? "Enter your current password and a new password." : "Enter the email code and choose a password."}
      onClose={onClose}
    >
      <form className="account-action-form" onSubmit={(event) => void submit(event)}>
        {auth.hasPassword ? (
          <label>Current Password <span aria-hidden="true">*</span>
            <input data-modal-autofocus type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
          </label>
        ) : (
          <label>Email verification code <span aria-hidden="true">*</span>
            <input data-modal-autofocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required />
          </label>
        )}
        <label>New Password <span aria-hidden="true">*</span>
          <input type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
        </label>
        <label>Confirm New Password <span aria-hidden="true">*</span>
          <input type="password" autoComplete="new-password" minLength={8} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
        </label>
        {confirmation && newPassword !== confirmation ? <p className="auth-alert">Passwords do not match.</p> : null}
        {auth.hasPassword && currentPassword && newPassword === currentPassword ? <p className="auth-alert">Choose a password different from your current password.</p> : null}
        {error ? <p className="auth-alert" role="alert">{error}</p> : null}
        <div className="account-action-buttons">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={busy || !passwordValid || (!auth.hasPassword && !code.trim())}>Done</button>
        </div>
      </form>
    </ActionDialog>
  );
}

export function DeleteAccountDialog({ onClose, onSuccess }: SettingsDialogProps) {
  const auth = useAuth();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!auth.api || confirmation !== "DELETE") return;
    setBusy(true);
    setError("");
    try {
      await auth.api.post("/v1/me/deletion", { confirmation: "DELETE" });
      const userId = auth.currentUser?.profile.id;
      if (userId) await clearProgressOutboxForUser(userId).catch(() => undefined);
      await auth.refreshCurrentUser();
      onSuccess("Account deletion scheduled.");
      onClose();
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionDialog title="Delete account" description="This locks access immediately and schedules permanent deletion after 30 days." onClose={onClose}>
      <form className="account-action-form" onSubmit={(event) => void submit(event)}>
        <label>Type DELETE to confirm
          <input data-modal-autofocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
        </label>
        {error ? <p className="auth-alert" role="alert">{error}</p> : null}
        <div className="account-action-buttons">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="danger-button" type="submit" disabled={busy || confirmation !== "DELETE"}>Delete account</button>
        </div>
      </form>
    </ActionDialog>
  );
}
