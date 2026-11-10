import assert from "node:assert/strict";
import test from "node:test";
import { cropAndRebaseCaptions } from "./editor-core.ts";
import {
  TranscriptionFailure,
  applyReferenceTranscript,
  detectSpeechRegions,
  transcriptionOutputToCaptions,
  videoTranscriptionSegments,
  simplifyWhisperCaptions,
  validateCaptionTimeline
} from "./transcription-core.ts";

const ordinaryChinese = {
  text: "定期监测血压有助于了解心血管健康。",
  chunks: [
    { text: "定期", timestamp: [0.2, 0.8] as [number, number] },
    { text: "监测", timestamp: [0.8, 1.3] as [number, number] },
    { text: "血压，", timestamp: [1.3, 2] as [number, number] },
    { text: "有助于", timestamp: [2.25, 3] as [number, number] },
    { text: "了解", timestamp: [3, 3.5] as [number, number] },
    { text: "心血管健康。", timestamp: [3.5, 4.8] as [number, number] }
  ]
};

test("uploaded Chinese speech creates non-empty millisecond captions", () => {
  const captions = transcriptionOutputToCaptions(ordinaryChinese, 5_000);
  assert.ok(captions.length > 0);
  assert.equal(captions.map((caption) => caption.text).join(""), "定期监测血压，有助于了解心血管健康。");
  assert.equal(validateCaptionTimeline(captions, 5_000), true);
  assert.ok(captions.every((caption) =>
    Number.isInteger(caption.startMs) && Number.isInteger(caption.endMs)
  ));
});

test("first-release segment recognition preserves complete phrase text and timestamps", () => {
  const captions = transcriptionOutputToCaptions({
    text: "定期监测血压，有助于了解心血管健康。",
    chunks: [
      {
        text: "定期监测血压，有助于了解心血管健康。",
        timestamp: [0.16, 4.25]
      }
    ]
  }, 4_500);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].text, "定期监测血压，有助于了解心血管健康。");
  assert.equal(captions[0].startMs, 160);
  assert.equal(captions[0].endMs, 4_250);
});

test("TTS audio with a known script preserves the exact source text", () => {
  const recognized = transcriptionOutputToCaptions({
    text: "阿斯匹林用于部分患者。BRCA一基因需要专业解读。",
    chunks: [
      { text: "阿斯匹林", timestamp: [0.1, 1.2] },
      { text: "用于部分患者。", timestamp: [1.2, 2.8] },
      { text: "BRCA一基因", timestamp: [3.2, 4.5] },
      { text: "需要专业解读。", timestamp: [4.5, 6.1] }
    ]
  }, 6_500);
  const reference = "阿司匹林用于部分患者。BRCA1基因需要专业解读。";
  const aligned = applyReferenceTranscript(recognized, reference);
  assert.equal(aligned.map((caption) => caption.text).join(""), reference);
  assert.equal(aligned[0].startMs, recognized[0].startMs);
  assert.equal(aligned.at(-1)?.endMs, recognized.at(-1)?.endMs);
});

test("medical drug, gene and English abbreviations are not split inside a timed word", () => {
  const captions = transcriptionOutputToCaptions({
    text: "HER2阳性患者使用曲妥珠单抗，BRCA1需要检测。",
    chunks: [
      { text: "HER2", timestamp: [0, 0.8] },
      { text: "阳性患者", timestamp: [0.8, 1.6] },
      { text: "使用", timestamp: [1.6, 2] },
      { text: "曲妥珠单抗，", timestamp: [2, 3.2] },
      { text: "BRCA1", timestamp: [3.6, 4.4] },
      { text: "需要检测。", timestamp: [4.4, 5.6] }
    ]
  }, 6_000);
  assert.match(captions.map((caption) => caption.text).join("|"), /HER2/);
  assert.match(captions.map((caption) => caption.text).join("|"), /曲妥珠单抗/);
  assert.match(captions.map((caption) => caption.text).join("|"), /BRCA1/);
});

test("Chinese-English mixed speech keeps chronological non-overlapping captions", () => {
  const captions = transcriptionOutputToCaptions({
    text: "今天讨论 LDL cholesterol。目标低于 1.8 mmol/L。",
    chunks: [
      { text: "今天讨论", timestamp: [0.1, 0.9] },
      { text: " LDL cholesterol。", timestamp: [0.9, 2.1] },
      { text: "目标低于", timestamp: [2.6, 3.4] },
      { text: " 1.8 mmol/L。", timestamp: [3.4, 4.8] }
    ]
  }, 5_000);
  assert.equal(validateCaptionTimeline(captions, 5_000), true);
  assert.match(captions.map((caption) => caption.text).join(""), /LDL cholesterol/);
  assert.match(captions.map((caption) => caption.text).join(""), /1.8 mmol\/L/);
});

