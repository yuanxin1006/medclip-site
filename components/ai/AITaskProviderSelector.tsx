"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { listAIProviderConnections } from "../../lib/ai/client";
import { AI_PROVIDER_DEFINITIONS } from "../../lib/ai/providers";
import type {
  AIProviderConnection,
  AIProviderId,
  AIProviderTaskCapability,
} from "../../lib/ai/types";
import { aiProviderStatusLabel, safeAIProviderErrorMessage } from "../../lib/ai/ui";

type AITaskProviderSelectorProps = {
  capability?: AIProviderTaskCapability;
  disabled?: boolean;
  onSelect: (provider: AIProviderId | null) => void;
  selectedProvider: AIProviderId | null;
};

export default function AITaskProviderSelector({
  capability = "TEXT_REASONING",
  disabled = false,
  onSelect,
  selectedProvider,
}: AITaskProviderSelectorProps) {
  const { user, loading: authLoading } = useAuth();
  const [connections, setConnections] = useState<AIProviderConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectableProviders = useMemo(
    () => AI_PROVIDER_DEFINITIONS.filter((provider) => provider.taskCapabilities.includes(capability)),
    [capability],
  );

  const loadConnections = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const nextConnections = await listAIProviderConnections();
      setConnections(nextConnections);
      const connectedIds = new Set(
        nextConnections
          .filter((connection) => connection.status === "connected")
          .map((connection) => connection.provider),
      );
      onSelect(selectableProviders.find((provider) => connectedIds.has(provider.id))?.id ?? null);
    } catch (nextError) {
      setConnections([]);
      onSelect(null);
      setError(safeAIProviderErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [onSelect, selectableProviders, user]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setConnections([]);
      setError(null);
      onSelect(null);
      return;
    }
    void loadConnections();
  }, [authLoading, loadConnections, onSelect, user]);

  const connectionsByProvider = useMemo(
    () => new Map(connections.map((connection) => [connection.provider, connection])),
    [connections],
  );
  const selectableProviderIds = new Set(selectableProviders.map((provider) => provider.id));
  const connectedCount = connections.filter(
    (connection) => connection.status === "connected" && selectableProviderIds.has(connection.provider),
  ).length;

  return <section aria-label="AI 服务" className="ai-task-provider-selector">
    <div className="ai-task-provider-heading">
      <div>
        
        <h3>选择本次使用的服务商</h3>
      </div>
      <Link href="/ai-services">前往我的 AI 服务</Link>
    </div>

    <div aria-label="选择 AI 服务商" className="ai-task-provider-options" role="radiogroup">
      {selectableProviders.map((provider) => {
        const connection = connectionsByProvider.get(provider.id);
        const connected = connection?.status === "connected";
        const selected = connected && selectedProvider === provider.id;
        return <button
          aria-checked={selected}
          className={selected ? "is-selected" : ""}
          disabled={disabled || loading || !connected}
          key={provider.id}
          onClick={() => onSelect(provider.id)}
          role="radio"
          type="button"
        >
          <strong>{provider.displayName}</strong>
          <span className={connected ? "is-connected" : ""}>
            {loading ? "读取中" : aiProviderStatusLabel(connection?.status ?? null)}
          </span>
        </button>;
      })}
    </div>

    {!authLoading && !user && <p className="ai-task-provider-auth-required">
      登录后使用您连接的 AI 服务。<Link href="/auth">登录 / 注册</Link>
    </p>}
    {!authLoading && user && !loading && connectedCount === 0 && <p className="ai-task-provider-empty">
      请先连接 AI 服务。
    </p>}
    {error && <p className="ai-task-provider-error" role="alert">
      {error}<button onClick={() => void loadConnections()} type="button">重试</button>
    </p>}
    <p className="ai-task-cost-notice">AI 调用费用由您所选择的服务商账户承担。</p>
  </section>;
}
