"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AIProviderId } from "../../lib/ai/types";
import { useAuth } from "../auth/AuthProvider";
import MusicPlayer from "../music/MusicPlayer";
import AITaskProviderSelector from "./AITaskProviderSelector";
import {
  createRemoteMusicGenerationGateway,
  getRemoteMusicGenerationAvailability,
} from "../../lib/ai/music-generation-client";
import {
  clearMusicOperationRecovery,
  type CompletedMusicPlayback,
  createMusicOperationId,
  isTerminalMusicOperation,
  musicGenerationStageCopy,
  persistMusicOperationRecovery,
  pollMusicOperation,
  restoreMusicOperationRecovery,
  type SafeMusicOperation,
  type MusicGenerationGateway,
  type MusicGenerationViewState,
  type RemoteMusicGenerationAvailability,
} from "../../lib/ai/music-generation-product";
import {
  createMockMusicGenerationGateway,
  type MockMusicScenario,
} from "../../lib/ai/music-generation-mock";

type AsyncMusicGenerationPanelProps = {
  creativeRequirement: string;
  lyrics: string;
  songTitle: string;
};

const LOCAL_MOCK_ENABLED = process.env.NODE_ENV === "development";
const RELEASE_UNAVAILABLE: RemoteMusicGenerationAvailability = {
  enabled: false,
  testerModeEnabled: false,
};

