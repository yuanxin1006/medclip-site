import type { Metadata } from "next";
import AuthProvider from "../components/auth/AuthProvider";
import PlatformHeader from "../components/platform/PlatformHeader";
import "./globals.css";
import "./design-tokens.css";
import "./design-system.css";

export const metadata: Metadata = {
  title: "MedClip Studio",
  description: "视频剪辑、音乐作品与 AI 歌曲创作平台。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className="medclip-app"><AuthProvider><PlatformHeader />{children}</AuthProvider></body></html>;
}
