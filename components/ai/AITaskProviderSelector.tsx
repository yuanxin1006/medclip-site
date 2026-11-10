"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export default function AITaskProviderSelector(props: AITaskProviderSelectorProps) {
  const { user, loading: authLoading } = useAuth();
  const userId = authLoading ? null : user?.id ?? null;
  return <AccountTaskProviderSelector key={authLoading ? "checking" : userId ?? "anonymous"} {...props} userId={userId} authLoading={authLoading} />;
}

function AccountTaskProviderSelector({
  capability = "TEXT_REASONING",
  disabled = false,
  onSelect,
  selectedProvider, userId, authLoading,
}: AITaskProviderSelectorProps & { userId: string | null; authLoading: boolean }) {
  const active = useRef(false);
  const version = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    lifetime.current = controller;
    return () => { active.current = false; version.current += 1; controller.abort(); };
  }, []);
  const [connections, setConnections] = useState<AIProviderConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectableProviders = useMemo(
    () => AI_PROVIDER_DEFINITIONS.filter((provider) => provider.taskCapabilities.includes(capability)),
    [capability],
  );

  const loadConnections = useCallback(async () => {
    if (!userId || !active.current) return;
    const request = ++version.current;
    const current = () => active.current && request === version.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await listAIProviderConnections(lifetime.current?.signal);
      if (!current()) return;
      const nextConnections = rows.filter((row) => row.user_id === userId);
      setConnections(nextConnections);
      const connectedIds = new Set(
        nextConnections
          .filter((connection) => connection.status === "connected")
          .map((connection) => connection.provider),
      );
      onSelect(selectableProviders.find((provider) => connectedIds.has(provider.id))?.id ?? null);
    } catch (nextError) {
      if (!current()) return;
      setConnections([]);
      onSelect(null);
      setError(safeAIProviderErrorMessage(nextError));
    } finally {
      if (current()) setLoading(false);
    }
  }, [onSelect, selectableProviders, userId]);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      setConnections([]);
      setError(null);
      onSelect(null);
      return;
    }
    void loadConnections();
  }, [authLoading, loadConnections, onSelect, userId]);

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

    {!authLoading && !userId && <p className="ai-task-provider-auth-required">
      登录后使用您连接的 AI 服务。<Link href="/auth">登录 / 注册</Link>
    </p>}
    {!authLoading && userId && !loading && connectedCount === 0 && <p className="ai-task-provider-empty">
      请先连接 AI 服务。
    </p>}
    {error && <p className="ai-task-provider-error" role="alert">
      {error}<button onClick={() => void loadConnections()} type="button">重试</button>
    </p>}
    <p className="ai-task-cost-notice">AI 调用费用由您所选择的服务商账户承担。</p>
  </section>;
}
