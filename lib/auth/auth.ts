import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import type { Profile } from "../music/types";
import { getSupabaseBrowserClient } from "../supabase/client";

export type SignUpResult = {
  user: User | null;
  session: Session | null;
  confirmationRequired: boolean;
};

export async function signUp(email: string, password: string, displayName?: string): Promise<SignUpResult> {
  const supabase = getSupabaseBrowserClient();
  const cleanDisplayName = displayName?.trim();
  const emailRedirectTo = typeof window === "undefined" ? undefined : `${window.location.origin}/auth`;
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: cleanDisplayName ? { display_name: cleanDisplayName } : {},
      emailRedirectTo,
    },
  });

  if (error) throw error;
  return {
    user: data.user,
    session: data.session,
    confirmationRequired: Boolean(data.user && !data.session),
  };
}

export async function signIn(email: string, password: string): Promise<Session> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  return data.session;
}

export async function signOut(): Promise<void> {
  const { error } = await getSupabaseBrowserClient().auth.signOut({ scope: "local" });
  if (error) throw error;
}

export async function getCurrentUser(): Promise<User | null> {
  const { data, error } = await getSupabaseBrowserClient().auth.getUser();
  if (error) throw error;
  return data.user;
}

export async function getCurrentProfile(userId?: string): Promise<Profile | null> {
  const resolvedUserId = userId ?? (await getCurrentUser())?.id;
  if (!resolvedUserId) return null;

  const { data, error } = await getSupabaseBrowserClient()
    .from("profiles")
    .select("id, display_name, avatar_url, created_at")
    .eq("id", resolvedUserId)
    .maybeSingle();

  if (error) throw error;
  return data as Profile | null;
}

export function subscribeToAuthChanges(
  listener: (event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  const { data } = getSupabaseBrowserClient().auth.onAuthStateChange(listener);
  return () => data.subscription.unsubscribe();
}

export function getAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("invalid login credentials")) return "邮箱或密码不正确。";
  if (message.includes("email not confirmed")) return "请先在邮箱中完成验证。";
  if (message.includes("user already registered")) return "这个邮箱已经注册，请直接登录。";
  if (message.includes("password") && message.includes("characters")) return "密码长度不符合要求。";
  if (message.includes("rate limit")) return "操作过于频繁，请稍后再试。";
  if (message.includes("network") || message.includes("fetch")) return "网络连接失败，请稍后重试。";
  return "认证操作未完成，请检查输入后重试。";
}
