type Props = {
  busy: boolean;
  open: boolean;
  providerName: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function DeleteProviderDialog({
  busy,
  open,
  providerName,
  onCancel,
  onConfirm,
}: Props) {
  if (!open) return null;

  return <div className="ai-delete-dialog-backdrop" role="presentation">
    <section aria-labelledby="ai-delete-dialog-title" aria-modal="true" className="ai-delete-dialog" role="dialog">
      <h3 id="ai-delete-dialog-title">删除 {providerName} 连接？</h3>
      <p>删除后，MedClip 将无法继续使用您保存的 {providerName} API Key。您可以之后重新连接。</p>
      <div className="ai-delete-dialog-actions">
        <button className="platform-secondary-button" disabled={busy} onClick={onCancel} type="button">取消</button>
        <button className="ai-provider-delete" disabled={busy} onClick={onConfirm} type="button">{busy ? "删除中…" : "确认删除"}</button>
      </div>
    </section>
  </div>;
}
