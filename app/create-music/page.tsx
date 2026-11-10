"use client";

import visual from "./create-music.module.css";

import { useState } from "react";
import AITaskProviderSelector from "../../components/ai/AITaskProviderSelector";
import AITaskResultPreview from "../../components/ai/AITaskResultPreview";
import AsyncMusicGenerationPanel from "../../components/ai/AsyncMusicGenerationPanel";
import {
  runAITask,
  type AITaskSuccessResult,
  type MusicAITaskId,
  type MusicTaskInput,
} from "../../lib/ai/tasks";
import type { AIProviderId } from "../../lib/ai/types";

const styles = ["流行", "民谣", "电子", "电影感", "R&B"];
const moods = ["明亮", "治愈", "忧郁", "热烈", "空灵"];
const voices = ["自动", "女声", "男声", "纯音乐"];

const musicTaskActions: ReadonlyArray<{ id: MusicAITaskId; label: string }> = [
  { id: "music.lyrics_draft", label: "生成歌词草稿" },
  { id: "music.lyrics_refine", label: "优化歌词" },
  { id: "music.creative_brief", label: "生成创作方案" },
  { id: "music.song_structure", label: "歌曲结构建议" },
  { id: "music.prompt_prepare", label: "准备音乐提示词" },
];

function ChoiceRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  return <fieldset className="music-choice-row">
    <legend>{label}</legend>
    <div>{options.map((option) => <button
      className={value === option ? "is-selected" : ""}
      key={option}
      onClick={() => onChange(option)}
      type="button"
    >{option}</button>)}</div>
  </fieldset>;
}

export default function CreateMusicPage() {
  const [songTitle, setSongTitle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [creativeRequirement, setCreativeRequirement] = useState("");
  const [style, setStyle] = useState(styles[0]);
  const [mood, setMood] = useState(moods[0]);
  const [voice, setVoice] = useState(voices[0]);
  const [fileName, setFileName] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<AIProviderId | null>(null);
  const [aiTaskBusy, setAITaskBusy] = useState(false);
  const [aiTaskError, setAITaskError] = useState<string | null>(null);
  const [aiTaskResult, setAITaskResult] = useState<AITaskSuccessResult | null>(null);

  const runMusicTextTask = async (task: MusicAITaskId) => {
    if (!selectedProvider) {
      setAITaskError("请先选择一个已经连接的 AI 服务。");
      return;
    }
    const theme = songTitle.trim() || creativeRequirement.trim();
    const brief = creativeRequirement.trim() || songTitle.trim();
    const currentLyrics = lyrics.trim();
    let input: MusicTaskInput;

    if (task === "music.lyrics_draft") {
      if (!theme) {
        setAITaskError("请先填写歌曲名称或其他要求，作为歌词主题。");
        return;
      }
      input = { theme, language: "zh-CN", ...(creativeRequirement.trim() ? { creativeRequirement: creativeRequirement.trim() } : {}) };
    } else if (task === "music.lyrics_refine") {
      if (!currentLyrics) {
        setAITaskError("请先填写需要优化的歌词。");
        return;
      }
      input = { lyrics: currentLyrics, ...(creativeRequirement.trim() ? { creativeRequirement: creativeRequirement.trim() } : {}) };
    } else if (task === "music.creative_brief") {
      if (!brief) {
        setAITaskError("请先填写歌曲名称或其他创作要求。");
        return;
      }
      input = {
        creativeRequirement: brief,
        genre: style,
        mood,
        voicePreference: voice,
        ...(songTitle.trim() ? { title: songTitle.trim() } : {}),
        ...(currentLyrics ? { lyrics: currentLyrics } : {}),
      };
    } else if (task === "music.song_structure") {
      if (!currentLyrics) {
        setAITaskError("请先填写歌词，再生成歌曲结构建议。");
        return;
      }
      input = { lyrics: currentLyrics, ...(brief ? { creativeRequirement: brief } : {}) };
    } else {
      if (!brief) {
        setAITaskError("请先填写歌曲名称或其他创作要求。");
        return;
      }
      input = {
        creativeRequirement: brief,
        style,
        mood,
        ...(currentLyrics ? { lyrics: currentLyrics } : {}),
      };
    }

    setAITaskBusy(true);
    setAITaskError(null);
    setAITaskResult(null);
    try {
      setAITaskResult(await runAITask({ task, provider: selectedProvider, input }));
    } catch (error) {
      setAITaskError(error instanceof Error ? error.message : "AI 任务暂时无法完成。");
    } finally {
      setAITaskBusy(false);
    }
  };

  return <main className={`platform-page ai-music-page ${visual.page}`}>
    <section className="platform-page-heading">
      <div>
        <h1>AI 歌曲生成</h1>
        
      </div>
      <span className="platform-status-pill">音乐生成尚未启用</span>
    </section>

    <div className="ai-provider-first-screen">
      <AITaskProviderSelector
        disabled={aiTaskBusy}
        onSelect={setSelectedProvider}
        selectedProvider={selectedProvider}
      />
    </div>

    <div className="ai-music-layout">
      <form className="ai-music-form" onSubmit={(event) => event.preventDefault()}>
        <label>歌曲名称<input onChange={(event) => setSongTitle(event.target.value)} placeholder="给这首歌取一个名字" value={songTitle} /></label>
        <label>歌词<textarea onChange={(event) => setLyrics(event.target.value)} placeholder="输入歌词、段落结构或想表达的画面……" rows={9} value={lyrics} /></label>
        <label className="platform-file-field">上传歌词文件
          <input accept=".txt,.md,.doc,.docx" onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")} type="file" />
          <span>{fileName || "选择 .txt、.md 或文档文件（仅本地显示）"}</span>
        </label>
        <ChoiceRow label="音乐风格" onChange={setStyle} options={styles} value={style} />
        <ChoiceRow label="歌曲情绪" onChange={setMood} options={moods} value={mood} />
        <ChoiceRow label="人声音色" onChange={setVoice} options={voices} value={voice} />
        <div className="ai-settings">
          <label>歌曲时长<select defaultValue="180"><option value="120">约 2 分钟</option><option value="180">约 3 分钟</option><option value="240">约 4 分钟</option></select></label>
          <label>其他要求<input onChange={(event) => setCreativeRequirement(event.target.value)} placeholder="例如：前奏使用钢琴" value={creativeRequirement} /></label>
        </div>

        <div className="ai-task-actions" aria-label="歌曲文本 AI 工具">
          {musicTaskActions.map((action) => <button
            className="platform-secondary-button"
            disabled={aiTaskBusy || !selectedProvider}
            key={action.id}
            onClick={() => void runMusicTextTask(action.id)}
            type="button"
          >{aiTaskBusy ? "处理中…" : action.label}</button>)}
        </div>

      </form>

      <aside className="ai-result-panel">
        <AITaskResultPreview
          busy={aiTaskBusy}
          error={aiTaskError}
          result={aiTaskResult}
          safetyNote="文本建议不会自动触发音乐生成，也不会上传歌词文件。"
          title="歌曲创作建议"
        />
        <AsyncMusicGenerationPanel
          creativeRequirement={creativeRequirement}
          lyrics={lyrics}
          songTitle={songTitle}
        />
      </aside>
    </div>
  </main>;
}
