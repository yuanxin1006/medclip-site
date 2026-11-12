import { createElement as h } from "react";
import type { VideoSemanticAnalysis } from "./editor-video-semantic.ts";
import { clipReviewReasons } from "./editor-clip-evidence.ts";
export function ClipEvidencePanel({ analyses, assets }: {
    analyses: readonly VideoSemanticAnalysis[];
    assets: readonly {
        id: string;
        name: string;
    }[];
}) {
    const assetViews = analyses.map(a => {
        const segments = a.segments.map(s => {
            const e = s.visualEvidence;
            const frames = e?.frames.map(f => {
                const predictions = f.predictions.map(p => h("div", { key: p.label }, p.label + "，score " + p.score.toFixed(6) + "，cosine " + p.cosineSimilarity.toFixed(6)));
                return h("figure", { key: f.sourceTimeMs }, h("img", { src: f.image, alt: "实际取样帧 " + f.sourceTimeMs + " ms", width: 384, height: 216, style: { maxWidth: "100%", objectFit: "contain" } }), h("figcaption", null, "源时间 " + f.sourceTimeMs + " ms"), h("details", null, h("summary", null, "候选概念与相似度（非准确率）"), ...predictions));
            }) ?? [];
            return h("section", { key: s.id }, h("p", null, "源 " + s.startMs + "–" + s.endMs + " ms，" + s.concepts.join(" / ")), e ? h("small", null, e.model.id + " @ " + e.model.revision + "，" + e.model.labelSetVersion) : null, h("p", { role: "note" }, e ? clipReviewReasons(e).join("；") : "旧版证据：请重新分析"), ...frames);
        });
        return h("details", { key: a.assetId }, h("summary", null, (assets.find(x => x.id === a.assetId)?.name ?? a.assetId) + "，" + a.segments.length + " 个源范围，需要人工确认"), ...segments);
    });
    return h("div", { className: "plan-evidence-panel", "aria-label": "真实视觉取样证据" }, ...assetViews);
}
