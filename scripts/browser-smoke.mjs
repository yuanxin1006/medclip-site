import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const baseUrl = process.env.MEDCLIP_BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "医学科普剪辑台" }).waitFor();
  await page.waitForTimeout(750);
  await page.getByRole("button", { name: "载入演示" }).click();
  await page.getByText("已载入演示素材", { exact: true }).waitFor();

  const audioSection = page.locator(".audio-selection-field");
  await audioSection.getByText("使用音频区间", { exact: true }).waitFor();
  await assert.doesNotReject(() => audioSection.getByText("01:25.000", { exact: true }).first().waitFor());
  assert.match(await audioSection.locator(".audio-selection-mode button.selected").innerText(), /使用完整音频/);

  await audioSection.getByRole("button", { name: "选择指定区间" }).click();
  const timeInputs = audioSection.locator(".audio-time-inputs input");
  await timeInputs.nth(0).fill("00:10.000");
  await timeInputs.nth(1).fill("00:40.000");
  await assert.doesNotReject(() => audioSection.getByText("00:30.000", { exact: true }).last().waitFor());

  await page.getByRole("button", { name: /自定义长度/ }).click();
  const durationRange = page.getByLabel("目标成片长度");
  await durationRange.fill("20");
  await audioSection.getByText("视频长度短于所选音频区间", { exact: true }).waitFor();
  assert.equal(await page.locator(".mismatch-confirm input").isChecked(), false);
  await page.locator(".mismatch-confirm input").check();
  await audioSection.getByRole("button", { name: "让视频长度匹配音频区间" }).click();
  await audioSection.getByText("视频长度与音频区间匹配", { exact: true }).waitFor();
  await mkdir("test-artifacts", { recursive: true });
  await audioSection.screenshot({ path: "test-artifacts/audio-selection.png" });

  const restoredProject = {
    schemaVersion: 1,
    id: "browser-smoke-project",
    title: "浏览器验收工程",
    updatedAt: new Date().toISOString(),
    durationMs: 8000,
    ratio: "9:16",
    audioSelection: {
      mode: "range",
      sourceDurationMs: 85000,
      sourceInMs: 10000,
      sourceOutMs: 40000,
      selectedDurationMs: 30000
    },
    assets: [
      { id: "demo-1", name: "医生问诊.mp4", kind: "视频", durationMs: 22000 }
    ],
    tracks: [
      { id: "audio-main", type: "audio", name: "主音频", clips: [], locked: true },
      {
        id: "video-main",
        type: "video",
        name: "主视频",
        clips: [{
          id: "clip-1",
          assetId: "demo-1",
          name: "医生问诊.mp4",
          kind: "视频",
          trackId: "video-main",
          timelineStartMs: 0,
          timelineEndMs: 8000,
          sourceInMs: 0,
          sourceOutMs: 8000,
          transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
          speedCurve: [
            { id: "speed-start", at: 0, rate: 1 },
            { id: "speed-end", at: 1, rate: 1 }
          ],
          reason: "浏览器验收片段"
        }]
      },
      { id: "broll", type: "broll", name: "B-roll", clips: [] },
      { id: "captions", type: "captions", name: "字幕", clips: [] }
    ],
    captions: [
      { id: "caption-1", start: 0.4, end: 3.2, text: "这是第一句医学科普字幕。" },
      { id: "caption-2", start: 3.4, end: 7.2, text: "字幕时间可以拖动和修改。" }
    ]
  };
  await page.evaluate((value) => {
    localStorage.setItem("medclip-editor-draft-v1", JSON.stringify(value));
  }, restoredProject);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "医学科普剪辑台" }).waitFor();
  assert.equal(await page.locator(".timeline-editor-shell").count(), 0);
  await page.getByRole("button", { name: /继续精剪/ }).first().click();
  await page.locator(".timeline-editor-shell").waitFor();

  const labels = await page.locator(".timeline-labels > div").allTextContents();
  assert.ok(labels.includes("保护区"), "the editor timeline must expose its protection lane");
  assert.ok(labels.includes("🎙 主音频") && labels.includes("🎬 主视频") && labels.includes("▧ B-roll") && labels.includes("CC 字幕"));
  await page.locator(".timeline-clip").first().click();
  await page.getByText("任意速度曲线", { exact: true }).waitFor();
  await page.locator(".speed-presets").getByRole("button", { name: "渐快" }).click();
  await page.getByText(/平均 1\./).waitFor();

  await page.locator(".timeline-caption").first().click();
  const captionEditor = page.locator(".editor-properties textarea");
  await captionEditor.fill("这是已在生成后编辑器中校正的字幕。");
  await page.getByRole("button", { name: "播放头定位到字幕" }).click();
  assert.match(await page.locator(".editor-player-controls span").innerText(), /00:00\.400/);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("medclip-editor-draft-v1")));
  assert.equal(stored.captions[0].text, "这是已在生成后编辑器中校正的字幕。");
  assert.ok(stored.tracks[1].clips[0].speedCurve.some((point) => point.rate > 1));

  await page.locator(".timeline-editor-shell").screenshot({
    path: "test-artifacts/timeline-editor.png"
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "医学科普剪辑台" }).waitFor();
  assert.equal(await page.locator(".timeline-editor-shell").count(), 0);
  await page.getByRole("button", { name: /继续精剪/ }).first().click();
  await page.locator(".timeline-editor-shell").waitFor();
  await page.locator(".timeline-caption", { hasText: "这是已在生成后编辑器中校正的字幕。" }).waitFor();

  const relevantErrors = consoleErrors.filter((message) =>
    !message.includes("favicon") && !message.includes("Failed to load resource")
  );
  assert.deepEqual(relevantErrors, []);
  console.log(JSON.stringify({
    audioSelection: "passed",
    durationLinking: "passed",
    editorTracks: "passed",
    advancedSpeed: "passed",
    subtitleEditing: "passed",
    draftRestore: "passed",
    consoleErrors: relevantErrors.length
  }, null, 2));
} finally {
  await browser.close();
}
