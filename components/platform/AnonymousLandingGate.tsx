import Link from "next/link";

export default function AnonymousLandingGate() {
  return <section className="ai-services-gate anonymous-landing-gate">
    <p className="platform-kicker">Medclip</p>
    <h1>医剪</h1>
    <p>医韵和声</p>
    <Link className="platform-primary-button" href="/auth">登录 / 注册</Link>
  </section>;
}
