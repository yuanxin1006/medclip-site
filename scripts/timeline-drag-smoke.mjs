import assert from "node:assert/strict";
import { chromium } from "file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const baseUrl = process.env.MEDCLIP_BASE_URL ?? "http://localhost:3200";
const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

const project = {
  schemaVersion: 2,
  id: "timeline-drag-smoke",
  title: "时间轴拖动验收",
  updatedAt: new Date().toISOString(),
  durationMs: 12_000,
  ratio: "9:16",
  audioSelection: {
    mode: "full",
    sourceDurationMs: 12_000,
    sourceInMs: 0,
    sourceOutMs: 12_000,
    selectedDurationMs: 12_000
  },
  assets: [
    { id: "asset-a", name: "片段 A.mp4", kind: "视频", durationMs: 8_000 },
    { id: "asset-b", name: "片段 B.mp4", kind: "视频", durationMs: 8_000 }
  ],
  tracks: [
    { id: "audio", type: "audio", name: "主音频", clips: [], locked: true },
    {
      id: "video",
      type: "video",
      name: "主视频",
      clips: [
        {
          id: "clip-a",
          assetId: "asset-a",
          name: "片段 A.mp4",
          kind: "视频",
          trackId: "video",
          timelineStartMs: 0,
          timelineEndMs: 4_000,
          sourceInMs: 0,
          sourceOutMs: 4_000,
          transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
          speedCurve: [{ id: "a-start", at: 0, rate: 1 }, { id: "a-end", at: 1, rate: 1 }]
        },
        {
          id: "clip-b",
          assetId: "asset-b",
          name: "片段 B.mp4",
          kind: "视频",
          trackId: "video",
          timelineStartMs: 6_000,
          timelineEndMs: 10_000,
          sourceInMs: 0,
          sourceOutMs: 4_000,
          transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
          speedCurve: [{ id: "b-start", at: 0, rate: 1 }, { id: "b-end", at: 1, rate: 1 }]
        }
      ]
    },
    { id: "broll", type: "broll", name: "B-roll", clips: [] },
    { id: "captions", type: "captions", name: "字幕", clips: [] }
  ],
  captions: [
    { id: "caption-a", text: "第一句字幕", startMs: 500, endMs: 2_500 },
    { id: "caption-b", text: "第二句字幕", startMs: 6_500, endMs: 8_500 }
  ]
};

const readClip = (id) => page.evaluate((clipId) => {
  const stored = JSON.parse(localStorage.getItem("medclip-editor-draft-v1"));
  return stored.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);
}, id);

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((value) => {
    localStorage.setItem("medclip-editor-draft-v1", JSON.stringify(value));
  }, project);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".timeline-editor-shell").waitFor();

  const content = page.locator(".timeline-content");
  const contentBox = await content.boundingBox();
  assert.ok(contentBox, "timeline content must be visible");

  // 点击或拖动轨道空白处即可直接定位播放头。
  await page.mouse.click(contentBox.x + 5 * 76, contentBox.y + 14);
  await page.waitForTimeout(50);
  const playhead = page.getByRole("slider", { name: "移动播放头" });
  assert.ok(Math.abs(Number(await playhead.getAttribute("aria-valuenow")) - 5_000) <= 100);

  const firstClip = page.locator(".timeline-clip").first();
  const firstBox = await firstClip.boundingBox();
  assert.ok(firstBox, "first clip must be visible");
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBox.x + firstBox.width / 2 + 76, firstBox.y + firstBox.height / 2, { steps: 8 });
  await page.waitForTimeout(80);
  const duringMove = await readClip("clip-a");
  assert.equal(duringMove.timelineStartMs, 0, "project data must not be committed during pointermove");
  await page.locator(".timeline-drag-tooltip").waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem("medclip-editor-draft-v1"));
    return stored.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "clip-a")?.timelineStartMs === 1_000;
  });
  const movedClip = await readClip("clip-a");
  assert.equal(movedClip.timelineEndMs - movedClip.timelineStartMs, 4_000, "moving a clip must preserve duration");

  // 结束手柄吸附到第二段素材的 6 秒边界。
  const endHandle = firstClip.getByRole("button", { name: "调整片段结束" });
  const endBox = await endHandle.boundingBox();
  assert.ok(endBox, "end trim handle must be visible");
  assert.ok(endBox.width >= 20, "trim handle hit target must be at least 20px");
  await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(endBox.x + endBox.width / 2 + 76, endBox.y + endBox.height / 2, { steps: 8 });
  await page.locator(".timeline-drag-tooltip", { hasText: "自动变速 0.80×" }).waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem("medclip-editor-draft-v1"));
    return stored.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "clip-a")?.timelineEndMs === 6_000;
  });

  // 开始手柄可独立修改入点，仍保留 0.1 秒时间精度。
  const startHandle = firstClip.getByRole("button", { name: "调整片段开始" });
  const startBox = await startHandle.boundingBox();
  assert.ok(startBox, "start trim handle must be visible");
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(startBox.x + startBox.width / 2 + 38, startBox.y + startBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem("medclip-editor-draft-v1"));
    return stored.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "clip-a")?.timelineStartMs === 1_500;
  });

  const playheadBox = await playhead.boundingBox();
  assert.ok(playheadBox && playheadBox.width >= 24, "playhead hit target must be at least 24px");
  assert.equal(await firstClip.evaluate((element) => getComputedStyle(element).touchAction), "none");
  assert.equal(await startHandle.evaluate((element) => getComputedStyle(element).touchAction), "none");

  // Pointer Events 同一路径覆盖触摸屏拖动，不另建第二套时间轴状态。
  await page.evaluate(() => {
    const content = document.querySelector(".timeline-content");
    const rect = content.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 2.2 * 76,
      clientY: rect.top + 14,
      pointerId: 42,
      pointerType: "touch",
      isPrimary: true
    };
    content.dispatchEvent(new PointerEvent("pointerdown", options));
    window.dispatchEvent(new PointerEvent("pointermove", options));
    window.dispatchEvent(new PointerEvent("pointerup", options));
  });
  await page.waitForTimeout(50);
  assert.ok(Math.abs(Number(await playhead.getAttribute("aria-valuenow")) - 2_200) <= 100);

  const finalClip = await readClip("clip-a");
  assert.deepEqual(
    {
      timelineStartMs: finalClip.timelineStartMs,
      timelineEndMs: finalClip.timelineEndMs,
      sourceInMs: finalClip.sourceInMs,
      sourceOutMs: finalClip.sourceOutMs
    },
    { timelineStartMs: 1_500, timelineEndMs: 6_000, sourceInMs: 0, sourceOutMs: 4_000 }
  );
  assert.ok(Math.abs(finalClip.speedCurve[0].rate - (4_000 / 4_500)) < 0.0001);

  const relevantErrors = errors.filter((message) =>
    !message.includes("favicon") && !message.includes("Failed to load resource")
  );
  assert.deepEqual(relevantErrors, []);
  console.log(JSON.stringify({
    playheadDrag: "passed",
    moveRangePreservesDuration: "passed",
    trimStartAndEnd: "passed",
    automaticVideoSpeed: "passed",
    snapToBoundary: "passed",
    commitOnPointerUp: "passed",
    mouseAndTouchPointerDrag: "passed",
    finalClip
  }, null, 2));
} finally {
  await browser.close();
}