export default function AsyncMusicGenerationPanel({
  creativeRequirement,
  lyrics,
  songTitle,
}: AsyncMusicGenerationPanelProps) {
  const { user, loading: authLoading } = useAuth();
  const [selectedMusicProvider, setSelectedMusicProvider] = useState<AIProviderId | null>(null);
  const [scenario, setScenario] = useState<MockMusicScenario>("COMPLETED");
  const [viewState, setViewState] = useState<MusicGenerationViewState>("IDLE");
  const [operation, setOperation] = useState<SafeMusicOperation | null>(null);
  const [playback, setPlayback] = useState<CompletedMusicPlayback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remoteAvailability, setRemoteAvailability] = useState<RemoteMusicGenerationAvailability>(RELEASE_UNAVAILABLE);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availabilityResolved, setAvailabilityResolved] = useState(false);
  const submissionInFlightRef = useRef(false);
  const pollingControllerRef = useRef<AbortController | null>(null);
  const recoveredUserRef = useRef<string | null>(null);

  const gateway = useMemo<MusicGenerationGateway | null>(() => {
    if (!user) return null;
    if (LOCAL_MOCK_ENABLED && !remoteAvailability.enabled && typeof window !== "undefined") {
      return createMockMusicGenerationGateway({
        authenticatedUserId: user.id,
        storage: window.sessionStorage,
        scenario,
      });
    }
    return createRemoteMusicGenerationGateway();
  }, [remoteAvailability.enabled, scenario, user]);

  useEffect(() => {
    let active = true;
    if (authLoading || !user) {
      setRemoteAvailability(RELEASE_UNAVAILABLE);
      setAvailabilityLoading(false);
      setAvailabilityResolved(!authLoading);
      return () => { active = false; };
    }
    setAvailabilityResolved(false);
    setAvailabilityLoading(true);
    void getRemoteMusicGenerationAvailability()
      .then((availability) => {
        if (active) setRemoteAvailability(availability);
      })
      .catch(() => {
        if (active) setRemoteAvailability(RELEASE_UNAVAILABLE);
      })
      .finally(() => {
        if (active) {
          setAvailabilityLoading(false);
          setAvailabilityResolved(true);
        }
      });
    return () => { active = false; };
  }, [authLoading, user]);

  const applyOperation = useCallback(async (next: SafeMusicOperation, source: MusicGenerationGateway) => {
    setOperation(next);
    setViewState(next.status);
    setError(null);
    if (next.status === "COMPLETED" && next.trackId) {
      try {
        setPlayback(await source.getCompletedTrack(next.trackId));
      } catch {
        setPlayback(null);
        setError("歌曲已生成，但暂时无法读取试听链接。请前往音乐作品查看草稿。");
      }
    } else {
      setPlayback(null);
    }
  }, []);

  const stopPolling = useCallback(() => {
    pollingControllerRef.current?.abort();
    pollingControllerRef.current = null;
  }, []);

  const beginPolling = useCallback((operationId: string, source: MusicGenerationGateway) => {
    stopPolling();
    const controller = new AbortController();
    pollingControllerRef.current = controller;
    void pollMusicOperation({
      operationId,
      getStatus: (id) => source.getStatus(id),
      onStatus: (next) => applyOperation(next, source),
      signal: controller.signal,
    }).catch(() => {
      if (!controller.signal.aborted) {
        setViewState("UNKNOWN");
        setError("暂时无法确认生成结果，请稍后返回本页面查看。系统不会自动重新生成。");
      }
    });
  }, [applyOperation, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    if (authLoading || !availabilityResolved || !user || !gateway || typeof window === "undefined") return;
    if (recoveredUserRef.current === user.id) return;
    recoveredUserRef.current = user.id;
    const recovery = restoreMusicOperationRecovery(window.sessionStorage, user.id);
    if (!recovery) return;
    setViewState("SUBMITTING");
    void gateway.getStatus(recovery.operationId)
      .then(async (next) => {
        await applyOperation(next, gateway);
        if (!isTerminalMusicOperation(next.status)) beginPolling(next.operationId, gateway);
      })
      .catch(() => {
        setViewState("UNKNOWN");
        setError("已恢复生成任务编号，但暂时无法读取状态。请稍后查看，系统不会自动重新生成。");
      });
  }, [applyOperation, authLoading, availabilityResolved, beginPolling, gateway, user]);

  useEffect(() => {
    if (!user) recoveredUserRef.current = null;
  }, [user]);

  const submitGeneration = async () => {
    if (submissionInFlightRef.current || !user || !gateway) return;
    if (selectedMusicProvider !== "tencent_tokenhub") {
      setError("请先连接并选择腾讯云 TokenHub 音乐生成服务。");
      return;
    }
    if (!LOCAL_MOCK_ENABLED && !remoteAvailability.enabled) {
      setError("真实歌曲生成尚未公开开放。本阶段仅完成本地异步体验验证。");
      return;
    }
    const cleanLyrics = lyrics.trim();
    const cleanRequirement = creativeRequirement.trim() || songTitle.trim();
    if (!cleanLyrics && !cleanRequirement) {
      setError("请先填写歌词、歌曲名称或其他创作要求。");
      return;
    }

    submissionInFlightRef.current = true;
    stopPolling();
    setViewState("SUBMITTING");
    setOperation(null);
    setPlayback(null);
    setError(null);
    const operationId = createMusicOperationId();
    persistMusicOperationRecovery(window.sessionStorage, user.id, {
      operationId,
      title: songTitle.trim(),
    });
    try {
      const accepted = await gateway.start(cleanLyrics
        ? {
          operationId,
          mode: "custom_lyrics",
          lyrics: cleanLyrics,
          ...(cleanRequirement ? { prompt: cleanRequirement } : {}),
          ...(songTitle.trim() ? { title: songTitle.trim() } : {}),
        }
        : {
          operationId,
          mode: "instrumental",
          prompt: cleanRequirement,
          ...(songTitle.trim() ? { title: songTitle.trim() } : {}),
        });
      const timestamp = new Date().toISOString();
      await applyOperation({
        operationId: accepted.operationId,
        status: accepted.status,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, gateway);
      beginPolling(accepted.operationId, gateway);
    } catch (nextError) {
      setViewState("UNKNOWN");
      setError(nextError instanceof Error ? nextError.message : "暂时无法创建生成任务。");
    } finally {
      submissionInFlightRef.current = false;
    }
  };

  const resetLocalView = () => {
    stopPolling();
    if (user && typeof window !== "undefined") clearMusicOperationRecovery(window.sessionStorage, user.id);
    setViewState("IDLE");
    setOperation(null);
    setPlayback(null);
    setError(null);
  };

  const stage = musicGenerationStageCopy(viewState);
  const busy = viewState === "SUBMITTING"
    || viewState === "RESERVED"
    || viewState === "PROVIDER_IN_FLIGHT"
    || viewState === "FINALIZING";
  const generationControlEnabled = LOCAL_MOCK_ENABLED || remoteAvailability.enabled;

  return <section className="async-music-foundation" aria-label="异步歌曲生成">
    <AITaskProviderSelector
      capability="MUSIC_GENERATION"
      disabled={busy}
      onSelect={setSelectedMusicProvider}
      selectedProvider={selectedMusicProvider}
    />

    {LOCAL_MOCK_ENABLED && !remoteAvailability.enabled && <label className="async-music-mock-control">
      本地 Mock 结果
      <select
        disabled={busy}
        onChange={(event) => setScenario(event.target.value as MockMusicScenario)}
        value={scenario}
      >
        <option value="COMPLETED">完成</option>
        <option value="FAILED">失败</option>
        <option value="UNKNOWN">结果待确认</option>
      </select>
      <small>仅开发环境可用，不调用 TokenHub，不产生费用。</small>
    </label>}

    <button
      className="platform-primary-button ai-generate-button"
      disabled={!generationControlEnabled || busy || authLoading || availabilityLoading || !availabilityResolved || !user || selectedMusicProvider !== "tencent_tokenhub"}
      onClick={() => void submitGeneration()}
      type="button"
    >生成歌曲</button>

    {remoteAvailability.testerModeEnabled && <p className="async-music-test-mode-note">
      已启用仅限指定测试账号的异步验收模式。
    </p>}

    {!generationControlEnabled && <p className="async-music-release-note">
      异步产品基础正在验证，真实付费生成仍未公开开放。
    </p>}

    <div className={`async-music-stage is-${stage.tone}`} role="status">
      <span className="async-music-stage-marker" aria-hidden="true" />
      <div>
        <h2>{stage.label}</h2>
        <p>{stage.description}</p>
      </div>
    </div>

    {operation && <p className="async-music-operation-ref">
      任务编号 <code>{operation.operationId}</code>
    </p>}
    {error && <p className="async-music-error" role="alert">{error}</p>}

    {viewState === "COMPLETED" && playback && <div className="async-music-completed">
      <MusicPlayer
        artist={playback.artist}
        durationSeconds={playback.durationSeconds}
        src={playback.src}
        title={playback.title}
      />
      <p>该结果保持为仅本人可见的未发布草稿，不会自动发布。</p>
      <Link href="/music">前往音乐作品管理草稿</Link>
    </div>}

    {(viewState === "COMPLETED" || viewState === "FAILED") && <button
      className="platform-secondary-button async-music-reset"
      onClick={resetLocalView}
      type="button"
    >返回创作表单</button>}
  </section>;
}
