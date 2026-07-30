import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { ApiClient } from "../api/client";
import { getPublicAppConfig } from "../api/config";
import { flushProgressOutbox } from "../api/progressOutbox";

export interface MainProfile {
  id: string;
  username: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatarAssetId?: string | null;
  usernameChangedAt?: string | null;
  revision: number;
}

export interface CurrentUser {
  profile: MainProfile;
  email?: string | null;
  emailVerified: boolean;
  deletionRequestedAt?: string | null;
  effectivePermissions?: string[];
}

interface AuthContextValue {
  session: Session | null;
  currentUser: CurrentUser | null;
  loading: boolean;
  passwordRecovery: boolean;
  configurationError: string | null;
  turnstileSiteKey?: string;
  api: ApiClient | null;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, turnstileToken?: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  sendPasswordReset(email: string, turnstileToken?: string): Promise<void>;
  resendVerification(email: string, turnstileToken?: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  signOut(): Promise<void>;
  refreshCurrentUser(): Promise<void>;
  completeUsername(username: string): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function emailIsVerified(session: Session): boolean {
  return Boolean(session.user.email_confirmed_at);
}

function authCallbackUrl(flow?: "recovery"): string {
  const callback = new URL("/auth/callback", window.location.origin);
  const inviteToken = new URLSearchParams(window.location.search).get("invite");
  if (inviteToken) callback.searchParams.set("invite", inviteToken);
  if (flow) callback.searchParams.set("flow", flow);
  return callback.toString();
}

function normalizeCurrentUser(data: unknown, session: Session): CurrentUser {
  const root = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const rawProfile = root.profile && typeof root.profile === "object"
    ? root.profile as Record<string, unknown>
    : root;
  const id = typeof rawProfile.id === "string"
    ? rawProfile.id
    : typeof rawProfile.userId === "string"
      ? rawProfile.userId
      : session.user.id;
  const deletion = root.deletion && typeof root.deletion === "object"
    ? root.deletion as Record<string, unknown>
    : {};
  return {
    profile: {
      id,
      username: typeof rawProfile.username === "string" ? rawProfile.username : null,
      displayName: typeof rawProfile.displayName === "string" ? rawProfile.displayName : null,
      bio: typeof rawProfile.bio === "string" ? rawProfile.bio : null,
      avatarAssetId: typeof rawProfile.avatarAssetId === "string" ? rawProfile.avatarAssetId : null,
      usernameChangedAt: typeof rawProfile.usernameChangedAt === "string" ? rawProfile.usernameChangedAt : null,
      revision: typeof rawProfile.revision === "number" ? rawProfile.revision : 0,
    },
    email: typeof root.email === "string" ? root.email : session.user.email,
    emailVerified: typeof root.emailVerified === "boolean" ? root.emailVerified : emailIsVerified(session),
    deletionRequestedAt: typeof root.deletionRequestedAt === "string"
      ? root.deletionRequestedAt
      : deletion.status === "pending" && typeof deletion.requestedAt === "string"
        ? deletion.requestedAt
        : null,
    effectivePermissions: Array.isArray(root.effectivePermissions)
      ? root.effectivePermissions.filter((permission): permission is string => typeof permission === "string")
      : [],
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | undefined>();
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [api, setApi] = useState<ApiClient | null>(null);

  useEffect(() => {
    let client: SupabaseClient;
    try {
      const config = getPublicAppConfig();
      setTurnstileSiteKey(config.turnstileSiteKey);
      client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce",
        },
      });
      setSupabase(client);
      setApi(new ApiClient(config.apiUrl, async () => {
        const { data } = await client.auth.getSession();
        return data.session?.access_token ?? null;
      }));
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : "Invalid frontend configuration.");
      setLoading(false);
      return;
    }

    let active = true;
    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setConfigurationError(error.message);
      setSession(data.session);
      setLoading(false);
    });
    const { data: listener } = client.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
      setSession(nextSession);
      if (!nextSession) {
        setCurrentUser(null);
        setPasswordRecovery(false);
      }
      setLoading(false);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const refreshCurrentUser = useCallback(async () => {
    if (!api || !session || !emailIsVerified(session)) {
      setCurrentUser(null);
      return;
    }
    const response = await api.get<unknown>("/v1/me");
    setCurrentUser(normalizeCurrentUser(response.data, session));
    setConfigurationError(null);
  }, [api, session]);

  useEffect(() => {
    if (!session || !api || !emailIsVerified(session)) {
      setCurrentUser(null);
      return;
    }
    let active = true;
    setLoading(true);
    void api.get<unknown>("/v1/me")
      .then((response) => {
        if (active) {
          setCurrentUser(normalizeCurrentUser(response.data, session));
          setConfigurationError(null);
        }
      })
      .catch((error) => {
        if (active) setConfigurationError(error instanceof Error ? error.message : "Unable to load your profile.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, session]);

  useEffect(() => {
    const userId = currentUser?.profile.id;
    if (!api || !userId || currentUser.deletionRequestedAt) return;
    void flushProgressOutbox(api, userId).catch(() => undefined);
  }, [api, currentUser?.deletionRequestedAt, currentUser?.profile.id]);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    currentUser,
    loading,
    passwordRecovery,
    configurationError,
    turnstileSiteKey,
    api,
    async signIn(email, password) {
      if (!supabase) throw new Error("Authentication is not configured.");
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signUp(email, password, turnstileToken) {
      if (!supabase) throw new Error("Authentication is not configured.");
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: authCallbackUrl(),
          captchaToken: turnstileToken,
        },
      });
      if (error) throw error;
    },
    async signInWithGoogle() {
      if (!supabase) throw new Error("Authentication is not configured.");
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: authCallbackUrl(),
        },
      });
      if (error) throw error;
    },
    async sendPasswordReset(email, turnstileToken) {
      if (!supabase) throw new Error("Authentication is not configured.");
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: authCallbackUrl("recovery"),
        captchaToken: turnstileToken,
      });
      if (error) throw error;
    },
    async resendVerification(email, turnstileToken) {
      if (!supabase) throw new Error("Authentication is not configured.");
      const { error } = await supabase.auth.resend({
        type: "signup",
        email,
        options: {
          emailRedirectTo: authCallbackUrl(),
          captchaToken: turnstileToken,
        },
      });
      if (error) throw error;
    },
    async updatePassword(password) {
      if (!supabase) throw new Error("Authentication is not configured.");
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setPasswordRecovery(false);
    },
    async signOut() {
      if (!supabase) return;
      const signingOutUserId = currentUser?.profile.id;
      if (api && signingOutUserId) {
        await flushProgressOutbox(api, signingOutUserId).catch(() => undefined);
      }
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setConfigurationError(null);
      setPasswordRecovery(false);
    },
    refreshCurrentUser,
    async completeUsername(username) {
      if (!api) throw new Error("The API is not configured.");
      await api.patch("/v1/me/profile", { username });
      await refreshCurrentUser();
    },
  }), [
    api,
    configurationError,
    currentUser,
    loading,
    passwordRecovery,
    refreshCurrentUser,
    session,
    supabase,
    turnstileSiteKey,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}
