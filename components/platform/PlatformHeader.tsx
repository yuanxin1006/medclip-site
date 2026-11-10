"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import styles from "./PlatformHeader.home.module.css";

const navigationItems = [
  { href: "/music", label: "音乐作品" },
  { href: "/create-music", label: "AI 歌曲生成" },
  { href: "/editor", label: "视频剪辑" },
];

export default function PlatformHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const { user, displayName, loading, signOut, error } = useAuth();
  const isHome = pathname === "/";
  const hideRootNavigation = isHome && loading;
  const anonymousRoot = isHome && !loading && !user;

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      setMenuOpen(false);
    } catch {
      // The provider exposes a compact user-facing error below.
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <>
    <header className={`platform-header ${styles.homeHeader}`}>
      <div className={`platform-header-inner ${styles.homeHeaderInner}`}>
        <Link className={`platform-brand ${styles.homeBrand}`} href="/" onClick={() => setMenuOpen(false)}>
          <span className={`platform-brand-mark ${styles.homeBrandMark}`}>M</span>
          <span>MedClip Studio</span>
        </Link>
        <button
          aria-expanded={menuOpen}
          aria-label="打开导航菜单"
          className={`platform-menu-toggle ${styles.homeMenuToggle}`}
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
        >
          <span /><span /><span />
        </button>
        <nav className={`platform-nav ${menuOpen ? "is-open" : ""} ${styles.homeNav}`} aria-label="主导航">
          {!hideRootNavigation && !anonymousRoot && navigationItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={active ? "is-active" : undefined}
                href={item.href}
                key={item.href}
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </Link>
            );
          })}
          <div className="platform-auth-controls">
            {loading ? (
              <span className="platform-auth-loading">正在检查登录…</span>
            ) : user ? (
              <>
                <Link
                  aria-current={pathname === "/ai-services" ? "page" : undefined}
                  className={pathname === "/ai-services" ? "is-active platform-account-link" : "platform-account-link"}
                  href="/ai-services"
                  onClick={() => setMenuOpen(false)}
                >
                  我的 AI 服务
                </Link>
                <span className="platform-user-name" title={user.email}>{displayName}</span>
                <button disabled={signingOut} onClick={handleSignOut} type="button">
                  {signingOut ? "退出中…" : "退出"}
                </button>
              </>
            ) : (
              <Link
                aria-current={pathname === "/auth" ? "page" : undefined}
                className={pathname === "/auth" ? "is-active" : undefined}
                href="/auth"
                onClick={() => setMenuOpen(false)}
              >
                登录 / 注册
              </Link>
            )}
          </div>
        </nav>
      </div>
    </header>
    {error && <div className={styles.homeAuthStatus} data-auth-state-error role="status">{error}</div>}
    </>
  );
}
