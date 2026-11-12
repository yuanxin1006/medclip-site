"use client";

import Link from "next/link";
import { useAuth } from "../components/auth/AuthProvider";
import AnonymousLandingGate from "../components/platform/AnonymousLandingGate";
import styles from "./page.module.css";

export default function PlatformHome() {
  const { user, loading } = useAuth();
  const waveformBars = [34, 55, 42, 76, 48, 88, 57, 72, 41, 64, 91, 52, 70, 39, 61, 82, 47, 68, 43, 57, 77, 49, 65, 37];

  if (loading) {
    return <main className={`${styles.page} ${styles.entryPage}`}>
      <section aria-live="polite" className={styles.entryCard}>正在恢复登录状态…</section>
    </main>;
  }

  if (!user) {
    return <main className={`${styles.page} ${styles.entryPage}`}>
      <div className={styles.entryCard}><AnonymousLandingGate /></div>
    </main>;
  }

  return <main className={styles.page}>
    <section aria-labelledby="home-title" className={styles.hero}>
      <div className={styles.heroCopy}>
        <h1 id="home-title">把每一个灵感，变成值得珍藏的作品。</h1>
        
        <div className={styles.heroActions}>
          <Link className={`${styles.button} ${styles.primaryButton}`} href="/editor">开始视频剪辑 <span aria-hidden="true" className={styles.buttonArrow}>↗</span></Link>
          <Link className={`${styles.button} ${styles.secondaryButton}`} href="/music">浏览音乐作品 <span aria-hidden="true" className={styles.buttonArrow}>↗</span></Link>
        </div>
      </div>

      <div aria-hidden="true" className={styles.heroVisual}>
        <div className={styles.visualHalo} />
        
        
        <div className={styles.productCard}>
          <div className={styles.productTopbar}>
            <div className={styles.productBrand}><span>M</span><strong>MedClip Studio</strong></div>
          </div>
          <div className={styles.productContent}>
            <div className={styles.albumArtwork}>
              <span className={styles.albumSun} />
              <span className={styles.albumDisc} />
              <span className={styles.albumLine} />
            </div>
            <div className={styles.albumCopy}>
              <strong>沿着晨光</strong>
              
              <div className={styles.albumTags}><i>氛围</i><i>器乐</i></div>
            </div>
          </div>
          <div className={styles.timeline}>
            <div className={styles.timelineRow}><span>音频</span><div className={styles.waveform}>{waveformBars.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div></div>
            <div className={styles.timelineRow}><span>画面</span><div className={styles.videoSegments}><i /><i /><i /></div></div>
            <div className={styles.timelineRow}><span>文字</span><div className={styles.textSegments}><i /><i /></div></div>
          </div>
          <div className={styles.productFooter}><span /> 作品概念预览 </div>
        </div>
      </div>
    </section>

    <section aria-labelledby="features-title" className={styles.features}>
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="features-title">让灵感有不同的<br className={styles.mobileBreak} />开始方式。</h2>
        </div>
      </div>

      <div className={styles.featureGrid}>
        <Link className={styles.featureCard} href="/music">
          <div className={styles.featureMeta}><span>01</span><span aria-hidden="true" className={styles.cardArrow}>↗</span></div>
          <div aria-hidden="true" className={`${styles.featureArtwork} ${styles.musicArtwork}`}>
            <span className={styles.musicArtworkSun} /><span className={styles.musicArtworkDisc} /><span className={styles.musicArtworkMark}>♫</span>
          </div>
          <div className={styles.featureCopy}><h3>音乐作品</h3><span className={styles.featureLink}>进入作品空间 <i aria-hidden="true">↗</i></span></div>
        </Link>

        <Link className={styles.featureCard} href="/create-music">
          <div className={styles.featureMeta}><span>02</span><span aria-hidden="true" className={styles.cardArrow}>↗</span></div>
          <div aria-hidden="true" className={`${styles.featureArtwork} ${styles.aiArtwork}`}>
            <div className={styles.promptSheet}><strong>给一个雨天，写一段温柔的旋律</strong><span className={styles.promptRule} /><div className={styles.promptTags}><i>柔和</i><i>钢琴</i><i>慢速</i></div></div><span className={styles.aiSpark}>✳</span>
          </div>
          <div className={styles.featureCopy}><h3>AI 歌曲生成</h3><span className={styles.featureLink}>开始歌曲构思 <i aria-hidden="true">↗</i></span></div>
        </Link>

        <Link className={styles.featureCard} href="/editor">
          <div className={styles.featureMeta}><span>03</span><span aria-hidden="true" className={styles.cardArrow}>↗</span></div>
          <div aria-hidden="true" className={`${styles.featureArtwork} ${styles.videoArtwork}`}>
            <div className={styles.videoFrame}><span className={styles.videoFrameSun} /><span className={styles.videoFrameHorizon} /></div><div className={styles.videoTracks}><span className={styles.trackLabel}>视频</span><span className={styles.videoTrackOne} /><span className={styles.videoTrackTwo} /><span className={styles.trackLabel}>音频</span><span className={styles.audioTrack} /></div>
          </div>
          <div className={styles.featureCopy}><h3>视频剪辑</h3><span className={styles.featureLink}>打开剪辑工作台 <i aria-hidden="true">↗</i></span></div>
        </Link>
      </div>
    </section>


    <section aria-labelledby="cta-title" className={styles.ctaSection}>
      <div aria-hidden="true" className={styles.ctaGlow} />
      <div className={styles.ctaCopy}>
        <h2 id="cta-title">给下一段灵感，<br />一个开始。</h2>
        
      </div>
      <div className={styles.ctaActions}>
        <Link className={`${styles.button} ${styles.ctaPrimaryButton}`} href="/editor">进入视频剪辑 <span aria-hidden="true" className={styles.buttonArrow}>↗</span></Link>
        <Link className={`${styles.button} ${styles.ctaSecondaryButton}`} href="/create-music">探索歌曲创作 <span aria-hidden="true" className={styles.buttonArrow}>↗</span></Link>
      </div>
    </section>

    <footer className={styles.footer}>
      <Link href="/"><span>M</span> MedClip Studio</Link>
      
    </footer>
  </main>;
}
