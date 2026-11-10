"use client";

import "./auth.css";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../../components/auth/AuthProvider";
import { getAuthErrorMessage, signIn, signUp } from "../../lib/auth/auth";

type AuthMode = "login" | "register";
const DEFAULT_AUTH_DESTINATION = "/";

export default function AuthPage() {
  const router = useRouter();
  const { user, loading: sessionLoading } = useAuth();
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionLoading && user && !confirmationEmail) router.replace(DEFAULT_AUTH_DESTINATION);
  }, [confirmationEmail, router, sessionLoading, user]);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
    setConfirmationEmail(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "login") {
        await signIn(email, password);
        router.replace(DEFAULT_AUTH_DESTINATION);
      } else {
        const result = await signUp(email, password, displayName);
        if (result.confirmationRequired) setConfirmationEmail(email.trim());
        else router.replace(DEFAULT_AUTH_DESTINATION);
      }
    } catch (authError) {
      setError(getAuthErrorMessage(authError));
    } finally {
      setSubmitting(false);
    }
  };

  if (sessionLoading) {
    return <main className="platform-page auth-page"><section className="auth-card auth-loading">正在恢复登录状态…</section></main>;
  }

  if (confirmationEmail) {
    return <main className="platform-page auth-page"><section className="auth-card auth-confirmation"><span className="auth-success-mark">✓</span><h1>请确认邮箱</h1><p>验证邮件已发送至 <strong>{confirmationEmail}</strong>。完成验证后返回 MedClip 登录。</p><button className="platform-secondary-button" onClick={() => switchMode("login")} type="button">返回登录</button><Link href="/music">先浏览音乐作品</Link></section></main>;
  }

  return <main className="platform-page auth-page"><section className="auth-card"><h1>{mode === "login" ? "欢迎回来" : "创建账号"}</h1><div className="auth-mode-switch" role="tablist" aria-label="登录或注册"><button aria-selected={mode === "login"} className={mode === "login" ? "is-active" : ""} onClick={() => switchMode("login")} role="tab" type="button">登录</button><button aria-selected={mode === "register"} className={mode === "register" ? "is-active" : ""} onClick={() => switchMode("register")} role="tab" type="button">注册</button></div><form className="auth-form" onSubmit={submit}>{mode === "register" && <label>显示名称<input autoComplete="nickname" maxLength={100} onChange={(event) => setDisplayName(event.target.value)} placeholder="你的创作者名称（选填）" value={displayName} /></label>}<label>邮箱<input autoComplete="email" inputMode="email" onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required type="email" value={email} /></label><label>密码<input autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={6} onChange={(event) => setPassword(event.target.value)} placeholder="至少 6 个字符" required type="password" value={password} /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="platform-primary-button auth-submit" disabled={submitting} type="submit">{submitting ? "请稍候…" : mode === "login" ? "登录" : "注册"}</button></form><p className="auth-footnote">{mode === "login" ? "还没有账号？" : "已经有账号？"}<button onClick={() => switchMode(mode === "login" ? "register" : "login")} type="button">{mode === "login" ? "立即注册" : "返回登录"}</button></p></section></main>;
}
