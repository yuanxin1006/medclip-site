import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const baseUrl = process.env.MEDCLIP_BASE_URL ?? "http://127.0.0.1:3100";
const audioPath = process.env.MEDCLIP_TEST_AUDIO;
const expectedText = "定期监测血压，有助于了解心血管健康。高血压患者应该按时服药，并遵循医生建议。";

assert.ok(audioPath, "MEDCLIP_TEST_AUDIO must point to a real speech audio file");

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const consoleMessages = [];
const failedRequests = [];

page.on("console", (message) => {
  consoleMessages.push(`${message.type()}: ${message.text()}`);
});
page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${error.message}`));
page.on("requestfailed", (request) => {
  failedRequests.push(`${request.url()} :: ${request.failure()?.errorText ?? "failed"}`);
});

function normalizeForCer(value) {
  return value.replace(/[\s，。！？、,.!?;；:：]/g, "");
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

async function waitForRecognition() {
  await page.waitForFunction(() => {
    const card = document.querySelector(".recognition-card");
    return Boolean(card?.textContent?.match(/已生成 [1-9]\d* 句同步字幕/))
      || Boolean(card?.textContent?.includes("音频识别失败"));
  }, undefined, { timeout: 360_000 });
  await page.waitForTimeout(500);
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: "medclip-asr-zh.wav",
    mimeType: "audio/wav",
    buffer: await readFile(audioPath)
  });
  console.log(await page.locator('input[type="file"][accept="audio/*"]').evaluate((input) => ({
    count: input.files?.length,
    name: input.files?.[0]?.name,
    type: input.files?.[0]?.type,
    size: input.files?.[0]?.size
  })));
  await page.getByText(/1 段音频已就绪/).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "立即识别" }).click();
  await waitForRecognition();

  const recognitionText = await page.locator(".recognition-card").innerText();
  const cueCount = await page.locator(".subtitle-editor-row").count();
  const cueTexts = await page.locator(".subtitle-editor-row textarea").evaluateAll(
    (elements) => elements.map((element) => element.value)
  );
  const cueTimes = await page.locator(".subtitle-editor-row i").allTextContents();
  const firstPassCaptions = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("medclip-editor-draft-v1")).captions
  );
  // First-release recognition returns complete Whisper sentence segments,
  // rather than word chunks. Keep this fixture locked to that behavior.
  const expectedFirstReleaseSegments = [
    { startMs: 160, endMs: 4_700 },
    { startMs: 4_700, endMs: 9_900 }
  ];
  const syncErrors = firstPassCaptions.map((caption, index) => ({
    index,
    startErrorMs: Math.abs(caption.startMs - expectedFirstReleaseSegments[index].startMs),
    endErrorMs: Math.abs(caption.endMs - expectedFirstReleaseSegments[index].endMs)
  }));
  const firstReleaseChecks = syncErrors;
  const asrText = cueTexts.join("");
  const normalizedExpected = normalizeForCer(expectedText);
  const normalizedAsr = normalizeForCer(asrText);
  const asrCer = editDistance(normalizedExpected, normalizedAsr) / normalizedExpected.length;

  await page.locator(".transcription-advanced summary").click();
  await page.getByRole("button", { name: "重新识别" }).click();
  await page.locator(".transcription-stages span.current")
    .filter({ hasText: /正在识别|正在加载模型|正在准备音频/ })
    .waitFor();
  await waitForRecognition();
  const retryCueCount = await page.locator(".subtitle-editor-row").count();

  await page.getByLabel("已有原始文稿").fill(expectedText);
  await page.getByLabel("医学术语表").fill("高血压，心血管，阿司匹林，BRCA1，HER2");
  await page.getByRole("button", { name: "立即识别" }).click();
  await waitForRecognition();
  const alignedTexts = await page.locator(".subtitle-editor-row textarea").evaluateAll(
    (elements) => elements.map((element) => element.value)
  );
  const alignedText = alignedTexts.join("");
  const alignedCer = editDistance(
    normalizedExpected,
    normalizeForCer(alignedText)
  ) / normalizedExpected.length;
  await mkdir("test-artifacts", { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: "test-artifacts/asr-success.png"
  });

  const audioSection = page.locator(".audio-selection-field");
  await audioSection.getByRole("button", { name: "选择指定区间" }).click();
  const rangeInputs = audioSection.locator(".audio-time-inputs input");
  await rangeInputs.nth(0).fill("00:05.000");
  await rangeInputs.nth(1).fill("00:10.300");
  const secondSentence = "高血压患者应该按时服药，并遵循医生建议。";
  await page.getByLabel("已有原始文稿").fill(secondSentence);
  await page.getByRole("button", { name: "立即识别" }).click();
  await waitForRecognition();
  const rangeCaptions = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("medclip-editor-draft-v1")).captions
  );
  assert.ok(rangeCaptions.length > 0);
  assert.equal(rangeCaptions.map((caption) => caption.text).join(""), secondSentence);
  assert.ok(rangeCaptions[0].startMs <= 500);
  assert.ok(rangeCaptions.every((caption) => caption.endMs <= 5_300));

  await audioSection.getByRole("button", { name: "使用完整音频" }).click();
  await page.getByLabel("已有原始文稿").fill(expectedText);
  await page.getByRole("button", { name: "立即识别" }).click();
  await waitForRecognition();
  await page.waitForTimeout(500);
  const storedProject = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("medclip-editor-draft-v1"))
  );

  console.log(JSON.stringify({
    recognitionText,
    cueCount,
    cueTexts,
    cueTimes,
    firstPassCaptions,
    syncErrors,
    firstReleaseChecks,
    asrCer,
    retryCueCount,
    alignedText,
    alignedCer,
    rangeCaptionCount: rangeCaptions.length,
    rangeStartMs: rangeCaptions[0]?.startMs,
    rangeEndMs: rangeCaptions.at(-1)?.endMs,
    storedCaptionCount: storedProject?.captions?.length ?? 0,
    storedSchemaVersion: storedProject?.schemaVersion,
    consoleMessages,
    failedRequests
  }, null, 2));

  assert.ok(cueCount > 0, `expected recognized subtitles, got ${cueCount}`);
  assert.match(recognitionText, /已生成 [1-9]\d* 句同步字幕/);
  assert.match(cueTexts.join(""), /血压|血壓/);
  assert.ok(cueTimes.every((value) => !value.endsWith("→ 00:00.000")));
  assert.equal(firstPassCaptions.length, expectedFirstReleaseSegments.length);
  assert.ok(firstReleaseChecks.every((check) =>
    check.startErrorMs <= 200 && check.endErrorMs <= 200
  ), `first-release segment timing changed: ${JSON.stringify(firstReleaseChecks)}`);
  assert.ok(retryCueCount > 0, "retry must execute recognition and keep non-empty captions");
  assert.equal(alignedText, expectedText);
  assert.equal(alignedCer, 0);
  assert.equal(storedProject.schemaVersion, 2);
  assert.ok(storedProject.captions.length > 0);
  assert.ok(storedProject.captions.every((caption) =>
    Number.isInteger(caption.startMs) && Number.isInteger(caption.endMs)
  ));

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".timeline-editor-shell").waitFor();
  assert.equal(
    await page.locator(".timeline-caption").count(),
    storedProject.captions.length
  );
  assert.match(await page.locator(".timeline-caption").first().innerText(), /定期监测血压/);
} catch (error) {
  await mkdir("test-artifacts", { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: "test-artifacts/asr-smoke-failed.png"
  });
  console.error(JSON.stringify({
    pageText: (await page.locator("body").innerText()).slice(0, 5_000),
    consoleMessages,
    failedRequests
  }, null, 2));
  throw error;
} finally {
  await browser.close();
}
