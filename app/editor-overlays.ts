export type EditorOverlayType = "text" | "arrow" | "rectangle" | "circle";

type OverlayGeometry = {
  id: string;
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TextEditorOverlay = OverlayGeometry & {
  type: "text";
  text: string;
  fontSize: number;
};

export type ArrowEditorOverlay = OverlayGeometry & {
  type: "arrow";
  direction: "right" | "left";
};

export type ShapeEditorOverlay = OverlayGeometry & {
  type: "rectangle" | "circle";
};

export type EditorOverlay = TextEditorOverlay | ArrowEditorOverlay | ShapeEditorOverlay;

export const MIN_OVERLAY_SIZE = 0.04;
export const MIN_OVERLAY_DURATION_MS = 50;

const finite = (value: unknown, fallback: number) => (
  typeof value === "number" && Number.isFinite(value) ? value : fallback
);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function normalizeOverlay(
  overlay: EditorOverlay,
  projectDurationMs: number,
): EditorOverlay {
  const durationMs = Math.max(MIN_OVERLAY_DURATION_MS, Math.round(finite(projectDurationMs, 1_000)));
  const width = clamp(finite(overlay.width, 0.2), MIN_OVERLAY_SIZE, 1);
  const height = clamp(finite(overlay.height, 0.12), MIN_OVERLAY_SIZE, 1);
  const x = clamp(finite(overlay.x, 0.4), 0, 1 - width);
  const y = clamp(finite(overlay.y, 0.4), 0, 1 - height);
  const startMs = clamp(Math.round(finite(overlay.startMs, 0)), 0, durationMs - MIN_OVERLAY_DURATION_MS);
  const endMs = clamp(
    Math.round(finite(overlay.endMs, durationMs)),
    startMs + MIN_OVERLAY_DURATION_MS,
    durationMs,
  );
  const common = {
    id: String(overlay.id || ""),
    startMs,
    endMs,
    x,
    y,
    width,
    height,
  };
  if (overlay.type === "text") {
    return {
      ...common,
      type: "text",
      text: String(overlay.text ?? ""),
      fontSize: clamp(finite(overlay.fontSize, 32), 12, 120),
    };
  }
  if (overlay.type === "arrow") {
    return {
      ...common,
      type: "arrow",
      direction: overlay.direction === "left" ? "left" : "right",
    };
  }
  return { ...common, type: overlay.type };
}

export function validateOverlay(overlay: EditorOverlay, projectDurationMs: number) {
  if (!Number.isFinite(projectDurationMs) || projectDurationMs < MIN_OVERLAY_DURATION_MS) {
    return { valid: false, error: "Project duration is invalid." };
  }
  const values = [overlay.startMs, overlay.endMs, overlay.x, overlay.y, overlay.width, overlay.height];
  if (!overlay.id.trim()) return { valid: false, error: "Overlay ID is required." };
  if (!values.every(Number.isFinite)) return { valid: false, error: "Overlay values must be finite." };
  if (overlay.startMs < 0 || overlay.endMs <= overlay.startMs || overlay.endMs > projectDurationMs) {
    return { valid: false, error: "Overlay time range is outside the project." };
  }
  if (overlay.width < MIN_OVERLAY_SIZE || overlay.height < MIN_OVERLAY_SIZE) {
    return { valid: false, error: "Overlay is smaller than the minimum size." };
  }
  if (overlay.x < 0 || overlay.y < 0 || overlay.x + overlay.width > 1 || overlay.y + overlay.height > 1) {
    return { valid: false, error: "Overlay geometry is outside the canvas." };
  }
  if (overlay.type === "text" && (!Number.isFinite(overlay.fontSize) || overlay.fontSize < 12 || overlay.fontSize > 120)) {
    return { valid: false, error: "Text font size is invalid." };
  }
  return { valid: true, error: "" };
}

export function createOverlay(
  type: EditorOverlayType,
  input: Readonly<{ id: string; atMs: number; projectDurationMs: number }>,
): EditorOverlay {
  const durationMs = Math.max(1_000, Math.round(finite(input.projectDurationMs, 1_000)));
  const endMs = clamp(Math.round(finite(input.atMs, 0)) + 3_000, MIN_OVERLAY_DURATION_MS, durationMs);
  const startMs = clamp(Math.round(finite(input.atMs, 0)), 0, endMs - MIN_OVERLAY_DURATION_MS);
  if (type === "text") {
    return normalizeOverlay({
      id: input.id,
      type,
      startMs,
      endMs,
      x: 0.3,
      y: 0.18,
      width: 0.4,
      height: 0.16,
      text: "输入文字",
      fontSize: 36,
    }, durationMs);
  }
  if (type === "arrow") {
    return normalizeOverlay({
      id: input.id,
      type,
      startMs,
      endMs,
      x: 0.32,
      y: 0.42,
      width: 0.36,
      height: 0.1,
      direction: "right",
    }, durationMs);
  }
  return normalizeOverlay({
    id: input.id,
    type,
    startMs,
    endMs,
    x: 0.32,
    y: 0.3,
    width: 0.36,
    height: 0.3,
  }, durationMs);
}

export function patchOverlay(
  overlay: EditorOverlay,
  patch: Partial<EditorOverlay>,
  projectDurationMs: number,
): EditorOverlay {
  return normalizeOverlay({ ...overlay, ...patch } as EditorOverlay, projectDurationMs);
}

export function overlaysVisibleAt(overlays: readonly EditorOverlay[] | undefined, timeMs: number) {
  const safeTime = finite(timeMs, 0);
  return (overlays ?? []).filter((overlay) => safeTime >= overlay.startMs && safeTime < overlay.endMs);
}

export type OverlayCanvasContext = Pick<CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "strokeRect" | "ellipse" | "fillText" | "strokeText"
> & Partial<Pick<CanvasRenderingContext2D,
  "font" | "fillStyle" | "strokeStyle" | "lineWidth" | "lineCap" | "lineJoin" | "textAlign" | "textBaseline"
>>;

export function drawEditorOverlay(
  context: OverlayCanvasContext,
  overlay: EditorOverlay,
  canvasWidth: number,
  canvasHeight: number,
) {
  const x = overlay.x * canvasWidth;
  const y = overlay.y * canvasHeight;
  const width = overlay.width * canvasWidth;
  const height = overlay.height * canvasHeight;
  const strokeWidth = Math.max(3, Math.round(Math.min(canvasWidth, canvasHeight) / 180));
  context.save();
  context.strokeStyle = "#ffffff";
  context.fillStyle = "#ffffff";
  context.lineWidth = strokeWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (overlay.type === "text") {
    const fontSize = Math.max(12, Math.round(overlay.fontSize * canvasWidth / 1920));
    context.font = `700 ${fontSize}px Microsoft YaHei, sans-serif`;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.lineWidth = Math.max(2, Math.round(fontSize / 9));
    context.strokeStyle = "rgba(0, 0, 0, 0.82)";
    const lines = overlay.text.split(/\r?\n/).slice(0, 8);
    lines.forEach((line, index) => {
      const lineY = y + index * fontSize * 1.25;
      context.strokeText(line, x, lineY, width);
      context.fillText(line, x, lineY, width);
    });
  } else if (overlay.type === "rectangle") {
    context.strokeRect(x, y, width, height);
  } else if (overlay.type === "circle") {
    context.beginPath();
    context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    context.stroke();
  } else if (overlay.type === "arrow") {
    const startX = overlay.direction === "left" ? x + width : x;
    const endX = overlay.direction === "left" ? x : x + width;
    const centerY = y + height / 2;
    const head = Math.min(width * 0.28, Math.max(12, height * 0.8));
    context.beginPath();
    context.moveTo(startX, centerY);
    context.lineTo(endX, centerY);
    context.moveTo(endX, centerY);
    context.lineTo(overlay.direction === "left" ? endX + head : endX - head, centerY - head * 0.58);
    context.moveTo(endX, centerY);
    context.lineTo(overlay.direction === "left" ? endX + head : endX - head, centerY + head * 0.58);
    context.stroke();
  }
  context.restore();
}

export function drawEditorOverlaysAt(
  context: OverlayCanvasContext,
  overlays: readonly EditorOverlay[] | undefined,
  timeMs: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const visible = overlaysVisibleAt(overlays, timeMs);
  visible.forEach((overlay) => drawEditorOverlay(context, overlay, canvasWidth, canvasHeight));
  return visible.length;
}
