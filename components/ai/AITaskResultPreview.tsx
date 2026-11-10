import type { AITaskResultValue, AITaskSuccessResult } from "../../lib/ai/tasks";
import type { ReactNode } from "react";

type AITaskResultPreviewProps = {
  busy: boolean;
  error: string | null;
  result: AITaskSuccessResult | null;
  safetyNote?: string;
  title: string;
};

function renderResultValue(value: AITaskResultValue): ReactNode {
  if (Array.isArray(value)) {
    return <ul>{value.map((item, index) => <li key={index}>{renderResultValue(item)}</li>)}</ul>;
  }
  if (value && typeof value === "object") {
    return <ul>{Object.entries(value).map(([key, item]) => <li key={key}>
      <strong>{key}</strong>: {renderResultValue(item)}
    </li>)}</ul>;
  }
  return String(value);
}

export default function AITaskResultPreview({
  busy,
  error,
  result,
  safetyNote,
  title,
}: AITaskResultPreviewProps) {
  return <section aria-live="polite" className="ai-task-result-preview">
    <div>
      <h3>{title}</h3>
    </div>
    {busy && <p className="ai-task-result-state">正在请求结构化建议…</p>}
    {!busy && error && <p className="ai-task-result-error" role="alert">{error}</p>}
    {!busy && !error && !result && <p className="ai-task-result-state">运行创作工具后在此查看结果。</p>}
    {!busy && result && <dl className="ai-task-result-data">
      {Object.entries(result.result.data).map(([key, value]) => <div key={key}>
        <dt>{key}</dt>
        <dd>{renderResultValue(value)}</dd>
      </div>)}
    </dl>}
    {safetyNote && <p className="ai-task-safety-note">{safetyNote}</p>}
  </section>;
}
