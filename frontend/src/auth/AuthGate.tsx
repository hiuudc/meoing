import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { apiErrorMessage } from "../api/client";
import { useAuth } from "./AuthProvider";
import { Turnstile } from "./Turnstile";

type AuthMode = "sign-in" | "sign-up";

const USERNAME_PATTERN = /^(?!.*\.\.)[a-z0-9._]{3,32}$/;

function AuthCard({ children, title, subtitle }: { children: ReactNode; title: string; subtitle: string }) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand" aria-hidden="true">M</div>
        <header>
          <h1 id="auth-title">{title}</h1>
          <p>{subtitle}</p>
        </header>
        {children}
      </section>
    </main>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileRevision, setTurnstileRevision] = useState(0);
  const setChallengeToken = useCallback((token: string | null) => setTurnstileToken(token), []);
  const turnstileSiteKey = auth.turnstileSiteKey;

  function resetChallenge() {
    setTurnstileToken(null);
    setTurnstileRevision((revision) => revision + 1);
  }

  async function run(action: () => Promise<void>, successMessage?: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      if (successMessage) setMessage(successMessage);
    } catch (actionError) {
      setError(apiErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  }

  async function submitCredentials(event: FormEvent) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (mode === "sign-up") {
      await run(
        async () => {
          await auth.signUp(normalizedEmail, password, turnstileToken ?? undefined);
          resetChallenge();
        },
        "Check your inbox to verify your email before continuing.",
      );
    } else {
      await run(() => auth.signIn(normalizedEmail, password));
    }
  }

  if (auth.loading) {
    return (
      <AuthCard title="Opening Meoing" subtitle="Checking your secure session…">
        <div className="auth-loading" role="status"><span /> Connecting</div>
      </AuthCard>
    );
  }

  if (auth.configurationError) {
    return (
      <AuthCard title="Meoing is not configured" subtitle="The frontend cannot connect to Auth or the API.">
        <p className="auth-alert" role="alert">{auth.configurationError}</p>
        {auth.session ? (
          <>
            <button className="auth-primary" type="button" disabled={busy} onClick={() => void run(auth.refreshCurrentUser)}>
              Try again
            </button>
            <button className="auth-secondary" type="button" disabled={busy} onClick={() => void run(auth.signOut)}>
              Sign out
            </button>
          </>
        ) : null}
      </AuthCard>
    );
  }

  if (!auth.session) {
    return (
      <AuthCard
        title={mode === "sign-in" ? "Welcome back" : "Create your account"}
        subtitle="Your learning data is synced securely across devices."
      >
        <form className="auth-form" onSubmit={submitCredentials}>
          <label>
            <span>Email</span>
            <input
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              disabled={busy}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              minLength={8}
              required
              disabled={busy}
            />
          </label>
          {error ? <p className="auth-alert" role="alert">{error}</p> : null}
          {message ? <p className="auth-notice" role="status">{message}</p> : null}
          <Turnstile
            key={turnstileRevision}
            siteKey={turnstileSiteKey}
            onToken={setChallengeToken}
          />
          <button
            className="auth-primary"
            type="submit"
            disabled={busy || Boolean(mode === "sign-up" && turnstileSiteKey && !turnstileToken)}
          >
            {busy ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
        </form>
        <div className="auth-divider"><span>or</span></div>
        <button className="auth-secondary" type="button" disabled={busy} onClick={() => void run(() => auth.signInWithGoogle())}>
          Continue with Google
        </button>
        <div className="auth-links">
          <button
            type="button"
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
              setError(null);
              setMessage(null);
            }}
          >
            {mode === "sign-in" ? "Create an account" : "Already have an account?"}
          </button>
          {mode === "sign-in" ? (
            <button
              type="button"
              disabled={!email.trim() || busy || Boolean(turnstileSiteKey && !turnstileToken)}
              onClick={() => void run(
                async () => {
                  await auth.sendPasswordReset(
                    email.trim().toLowerCase(),
                    turnstileToken ?? undefined,
                  );
                  resetChallenge();
                },
                "If that account exists, a reset link is on its way.",
              )}
            >
              Forgot password?
            </button>
          ) : (
            <button
              type="button"
              disabled={!email.trim() || busy || Boolean(turnstileSiteKey && !turnstileToken)}
              onClick={() => void run(
                async () => {
                  await auth.resendVerification(
                    email.trim().toLowerCase(),
                    turnstileToken ?? undefined,
                  );
                  resetChallenge();
                },
                "A new verification link has been sent.",
              )}
            >
              Resend verification email
            </button>
          )}
        </div>
      </AuthCard>
    );
  }

  if (!auth.session.user.email_confirmed_at) {
    return (
      <AuthCard title="Verify your email" subtitle={`We sent a verification link to ${auth.session.user.email ?? "your inbox"}.`}>
        {error ? <p className="auth-alert" role="alert">{error}</p> : null}
        {message ? <p className="auth-notice" role="status">{message}</p> : null}
        <Turnstile
          key={turnstileRevision}
          siteKey={turnstileSiteKey}
          onToken={setChallengeToken}
        />
        <button
          className="auth-primary"
          type="button"
          disabled={busy || !auth.session.user.email || Boolean(turnstileSiteKey && !turnstileToken)}
          onClick={() => void run(async () => {
            await auth.resendVerification(
              auth.session!.user.email!,
              turnstileToken ?? undefined,
            );
            resetChallenge();
          }, "A new verification link has been sent.")}
        >
          Resend verification
        </button>
        <button className="auth-secondary" type="button" disabled={busy} onClick={() => void run(auth.signOut)}>
          Use another account
        </button>
      </AuthCard>
    );
  }

  if (auth.passwordRecovery) {
    const passwordValid = password.length >= 8 && password === passwordConfirmation;
    return (
      <AuthCard title="Choose a new password" subtitle="Finish the secure recovery flow for your Meoing account.">
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (passwordValid) void run(() => auth.updatePassword(password), "Your password has been updated.");
          }}
        >
          <label>
            <span>New password</span>
            <input
              type="password"
              name="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              disabled={busy}
            />
          </label>
          <label>
            <span>Confirm password</span>
            <input
              type="password"
              name="confirm-password"
              value={passwordConfirmation}
              onChange={(event) => setPasswordConfirmation(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              disabled={busy}
            />
          </label>
          {passwordConfirmation && password !== passwordConfirmation ? (
            <p className="auth-alert" role="alert">Passwords do not match.</p>
          ) : null}
          {error ? <p className="auth-alert" role="alert">{error}</p> : null}
          {message ? <p className="auth-notice" role="status">{message}</p> : null}
          <button className="auth-primary" type="submit" disabled={busy || !passwordValid}>
            Update password
          </button>
        </form>
      </AuthCard>
    );
  }

  if (!auth.currentUser?.profile.username) {
    const normalizedUsername = username.trim().toLowerCase();
    const usernameValid = USERNAME_PATTERN.test(normalizedUsername);
    return (
      <AuthCard title="Choose your username" subtitle="This is your permanent identity across collections.">
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (usernameValid) void run(() => auth.completeUsername(normalizedUsername));
          }}
        >
          <label>
            <span>Username</span>
            <input
              type="text"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              autoComplete="username"
              minLength={3}
              maxLength={32}
              pattern="(?!.*\.\.)[a-z0-9._]{3,32}"
              aria-describedby="username-help"
              required
              disabled={busy}
            />
          </label>
          <small id="username-help">3–32 lowercase letters, numbers, dots or underscores. Consecutive dots are not allowed.</small>
          {error ? <p className="auth-alert" role="alert">{error}</p> : null}
          <button className="auth-primary" type="submit" disabled={busy || !usernameValid}>
            Continue to Meoing
          </button>
        </form>
        <button className="auth-secondary" type="button" disabled={busy} onClick={() => void run(auth.signOut)}>
          Sign out
        </button>
      </AuthCard>
    );
  }

  if (auth.currentUser.deletionRequestedAt) {
    return (
      <AuthCard title="Account deletion scheduled" subtitle="Your application access is locked during the 30-day cancellation window.">
        <p className="auth-notice">
          Requested at {new Date(auth.currentUser.deletionRequestedAt).toLocaleString()}.
        </p>
        <button
          className="auth-primary"
          type="button"
          disabled={busy}
          onClick={() => void run(async () => {
            await auth.api?.delete("/v1/me/deletion");
            await auth.refreshCurrentUser();
          })}
        >
          Cancel deletion
        </button>
        <button className="auth-secondary" type="button" disabled={busy} onClick={() => void run(auth.signOut)}>
          Sign out
        </button>
      </AuthCard>
    );
  }

  return <>{children}</>;
}