test("full audio keeps the original zero-based timestamps", () => {
  const captions = transcriptionOutputToCaptions(ordinaryChinese, 5_000);
  assert.equal(captions[0].startMs, 200);
  assert.equal(captions.at(-1)?.endMs, 4_800);
});

test("audio start, middle and end ranges crop, delete and rebase captions", () => {
  const captions = [
    { id: "a", text: "开头", startMs: 0, endMs: 1_000 },
    { id: "b", text: "中间", startMs: 2_000, endMs: 3_000 },
    { id: "c", text: "结尾", startMs: 4_000, endMs: 5_000 }
  ];
  assert.deepEqual(
    cropAndRebaseCaptions(captions, 0, 1_500).map((item) => item.text),
    ["开头"]
  );
  const middle = cropAndRebaseCaptions(captions, 1_500, 3_500);
  assert.deepEqual(middle.map((item) => item.text), ["中间"]);
  assert.equal(middle[0].startMs, 500);
  const end = cropAndRebaseCaptions(captions, 3_500, 5_000);
  assert.deepEqual(end.map((item) => item.text), ["结尾"]);
  assert.equal(end[0].startMs, 500);
});

test("model text without word timestamps is a format failure, never success with zero captions", () => {
  assert.throws(
    () => transcriptionOutputToCaptions({ text: "有文字但无时间戳" }, 2_000),
    (error) => error instanceof TranscriptionFailure
      && error.code === "result-format"
      && error.stage === "timestamping"
  );
});

test("no speech is reported distinctly from a technical failure", () => {
  assert.throws(
    () => transcriptionOutputToCaptions({ text: "", chunks: [] }, 2_000),
    (error) => error instanceof TranscriptionFailure
      && error.code === "no-speech"
      && error.message === "未检测到可识别语音。"
  );
});

test("missing end timestamps require an acoustic boundary instead of an estimate", () => {
  assert.throws(
    () => transcriptionOutputToCaptions({
      text: "低置信度片段",
      chunks: [
        { text: "低置信度", timestamp: [0.2, null], confidence: 0.5 },
        { text: "片段。", timestamp: [1.2, 2] }
      ]
    }, 2_500),
    (error) => error instanceof TranscriptionFailure
      && error.code === "result-format"
      && error.stage === "timestamping"
  );

  const captions = transcriptionOutputToCaptions({
    text: "低置信度片段",
    chunks: [
      { text: "低置信度", timestamp: [0.2, null], confidence: 0.5 },
      { text: "片段。", timestamp: [1.2, 2] }
    ]
  }, 2_500, [
    { startMs: 180, endMs: 980 },
    { startMs: 1_180, endMs: 2_020 }
  ]);
  assert.equal(captions.length, 2);
  assert.equal(captions[0].endMs, 980);
  assert.equal(captions[0].needsReview, true);
});

test("PCM speech activity finds real phrase edges within 20ms", () => {
  const samples = new Float32Array(16_000 * 4);
  const regions = [[400, 1_200], [1_440, 2_100], [2_800, 3_650]];
  for (const [startMs, endMs] of regions) {
    const start = Math.round(startMs / 1000 * 16_000);
    const end = Math.round(endMs / 1000 * 16_000);
    for (let index = start; index < end; index += 1) {
      samples[index] = Math.sin(index * 0.17) * 0.2;
    }
  }
  const detected = detectSpeechRegions(samples, 16_000);
  assert.equal(detected.length, 3);
  detected.forEach((region, index) => {
    assert.ok(Math.abs(region.startMs - regions[index][0]) <= 20);
    assert.ok(Math.abs(region.endMs - regions[index][1]) <= 20);
  });
});

test("word timestamps snap to nearby acoustic onset and offset within 200ms", () => {
  const captions = transcriptionOutputToCaptions({
    chunks: [
      { text: "实际开始", timestamp: [0.24, 1.15] },
      { text: "第二句。", timestamp: [1.9, 2.65] }
    ]
  }, 3_000, [
    { startMs: 400, endMs: 1_200 },
    { startMs: 2_020, endMs: 2_720 }
  ]);
  assert.deepEqual(
    captions.map((caption) => [caption.startMs, caption.endMs]),
    [[400, 1_200], [2_020, 2_720]]
  );
});

test("fast speech stays continuous when punctuation has no acoustic pause", () => {
  const captions = transcriptionOutputToCaptions({
    chunks: [
      { text: "快速", timestamp: [0.1, 0.45] },
      { text: "说话，", timestamp: [0.45, 0.82] },
      { text: "仍按", timestamp: [0.82, 1.12] },
      { text: "语气结束。", timestamp: [1.12, 1.72] }
    ]
  }, 2_000);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].startMs, 100);
  assert.equal(captions[0].endMs, 1_720);
});

