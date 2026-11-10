import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const baseUrl = process.env.MEDCLIP_BASE_URL ?? "http://localhost:3100";
const sourceAudioPath = process.env.MEDCLIP_TEST_AUDIO;
const playbackSeconds = Number(process.env.MEDCLIP_PLAYBACK_SECONDS ?? 60);
assert.ok(sourceAudioPath, "MEDCLIP_TEST_AUDIO must point to a real speech WAV file");

function repeatWave(source, durationSeconds) {
  const dataChunk = source.indexOf(Buffer.from("data"));
  assert.ok(dataChunk >= 0, "WAV data chunk is missing");
  const dataStart = dataChunk + 8;
  const sampleData = source.subarray(dataStart);
  const bytesPerSecond = source.readUInt32LE(28);
  const blockAlign = source.readUInt16LE(32);
  const targetLength = Math.floor(durationSeconds * bytesPerSecond / blockAlign) * blockAlign;
  const output = Buffer.alloc(dataStart + targetLength);
  source.copy(output, 0, 0, dataStart);
  for (let offset = 0; offset < targetLength; offset += sampleData.length) {
    sampleData.copy(output, dataStart + offset, 0, Math.min(sampleData.length, targetLength - offset));
  }
  output.writeUInt32LE(output.length - 8, 4);
  output.writeUInt32LE(targetLength, dataChunk + 4);
  return output;
}

