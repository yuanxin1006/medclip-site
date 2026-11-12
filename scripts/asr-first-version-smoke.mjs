import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const baseUrl = process.env.MEDCLIP_BASE_URL ?? "http://127.0.0.1:3106";
const audioPath = process.env.MEDCLIP_TEST_AUDIO;
assert.ok(audioPath, "MEDCLIP_TEST_AUDIO is required");

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
    errors.push(message.text());
  }
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: "medclip-asr-first-version.wav",
    mimeType: "audio/wav",
    buffer: await readFile(audioPath)
  });
  await page.getByText(/1 段音频已就绪/).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "立即识别" }).click();
  await page.waitForFunction(() => {
    const card = document.querySelector(".recognition-card");
    return Boolean(card?.textContent?.match(/已生成 [1-9]\d* 句同步字幕/))
      || Boolean(card?.textContent?.includes("音频识别失败"));
  }, undefined, { timeout: 360_000 });

  const recognitionText = await page.locator(".recognition-card").innerText();
  assert.doesNotMatch(recognitionText, /音频识别失败/);
  assert.match(recognitionText, /已恢复第一版识别文字/);
  const project = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("medclip-editor-draft-v1"))
  );
  const captions = project?.captions ?? [];
  assert.ok(captions.length > 0);
  const text = captions.map((caption) => caption.text).join("");
  assert.match(text, /血压|血壓/);
  assert.ok(captions.every((caption) =>
    Number.isInteger(caption.startMs)
    && Number.isInteger(caption.endMs)
    && caption.endMs > caption.startMs
  ));
  console.log(JSON.stringify({
    captionCount: captions.length,
    text,
    captions,
    errors
  }, null, 2));
} finally {
  await browser.close();
}
