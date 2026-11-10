"use client";

import { useEffect, useRef, useState } from "react";
import type {
  AIProviderConnection,
  AIProviderDefinition,
  CredentialValidationResult,
} from "../../lib/ai/types";
import {
  aiProviderStatusLabel,
  formatAIProviderValidationTime,
  maskAIProviderKey,
  safeAIProviderErrorMessage,
  safeAIProviderStatusMessage,
} from "../../lib/ai/ui";
import DeleteProviderDialog from "./DeleteProviderDialog";

type BusyAction = "test-transient" | "test-saved" | "persist" | "delete";

type Props = {
  provider: AIProviderDefinition;
  connection: AIProviderConnection | null;
  onPersist: (apiKey: string, providerResourceId?: string) => Promise<AIProviderConnection>;
  onRefresh: () => Promise<void>;
  onTestTransient: (apiKey: string, providerResourceId?: string) => Promise<CredentialValidationResult>;
  onTestSaved: () => Promise<CredentialValidationResult>;
  onDelete: () => Promise<void>;
};

export default function AIProviderCard({
  provider,
  connection,
  onPersist,
  onRefresh,
  onTestTransient,
  onTestSaved,
  onDelete,
}: Props) {
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const [replacing, setReplacing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [providerResourceId, setProviderResourceId] = useState(connection?.provider_resource_id ?? "");
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setProviderResourceId(connection?.provider_resource_id ?? "");
    if (connection) setReplacing(false);
  }, [connection]);

  const clearSecretInput = () => {
    setApiKey("");
    setShowKey(false);
  };

  const configurationResourceId = provider.requiresResourceId
    ? providerResourceId.trim() || undefined
    : undefined;
  const resourceMissing = provider.requiresResourceId && !configurationResourceId;
  const secretMissing = !apiKey.trim();
  const busy = busyAction !== null;
  const showCredentialForm = !connection || replacing;
  const validatedAt = formatAIProviderValidationTime(connection?.last_validated_at ?? null);

  const testTransient = async () => {
    setBusyAction("test-transient");
    setNotice(null);
    try {
      const result = await onTestTransient(apiKey, configurationResourceId);
      if (!active.current) return;
      setNotice({
        kind: result.ok ? "success" : "error",
        text: result.ok ? "连接测试通过；凭证尚未保存。" : safeAIProviderStatusMessage(result.status),
      });
    } catch (error) {
      if (!active.current) return;
      setNotice({ kind: "error", text: safeAIProviderErrorMessage(error) });
    } finally {
      if (active.current) setBusyAction(null);
    }
  };

  const testSaved = async () => {
    setBusyAction("test-saved");
    setNotice(null);
    try {
      const result = await onTestSaved();
      if (!active.current) return;
      setNotice({
        kind: result.ok ? "success" : "error",
        text: result.ok ? "已保存连接验证通过。" : safeAIProviderStatusMessage(result.status),
      });
      await onRefresh();
    } catch (error) {
      if (!active.current) return;
      setNotice({ kind: "error", text: safeAIProviderErrorMessage(error) });
    } finally {
      if (active.current) setBusyAction(null);
    }
  };

  const persist = async () => {
    setBusyAction("persist");
    setNotice(null);
    try {
      const wasConnected = Boolean(connection);
      await onPersist(apiKey, configurationResourceId);
      if (!active.current) return;
      clearSecretInput();
      setReplacing(false);
      setNotice({
        kind: "success",
        text: wasConnected ? "API Key 已安全更新并通过验证。" : "API Key 已加密保存并通过验证。",
      });
      await onRefresh();
    } catch (error) {
      if (!active.current) return;
      setNotice({ kind: "error", text: safeAIProviderErrorMessage(error) });
    } finally {
      if (active.current) setBusyAction(null);
    }
  };

  const remove = async () => {
    setBusyAction("delete");
    setNotice(null);
    try {
      await onDelete();
      if (!active.current) return;
      clearSecretInput();
      setReplacing(false);
      setDeleteOpen(false);
      setNotice({ kind: "success", text: `${provider.displayName} 连接已删除。` });
      await onRefresh();
    } catch (error) {
      if (!active.current) return;
      setNotice({ kind: "error", text: safeAIProviderErrorMessage(error) });
    } finally {
      if (active.current) setBusyAction(null);
    }
  };

  const startReplacement = () => {
    clearSecretInput();
    setProviderResourceId(connection?.provider_resource_id ?? "");
    setNotice(null);
    setReplacing(true);
  };

  const cancelReplacement = () => {
    clearSecretInput();
    setProviderResourceId(connection?.provider_resource_id ?? "");
    setNotice(null);
    setReplacing(false);
  };

  return <article aria-busy={busy} className="ai-provider-card" data-provider={provider.id}>
    <div className="ai-provider-card-heading">
      <div>
        <span className={`ai-provider-region is-${provider.regionClass}`}>{provider.regionLabel}</span>
        <h2>{provider.displayName}</h2>
        
      </div>
      <span className={`ai-provider-status is-${connection?.status ?? "disconnected"}`}>
        {aiProviderStatusLabel(connection?.status ?? null)}
      </span>
    </div>

    {connection && <div className="ai-provider-metadata">
      <div><span>API Key</span><strong>{maskAIProviderKey(connection.key_last4)}</strong></div>
      <div><span>凭证状态</span><strong>{aiProviderStatusLabel(connection.status)}</strong></div>
      {validatedAt && <div><span>最近验证</span><strong>{validatedAt}</strong></div>}
      {provider.requiresResourceId && connection.provider_resource_id && <div>
        <span>{provider.resourceIdLabel}</span><strong>{connection.provider_resource_id}</strong>
      </div>}
    </div>}

    {showCredentialForm && <div className="ai-provider-form">
      {provider.requiresResourceId && <label>{provider.resourceIdLabel}
        <input
          autoComplete="off"
          disabled={busy}
          maxLength={200}
          onChange={(event) => setProviderResourceId(event.target.value)}
          placeholder="apikey-..."
          spellCheck={false}
          value={providerResourceId}
        />
        <small>请输入火山方舟 API Key 管理页中与该 Key 对应的资源 ID（ApikeyID）。它不是 API Key、模型 ID 或推理接入点 ID。</small>
      </label>}
      <label>API Key
        <span className="ai-secret-input">
          <input
            autoComplete="new-password"
            disabled={busy}
            name={`${provider.id}-api-key`}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={connection ? "输入完整的新 API Key" : "输入您的 API Key"}
            spellCheck={false}
            type={showKey ? "text" : "password"}
            value={apiKey}
          />
          <button
            aria-label={showKey ? "隐藏当前输入的 API Key" : "显示当前输入的 API Key"}
            disabled={busy || secretMissing}
            onClick={() => setShowKey((visible) => !visible)}
            type="button"
          >{showKey ? "隐藏" : "显示"}</button>
        </span>
        <small>保存成功后清空输入，不会回显完整密钥。</small>
      </label>
    </div>}

    {notice && <p className={`ai-provider-notice is-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>}

    <div className="ai-provider-actions">
      {connection && !replacing ? <>
        <button className="platform-secondary-button" disabled={busy} onClick={testSaved} type="button">
          {busyAction === "test-saved" ? "测试中…" : "测试已保存连接"}
        </button>
        <button className="platform-secondary-button" disabled={busy} onClick={startReplacement} type="button">更换 API Key</button>
        <button className="ai-provider-delete" disabled={busy} onClick={() => setDeleteOpen(true)} type="button">删除连接</button>
      </> : <>
        <button className="platform-secondary-button" disabled={busy || secretMissing || resourceMissing} onClick={testTransient} type="button">
          {busyAction === "test-transient" ? "测试中…" : "测试连接"}
        </button>
        <button className="platform-primary-button" disabled={busy || secretMissing || resourceMissing} onClick={persist} type="button">
          {busyAction === "persist" ? "处理中…" : connection ? "更新连接" : "保存并连接"}
        </button>
        {connection && <button className="ai-provider-text-button" disabled={busy} onClick={cancelReplacement} type="button">取消更换</button>}
      </>}
    </div>

    <DeleteProviderDialog
      busy={busyAction === "delete"}
      onCancel={() => setDeleteOpen(false)}
      onConfirm={() => void remove()}
      open={deleteOpen}
      providerName={provider.displayName}
    />
  </article>;
}
