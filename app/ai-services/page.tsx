"use client";

import "./ai-services.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AIProviderCard from "../../components/ai/AIProviderCard";
import AIServiceCostNotice from "../../components/ai/AIServiceCostNotice";
import { useAuth } from "../../components/auth/AuthProvider";
import AnonymousLandingGate from "../../components/platform/AnonymousLandingGate";
import {
  deleteAIProviderCredential,
  listAIProviderConnections,
  saveAIProviderCredential,
  testSavedCredential,
  testTransientCredential,
  updateAIProviderCredential,
} from "../../lib/ai/client";
import { AI_PROVIDER_DEFINITIONS } from "../../lib/ai/providers";
import type { AIProviderConnection, AIProviderId } from "../../lib/ai/types";
import { safeAIProviderErrorMessage } from "../../lib/ai/ui";

export default function AIServicesPage() {
  const { user, loading: authLoading } = useAuth();
  if (authLoading) return <main className="platform-page ai-services-page">
    <section aria-live="polite" className="ai-services-gate">正在恢复登录状态…</section>
  </main>;
  if (!user) {
    return <main className="platform-page ai-services-page"><AnonymousLandingGate /></main>;
  }

  return <AccountAIServices key={user.id} userId={user.id} />;
}

function AccountAIServices({ userId }: { userId: string }) {
  const active = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const listVersion = useRef(0);
  const [connections, setConnections] = useState<AIProviderConnection[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const loadConnections = useCallback(async (showLoading = true) => {
    if (!active.current) return false;
    const version = ++listVersion.current;
    const current = () => active.current && version === listVersion.current;
    if (showLoading) setListLoading(true);
    setPageError(null);
    try {
      const next = await listAIProviderConnections(lifetime.current?.signal);
      if (!current()) return false;
      setConnections(next.filter((connection) => connection.user_id === userId));
      return true;
    } catch (error) {
      if (current()) setPageError(safeAIProviderErrorMessage(error));
      return false;
    } finally {
      if (current()) setListLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    lifetime.current = controller;
    void loadConnections();
    return () => {
      active.current = false;
      controller.abort();
      listVersion.current += 1;
    };
  }, [loadConnections]);

  const byProvider = useMemo(
    () => new Map(connections.map((connection) => [connection.provider, connection])),
    [connections],
  );

  const replaceConnection = (connection: AIProviderConnection) => {
    if (!active.current || connection.user_id !== userId) return;
    setConnections((current) => [
      ...current.filter((item) => item.provider !== connection.provider),
      connection,
    ]);
  };

  const refreshAfterMutation = async () => {
    if (!active.current) return;
    const refreshed = await loadConnections(false);
    if (active.current && !refreshed) {
      setPageError("操作已经完成，但最新连接状态暂时无法刷新。请稍后重试。");
    }
  };

  return <main className="platform-page ai-services-page">
    <section className="platform-page-heading">
      <div>
        <h1>我的 AI 服务</h1>
        
      </div>
      <span className="platform-status-pill">账户级安全设置</span>
    </section>

    <AIServiceCostNotice />

    <section className="ai-services-security-note">
      <strong>凭证安全</strong>
      <span>已保存的 API Key 仅显示末四位。完整密钥不会返回浏览器，也不会写入本地存储、URL 或日志。</span>
    </section>

    {pageError && <p className="music-page-message is-error" role="alert">
      {pageError}
      <button disabled={listLoading} onClick={() => void loadConnections()} type="button">重试</button>
    </p>}
    {listLoading && <p aria-live="polite" className="ai-services-loading">正在读取连接状态…</p>}

    <section aria-label="AI 服务商连接" className="ai-provider-grid">
      {AI_PROVIDER_DEFINITIONS.map((provider) => {
        const connection = byProvider.get(provider.id) ?? null;
        return <AIProviderCard
          connection={connection}
          key={`${userId}:${provider.id}`}
          onDelete={async () => {
            if (!active.current) return;
            listVersion.current += 1;
            await deleteAIProviderCredential(provider.id, lifetime.current?.signal);
            if (!active.current) return;
            setConnections((current) => current.filter((item) => item.provider !== provider.id));
          }}
          onPersist={async (apiKey, providerResourceId) => {
            if (!active.current) throw new Error("Account changed");
            listVersion.current += 1;
            const saved = connection
              ? await updateAIProviderCredential(provider.id, apiKey, { providerResourceId, signal: lifetime.current?.signal })
              : await saveAIProviderCredential(provider.id, apiKey, { providerResourceId, signal: lifetime.current?.signal });
            replaceConnection(saved);
            return saved;
          }}
          onRefresh={refreshAfterMutation}
          onTestSaved={() => testSavedCredential(provider.id, lifetime.current?.signal)}
          onTestTransient={(apiKey, providerResourceId) => testTransientCredential(
            provider.id as AIProviderId,
            apiKey,
            { providerResourceId, signal: lifetime.current?.signal },
          )}
          provider={provider}
        />;
      })}
    </section>
  </main>;
}
