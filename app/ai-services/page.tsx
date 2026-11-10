"use client";

import "./ai-services.css";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [connections, setConnections] = useState<AIProviderConnection[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const loadConnections = useCallback(async (showLoading = true) => {
    if (!user) return false;
    if (showLoading) setListLoading(true);
    setPageError(null);
    try {
      setConnections(await listAIProviderConnections());
      return true;
    } catch (error) {
      setPageError(safeAIProviderErrorMessage(error));
      return false;
    } finally {
      if (showLoading) setListLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) void loadConnections();
    else {
      setConnections([]);
      setPageError(null);
    }
  }, [loadConnections, user]);

  const byProvider = useMemo(
    () => new Map(connections.map((connection) => [connection.provider, connection])),
    [connections],
  );

  const replaceConnection = (connection: AIProviderConnection) => {
    setConnections((current) => [
      ...current.filter((item) => item.provider !== connection.provider),
      connection,
    ]);
  };

  const refreshAfterMutation = async () => {
    const refreshed = await loadConnections(false);
    if (!refreshed) {
      setPageError("操作已经完成，但最新连接状态暂时无法刷新。请稍后重试。");
    }
  };

  if (authLoading) {
    return <main className="platform-page ai-services-page">
      <section aria-live="polite" className="ai-services-gate">正在恢复登录状态…</section>
    </main>;
  }

  if (!user) {
    return <main className="platform-page ai-services-page">
      <AnonymousLandingGate />
    </main>;
  }

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
          key={provider.id}
          onDelete={async () => {
            await deleteAIProviderCredential(provider.id);
            setConnections((current) => current.filter((item) => item.provider !== provider.id));
          }}
          onPersist={async (apiKey, providerResourceId) => {
            const saved = connection
              ? await updateAIProviderCredential(provider.id, apiKey, { providerResourceId })
              : await saveAIProviderCredential(provider.id, apiKey, { providerResourceId });
            replaceConnection(saved);
            return saved;
          }}
          onRefresh={refreshAfterMutation}
          onTestSaved={() => testSavedCredential(provider.id)}
          onTestTransient={(apiKey, providerResourceId) => testTransientCredential(
            provider.id as AIProviderId,
            apiKey,
            { providerResourceId },
          )}
          provider={provider}
        />;
      })}
    </section>
  </main>;
}