async function makeVisualFixtures(browser) {
  const fixturePage = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  const fixture = await fixturePage.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1920;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");

    const draw = (progress) => {
      const gradient = context.createLinearGradient(0, 0, 1080, 1920);
      gradient.addColorStop(0, "#063d49");
      gradient.addColorStop(1, "#0e8178");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 1080, 1920);
      context.strokeStyle = "rgba(255,255,255,.22)";
      context.lineWidth = 4;
      for (let y = 0; y <= 1920; y += 120) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(1080, y);
        context.stroke();
      }
      context.fillStyle = "#ffffff";
      context.font = "700 74px sans-serif";
      context.textAlign = "center";
      context.fillText("医学科普清晰度测试", 540, 420);
      context.font = "500 42px sans-serif";
      context.fillText("1080 × 1920 原始素材", 540, 500);
      context.fillStyle = "#8ff3df";
      context.beginPath();
      context.arc(180 + progress * 720, 960, 105, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "#ffffff";
      context.lineWidth = 18;
      context.strokeRect(160, 1240, 760, 360);
      context.font = "600 50px sans-serif";
      context.fillStyle = "#ffffff";
      context.fillText(`帧 ${String(Math.round(progress * 360)).padStart(3, "0")}`, 540, 1445);
    };

    draw(0);
    const imageUrl = canvas.toDataURL("image/png");
    const stream = canvas.captureStream(30);
    const mimeType = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm"
    ].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
    const recorder = new MediaRecorder(stream, mimeType
      ? { mimeType, videoBitsPerSecond: 6_000_000 }
      : { videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const finished = new Promise((resolve, reject) => {
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType || "video/webm" });
        const reader = new FileReader();
        reader.onload = () => resolve({
          video: String(reader.result).split(",")[1],
          image: imageUrl.split(",")[1],
          mimeType: blob.type
        });
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      };
      recorder.onerror = () => reject(recorder.error);
    });
    recorder.start(250);
    const started = performance.now();
    await new Promise((resolve) => {
      const frame = (now) => {
        const elapsed = now - started;
        draw(Math.min(1, elapsed / 12_000));
        if (elapsed < 12_000) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    recorder.stop();
    const result = await finished;
    stream.getTracks().forEach((track) => track.stop());
    return result;
  });
  await fixturePage.close();
  return {
    video: Buffer.from(fixture.video, "base64"),
    image: Buffer.from(fixture.image, "base64"),
    mimeType: fixture.mimeType
  };
}

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
  const sourceAudio = await readFile(sourceAudioPath);
  const longSpeech = repeatWave(sourceAudio, 62);
  const fixtures = await makeVisualFixtures(browser);
  console.log("phase: fixtures ready");
  await page.route(/huggingface\.co|hf\.co|cdn-lfs/, (route) => route.abort());
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "医学科普剪辑台" }).waitFor();
  await page.waitForTimeout(750);

  await page.locator('input[type="file"][accept*="video/mp4"]').setInputFiles([
    {
      name: "vertical-medical-a.webm",
      mimeType: fixtures.mimeType || "video/webm",
      buffer: fixtures.video
    },
    {
      name: "vertical-medical-b.webm",
      mimeType: fixtures.mimeType || "video/webm",
      buffer: fixtures.video
    },
    {
      name: "medical-chart-1080x1920.png",
      mimeType: "image/png",
      buffer: fixtures.image
    }
  ]);
  await page.getByText("vertical-medical-a.webm", { exact: true }).waitFor();
  await page.getByText("vertical-medical-b.webm", { exact: true }).waitFor();

  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: "continuous-chinese-speech-62s.wav",
    mimeType: "audio/wav",
    buffer: longSpeech
  });
  await page.getByText("continuous-chinese-speech-62s.wav", { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const total = document.querySelector(".audio-range-summary b");
    return Boolean(total && total.textContent !== "00:00.000");
  }, undefined, { timeout: 30_000 });

  await page.getByRole("button", { name: /上传同步字幕/ }).click();
  const sentence = "定期监测血压，有助于了解心血管健康。高血压患者应该按时服药，并遵循医生建议。";
  const srt = Array.from({ length: 7 }, (_, index) => {
    const start = index * 9;
    const end = Math.min(62, start + 8.6);
    const time = (seconds) => {
      const whole = Math.floor(seconds);
      const milliseconds = Math.round((seconds - whole) * 1000);
      return `00:${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
    };
    return `${index + 1}\n${time(start)} --> ${time(end)}\n${sentence}`;
  }).join("\n\n");
  await page.getByLabel("字幕文本").fill(srt);
  await page.locator(".consent input").check();
  const generate = page.getByRole("button", { name: /生成剪辑预览/ });
  await page.waitForFunction(() => {
    const button = document.querySelector(".generate-button");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30_000 });
  await generate.click();
  await page.locator(".timeline-editor-shell").waitFor({ timeout: 360_000 });
  console.log("phase: editor ready");
  await page.locator(".editor-library").getByRole("button", { name: /vertical-medical-a/ }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector(".editor-canvas video");
    return Boolean(video && video.videoWidth === 1080 && video.videoHeight === 1920);
  }, undefined, { timeout: 30_000 });
  await page.getByLabel("编辑器播放进度").fill("0");
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return Boolean(audio && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
  }, undefined, { timeout: 30_000 });

  const initialMedia = await page.evaluate(() => ({
    audio: document.querySelectorAll("audio").length,
    video: document.querySelectorAll("video").length,
    editorVideoWidth: document.querySelector(".editor-canvas video")?.videoWidth ?? 0,
    editorVideoHeight: document.querySelector(".editor-canvas video")?.videoHeight ?? 0
  }));
  assert.equal(initialMedia.audio, 1, "preview must use exactly one master audio element");
  assert.equal(initialMedia.video, 1, "editor playback must decode exactly one visible video");
  assert.equal(initialMedia.editorVideoWidth, 1080);
  assert.equal(initialMedia.editorVideoHeight, 1920);

  await page.evaluate(() => {
    const metrics = {
      audioWaiting: 0,
      audioWaitingMs: 0,
      audioWaitingStartedAt: 0,
      audioStalled: 0,
      audioErrors: 0,
      videoWaiting: 0,
      videoStalled: 0,
      addedAudio: 0,
      addedVideo: 0,
      removedAudio: 0,
      removedVideo: 0,
      audioBacktracks: 0,
      audioSamples: 0,
      lastAudioTime: -1
    };
    const bind = (element) => {
      if (element instanceof HTMLAudioElement) {
        element.addEventListener("waiting", () => {
          metrics.audioWaiting += 1;
          if (!metrics.audioWaitingStartedAt) metrics.audioWaitingStartedAt = performance.now();
        });
        element.addEventListener("playing", () => {
          if (!metrics.audioWaitingStartedAt) return;
          metrics.audioWaitingMs += performance.now() - metrics.audioWaitingStartedAt;
          metrics.audioWaitingStartedAt = 0;
        });
        element.addEventListener("stalled", () => metrics.audioStalled += 1);
        element.addEventListener("error", () => metrics.audioErrors += 1);
        element.addEventListener("timeupdate", () => {
          if (metrics.lastAudioTime >= 0 && element.currentTime + 0.05 < metrics.lastAudioTime) {
            metrics.audioBacktracks += 1;
          }
          metrics.lastAudioTime = element.currentTime;
          metrics.audioSamples += 1;
        });
      } else if (element instanceof HTMLVideoElement) {
        element.addEventListener("waiting", () => metrics.videoWaiting += 1);
        element.addEventListener("stalled", () => metrics.videoStalled += 1);
      }
    };
    document.querySelectorAll("audio,video").forEach(bind);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          const elements = [node, ...node.querySelectorAll("audio,video")];
          for (const element of elements) {
            if (element instanceof HTMLAudioElement) metrics.addedAudio += 1;
            if (element instanceof HTMLVideoElement) metrics.addedVideo += 1;
            bind(element);
          }
        });
        record.removedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          const elements = [node, ...node.querySelectorAll("audio,video")];
          for (const element of elements) {
            if (element instanceof HTMLAudioElement) metrics.removedAudio += 1;
            if (element instanceof HTMLVideoElement) metrics.removedVideo += 1;
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__medclipPlaybackMetrics = metrics;
    window.__medclipPlaybackObserver = observer;
  });

  await page.locator(".editor-player-controls button").click();
  await page.waitForFunction((targetMs) => {
    const input = document.querySelector('.editor-player-controls input[type="range"]');
    return input instanceof HTMLInputElement && Number(input.value) >= targetMs;
  }, playbackSeconds * 1000, { timeout: (playbackSeconds + 18) * 1000 });
  console.log(`phase: ${playbackSeconds}-second playback passed`);
  const continuousMetrics = await page.evaluate(() => {
    const metrics = window.__medclipPlaybackMetrics;
    return {
      ...metrics,
      audioWaitingMs: metrics.audioWaitingMs + (
        metrics.audioWaitingStartedAt ? performance.now() - metrics.audioWaitingStartedAt : 0
      )
    };
  });
  assert.ok(continuousMetrics.audioWaiting <= 1);
  assert.ok(continuousMetrics.audioWaitingMs <= 500);
  assert.equal(continuousMetrics.audioStalled, 0);
  assert.equal(continuousMetrics.audioErrors, 0);
  assert.equal(continuousMetrics.audioBacktracks, 0);

  const editorProgress = page.getByLabel("编辑器播放进度");
  if ((await page.locator(".editor-player-controls button").innerText()) === "Ⅱ") {
    await page.locator(".editor-player-controls button").click();
  }
  await editorProgress.fill("30000");
  await page.locator(".editor-player-controls button").click();
  await page.waitForTimeout(2200);
  await page.locator(".editor-player-controls button").click();
  const seekSync = await page.evaluate(() => {
    const audio = document.querySelector("audio");
    const input = document.querySelector('.editor-player-controls input[type="range"]');
    return {
      audioTime: audio?.currentTime ?? -1,
      timelineTime: input instanceof HTMLInputElement ? Number(input.value) / 1000 : -1,
      playbackRate: audio?.playbackRate ?? -1
    };
  });
  assert.ok(Math.abs(seekSync.audioTime - seekSync.timelineTime) <= 0.5);
  assert.equal(seekSync.playbackRate, 1);

  await page.getByRole("button", { name: "关闭编辑器" }).click();
  const audioSection = page.locator(".audio-selection-field");
  await audioSection.getByRole("button", { name: "选择指定区间" }).click();
  const rangeInputs = audioSection.locator(".audio-time-inputs input");
  await rangeInputs.nth(0).fill("00:10.000");
  await rangeInputs.nth(1).fill("00:20.000");
  await audioSection.getByRole("button", { name: /试听所选区间/ }).click();
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return Boolean(audio && audio.currentTime >= 10.6 && !audio.paused);
  });
  await audioSection.getByRole("button", { name: /暂停试听/ }).click();
  await rangeInputs.nth(1).fill("00:16.000");

  await page.locator(".generate-button").click();
  await page.locator(".timeline-editor-shell").waitFor({ timeout: 360_000 });
  await page.locator(".render-button").click();
  await page.locator(".final-output-card.ready").waitFor({ state: "attached", timeout: 90_000 });
  console.log("phase: export ready");
  await page.getByRole("button", { name: "关闭编辑器" }).click();
  const outputVideo = page.locator(".rendered-output video");
  await outputVideo.waitFor();
  await outputVideo.evaluate((video) => {
    if (video.readyState >= 1) return;
    return new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", reject, { once: true });
    });
  });
  const output = await outputVideo.evaluate(async (video) => ({
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    bytes: (await fetch(video.currentSrc).then((response) => response.blob())).size
  }));
  const project = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("medclip-editor-draft-v1"))
  );
  assert.equal(output.width, 1080);
  assert.equal(output.height, 1920);
  assert.ok(output.bytes > 100_000);
  assert.ok(project.captions.length > 0);
  assert.ok(project.captions.every((caption) => caption.startMs >= 0 && caption.endMs <= 6_000));

  await mkdir("test-artifacts", { recursive: true });
  await page.screenshot({ fullPage: true, path: "test-artifacts/playback-export-success.png" });
  const relevantErrors = consoleErrors.filter((message) =>
    !message.includes("favicon") && !message.includes("Failed to load resource")
  );
  assert.deepEqual(relevantErrors, []);
  console.log(JSON.stringify({
    longPlaybackSeconds: playbackSeconds,
    initialMedia,
    continuousMetrics,
    seekSync,
    middleRangePreview: "10.000s–20.000s passed",
    exportedRange: "10.000s–16.000s",
    output,
    outputCaptionCount: project.captions.length,
    consoleErrors: relevantErrors.length
  }, null, 2));
} catch (error) {
  await mkdir("test-artifacts", { recursive: true });
  await page.screenshot({ fullPage: true, path: "test-artifacts/playback-export-failed.png" });
  throw error;
} finally {
  await browser.close();
}
