import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const baseUrl = process.env.MEDCLIP_BASE_URL ?? "http://localhost:3100";
const label = process.env.MEDCLIP_PERF_LABEL ?? "current";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

async function measureScroll(targetSelector, axis, durationMs = 3600) {
  return page.evaluate(async ({ targetSelector, axis, durationMs }) => {
    const root = targetSelector
      ? document.querySelector(targetSelector)
      : document.scrollingElement;
    if (!root) throw new Error(`Missing scroll target: ${targetSelector}`);
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    try {
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long Tasks API is not available in every browser build.
    }
    const frameDeltas = [];
    const max = axis === "x"
      ? root.scrollWidth - root.clientWidth
      : root.scrollHeight - root.clientHeight;
    const start = performance.now();
    let previous = start;
    await new Promise((resolve) => {
      const frame = (now) => {
        frameDeltas.push(now - previous);
        previous = now;
        const progress = Math.min(1, (now - start) / durationMs);
        if (axis === "x") root.scrollLeft = max * progress;
        else root.scrollTop = max * progress;
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    observer.disconnect();
    frameDeltas.sort((left, right) => left - right);
    const percentile = (value) =>
      frameDeltas[Math.min(frameDeltas.length - 1, Math.floor(frameDeltas.length * value))] ?? 0;
    return {
      frameCount: frameDeltas.length,
      fps: frameDeltas.length / (durationMs / 1000),
      averageFrameMs: frameDeltas.reduce((sum, value) => sum + value, 0) / frameDeltas.length,
      p95FrameMs: percentile(0.95),
      maxFrameMs: frameDeltas.at(-1) ?? 0,
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((sum, value) => sum + value, 0),
      maxScroll: max
    };
  }, { targetSelector, axis, durationMs });
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "医学科普剪辑台" }).waitFor();
  await page.waitForTimeout(750);
  await page.getByRole("button", { name: "载入演示" }).click();
  await page.getByText("已载入演示素材", { exact: true }).waitFor();
  const pageMetrics = await measureScroll(null, "y");
  const pageDom = await page.evaluate(() => ({
    elements: document.querySelectorAll("*").length,
    runningAnimations: document.getAnimations().filter(
      (animation) => animation.playState === "running"
    ).length,
    scrollHeight: document.documentElement.scrollHeight,
    mediaElements: document.querySelectorAll("audio,video").length
  }));

  const captions = Array.from({ length: 600 }, (_, index) => ({
    id: `caption-${index}`,
    text: `性能测试字幕 ${index + 1}`,
    startMs: index * 500,
    endMs: index * 500 + 460
  }));
  const project = {
    schemaVersion: 2,
    id: "performance-project",
    title: "性能测试工程",
    updatedAt: new Date().toISOString(),
    durationMs: 300_000,
    ratio: "9:16",
    audioSelection: {
      mode: "full",
      sourceDurationMs: 300_000,
      sourceInMs: 0,
      sourceOutMs: 300_000,
      selectedDurationMs: 300_000
    },
    assets: [
      { id: "asset-video", name: "长视频.mp4", kind: "视频", durationMs: 300_000 }
    ],
    tracks: [
      { id: "audio-main", type: "audio", name: "主音频", clips: [], locked: true },
      {
        id: "video-main",
        type: "video",
        name: "主视频",
        clips: [{
          id: "clip-1",
          assetId: "asset-video",
          name: "长视频.mp4",
          kind: "视频",
          trackId: "video-main",
          timelineStartMs: 0,
          timelineEndMs: 300_000,
          sourceInMs: 0,
          sourceOutMs: 300_000,
          transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
          speedCurve: [
            { id: "speed-start", at: 0, rate: 1 },
            { id: "speed-end", at: 1, rate: 1 }
          ],
          reason: "性能测试"
        }]
      },
      { id: "broll", type: "broll", name: "B-roll", clips: [] },
      { id: "captions", type: "captions", name: "字幕", clips: [] }
    ],
    captions
  };
  await page.evaluate((value) => {
    localStorage.setItem("medclip-editor-draft-v1", JSON.stringify(value));
  }, project);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".timeline-editor-shell").waitFor();
  const timelineMetrics = await measureScroll(".timeline-scroll", "x");
  const timelineDom = await page.evaluate(() => ({
    elements: document.querySelectorAll("*").length,
    renderedCaptions: document.querySelectorAll(".timeline-caption").length,
    runningAnimations: document.getAnimations().filter(
      (animation) => animation.playState === "running"
    ).length,
    mediaElements: document.querySelectorAll("audio,video").length
  }));

  const result = {
    label,
    page: { ...pageMetrics, ...pageDom },
    timeline: { ...timelineMetrics, ...timelineDom }
  };
  assert.ok(result.page.frameCount > 0);
  assert.ok(result.timeline.frameCount > 0);
  await mkdir("test-artifacts", { recursive: true });
  await writeFile(
    `test-artifacts/performance-${label}.json`,
    JSON.stringify(result, null, 2),
    "utf8"
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