test("short breaths and long pauses become real subtitle gaps", () => {
  const captions = transcriptionOutputToCaptions({
    chunks: [
      { text: "第一段", timestamp: [0.1, 0.9] },
      { text: "换气后", timestamp: [1.1, 1.8] },
      { text: "继续。", timestamp: [1.8, 2.4] },
      { text: "长停顿后", timestamp: [3.1, 4.0] },
      { text: "结束。", timestamp: [4.0, 4.7] }
    ]
  }, 5_000);
  assert.deepEqual(
    captions.map((caption) => [caption.startMs, caption.endMs]),
    [[100, 900], [1_100, 2_400], [3_100, 4_700]]
  );
  assert.equal(captions.some((caption) => 1_000 >= caption.startMs && 1_000 < caption.endMs), false);
  assert.equal(captions.some((caption) => 2_800 >= caption.startMs && 2_800 < caption.endMs), false);
  assert.equal(captions.some((caption) => 4_850 >= caption.startMs && 4_850 < caption.endMs), false);
});

test("an overlong utterance splits at the largest real inter-word pause", () => {
  const captions = transcriptionOutputToCaptions({
    chunks: [
      { text: "一", timestamp: [0, 0.9] },
      { text: "二", timestamp: [0.92, 1.8] },
      { text: "三", timestamp: [1.82, 2.7] },
      { text: "四", timestamp: [2.72, 3.6] },
      { text: "五", timestamp: [3.72, 4.5] },
      { text: "六", timestamp: [4.52, 5.4] },
      { text: "七", timestamp: [5.42, 6.3] },
      { text: "八", timestamp: [6.32, 7.2] }
    ]
  }, 7_500);
  assert.equal(captions.length, 2);
  assert.equal(captions[0].endMs, 3_600);
  assert.equal(captions[1].startMs, 3_720);
});

test("unheard trailing reference text is rejected while every acoustic pause boundary is preserved", () => {
  const timed = [
    { id: "a", text: "第一段", startMs: 100, endMs: 900 },
    { id: "b", text: "第二段", startMs: 1_200, endMs: 2_000 },
    { id: "c", text: "第三段", startMs: 2_700, endMs: 3_500 }
  ];
  const aligned = applyReferenceTranscript(timed, "第一段，第二段，第三段。医学术语BRCA1不应拆开。");
  assert.equal(aligned.length, timed.length);
  assert.deepEqual(
    aligned.map((caption) => [caption.startMs, caption.endMs]),
    timed.map((caption) => [caption.startMs, caption.endMs])
  );
  assert.deepEqual(aligned.map(c=>c.text),timed.map(c=>c.text));
  assert.ok(aligned.every(c=>c.needsReview));
  assert.ok(aligned.every((caption) => !/^\w*$/.test(caption.text) || !/BRCA$|^1/.test(caption.text)));
});

test("stable IDs and timeline values are deterministic across retries", () => {
  const first = transcriptionOutputToCaptions(ordinaryChinese, 5_000);
  const retried = transcriptionOutputToCaptions(ordinaryChinese, 5_000);
  assert.deepEqual(retried, first);
});

test("video recognition keeps complete model timecodes and rejects missing ends", () => {
  const chunks = [
    { text: "第一句", timestamp: [1.24, 2.98] as [number, number] },
    { text: "第二句", timestamp: [3.14, 4.62] as [number, number] },
  ];
  assert.deepEqual(videoTranscriptionSegments({ chunks }, 6000).map(({ startMs, endMs, text }) => [startMs, endMs, text]), [
    [1240, 2980, "第一句"], [3140, 4620, "第二句"],
  ]);
  assert.throws(() => videoTranscriptionSegments({ chunks: [{ text: "缺少结束时间", timestamp: [1.24, null] }] }, 6000),
    (error) => error instanceof TranscriptionFailure && error.code === "result-format" && error.stage === "timestamping");
});

test("fresh Whisper cues retain original text and exact times when converted to Simplified Chinese", async () => {
  const original = [
    { id: "zh", text: "醫學語音辨識，後續請校對。", startMs: 891, endMs: 4871, videoClipId: "clip" },
    { id: "en", text: "ECG 12-lead", startMs: 4901, endMs: 5203 },
  ];
  const result = await simplifyWhisperCaptions(original);
  assert.equal(result[0].text, "医学语音辨识，后续请校对。");
  assert.equal(result[0].recognizedText, original[0].text);
  assert.equal(result[1].text, original[1].text);
  assert.deepEqual(result.map(({ startMs, endMs }) => [startMs, endMs]), [[891, 4871], [4901, 5203]]);
  assert.equal(result[0].videoClipId, "clip");
});
