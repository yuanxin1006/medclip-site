"use client";

import type { User } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentProfile, signOut as signOutCurrentSession, subscribeToAuthChanges } from "../../lib/auth/auth";
import type { Profile } from "../../lib/music/types";
import { getSupabaseBrowserClient, SupabaseConfigurationError } from "../../lib/supabase/client";

const AUTH_STATE_TIMEOUT_MS = 10_000;
type AuthCheckPhase = "session" | "profile";

class AuthStateTimeoutError extends Error {
  constructor(readonly phase: AuthCheckPhase) {
    super("Authentication state check timed out");
    this.name = "AuthStateTimeoutError";
  }
}

class AuthStateOperationError extends Error {
  constructor(readonly phase: AuthCheckPhase, readonly original: unknown) {
    super("Authentication state operation failed");
    this.name = "AuthStateOperationError";
  }
}

function withAuthStateTimeout<T>(operation: PromiseLike<T>, phase: AuthCheckPhase): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new AuthStateTimeoutError(phase)), AUTH_STATE_TIMEOUT_MS);
    Promise.resolve(operation).then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function authStateErrorMessage(error: unknown, phase: AuthCheckPhase): string {
  const reportedPhase = error instanceof AuthStateTimeoutError || error instanceof AuthStateOperationError
    ? error.phase
    : phase;
  const cause = error instanceof AuthStateOperationError ? error.original : error;
  const message = cause instanceof Error ? `${cause.name} ${cause.message}`.toLowerCase() : String(cause ?? "").toLowerCase();

  if (error instanceof AuthStateTimeoutError) {
    return reportedPhase === "session"
      ? "登录状态检查超时，请检查网络后重试。"
      : "账号已恢复，但个人资料读取超时，请稍后重试。";
  }
  if (/failed to fetch|network|load failed|connection|err_network|timeout/.test(message)) {
    return reportedPhase === "session"
      ? "无法连接 Supabase Auth，请检查网络后重试。"
      : "账号已恢复，但暂时无法读取个人资料。";
  }
  if (/refresh|token|session|jwt|401|403/.test(message)) {
    return reportedPhase === "session"
      ? "登录会话恢复失败，请重新登录。"
      : "账号已恢复，但个人资料暂时不可用。";
  }
  return reportedPhase === "session"
    ? "无法恢复登录状态，请重新登录。"
    : "账号已恢复，但个人资料暂时不可用。";
}

type AuthContextValue = {
  user: User | null;
  profile: Profile | null;
  displayName: string;
  loading: boolean;
  error: string | null;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const syncUser = useCallback(async (nextUser: User | null) => {
    const version = ++requestVersion.current;
    setUser(nextUser);
    setError(null);
    if (!nextUser) {
      setProfile(null);
      setLoading(false);
      return;
    }

    try {
      const nextProfile = await withAuthStateTimeout(getCurrentProfile(nextUser.id), "profile");
      if (version === requestVersion.current) setProfile(nextProfile);
    } catch (error) {
      if (version === requestVersion.current) {
        setProfile(null);
        setError(authStateErrorMessage(error, "profile"));
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    let deferredAuthSync: number | undefined;
    let authEventVersion = 0;
    let supabase: ReturnType<typeof getSupabaseBrowserClient>;
    try {
      supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToAuthChanges((event, session) => {
        if (!active) return;
        // INITIAL_SESSION duplicates the getSession bootstrap and can race it.
        // Real sign-in/out/refresh events still take precedence below.
        if (event === "INITIAL_SESSION") return;
        authEventVersion += 1;
        const nextUser = session?.user ?? null;
        if (deferredAuthSync !== undefined) window.clearTimeout(deferredAuthSync);
        deferredAuthSync = window.setTimeout(() => {
          deferredAuthSync = undefined;
          if (active) void syncUser(nextUser);
        }, 0);
      });
    } catch (error) {
      setUser(null);
      setProfile(null);
      setError(error instanceof SupabaseConfigurationError
        ? "Supabase 尚未正确配置。"
        : "Supabase 登录组件初始化失败，请刷新页面后重试。");
      setLoading(false);
      return () => {
        active = false;
        requestVersion.current += 1;
        unsubscribe();
      };
    }

    const initialEventVersion = authEventVersion;
    void (async () => {
      try {
        const { data, error } = await withAuthStateTimeout(supabase.auth.getSession(), "session");
        if (error) throw new AuthStateOperationError("session", error);
        if (!active) return;

        // If a real sign-in/sign-out event arrived while getSession was pending,
        // let that newer event own the state instead of applying an older snapshot.
        if (authEventVersion !== initialEventVersion) return;
        const session = data.session;
        if (session) {
          const { data: userData, error: userError } = await withAuthStateTimeout(
            supabase.auth.getUser(),
            "session",
          );
          if (!active || authEventVersion !== initialEventVersion) return;
          if (userError) throw new AuthStateOperationError("session", userError);
          if (!userData.user || userData.user.id !== session.user.id) {
            throw new AuthStateOperationError("session", new Error("Session user could not be verified"));
          }
          void syncUser(userData.user);
        } else {
          void syncUser(null);
        }
      } catch (error) {
        if (!active || authEventVersion !== initialEventVersion) return;
        setUser(null);
        setProfile(null);
        setError(authStateErrorMessage(error, "session"));
        setLoading(false);
      }
    })();

    return () => {
      active = false;
      requestVersion.current += 1;
      if (deferredAuthSync !== undefined) window.clearTimeout(deferredAuthSync);
      unsubscribe();
    };
  }, [syncUser]);

  const refreshProfile = useCallback(async () => {
    if (!user) return;
    const nextProfile = await getCurrentProfile(user.id);
    setProfile(nextProfile);
  }, [user]);

  const signOut = useCallback(async () => {
    setError(null);
    try {
      await signOutCurrentSession();
      await syncUser(null);
    } catch {
      setError("退出登录失败，请稍后重试。");
      throw new Error("Sign out failed");
    }
  }, [syncUser]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    profile,
    displayName: profile?.display_name.trim() || user?.email || "用户",
    loading,
    error,
    refreshProfile,
    signOut,
    clearError: () => setError(null),
  }), [error, loading, profile, refreshProfile, signOut, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
