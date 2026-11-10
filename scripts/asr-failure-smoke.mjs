import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const baseUrl = process.env.MEDCLIP_BASE_URL ?? "http://127.0.0.1:3100";
const audioPath = process.env.MEDCLIP_TEST_AUDIO;

assert.ok(audioPath, "MEDCLIP_TEST_AUDIO must point to a real speech audio file");

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();

await page.route("**/*", async (route) => {
  const url = route.request().url();
  if (/huggingface\.co|hf\.co|cdn-lfs/i.test(url)) {
    await route.abort("failed");
    return;
  }
  await route.continue();
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: "medclip-asr-zh.wav",
    mimeType: "audio/wav",
    buffer: await readFile(audioPath)
  });
  await page.getByText(/1 段音频已就绪/).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "立即识别" }).click();
  await page.locator(".recognition-card.state-error").waitFor({ timeout: 90_000 });

  const failureText = await page.locator(".recognition-card").innerText();
  assert.match(failureText, /音频识别失败/);
  assert.match(failureText, /失败阶段：正在加载模型/);
  assert.match(failureText, /重新识别/);
  assert.doesNotMatch(failureText, /已生成 0 句同步字幕/);

  await mkdir("test-artifacts", { recursive: true });
  await page.locator(".recognition-card").screenshot({
    path: "test-artifacts/asr-failure-state.png"
  });

  console.log(JSON.stringify({ failureText }, null, 2));
} finally {
  await browser.close();
}
