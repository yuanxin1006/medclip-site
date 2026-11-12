import {CLIP_TEST_ENABLED} from "./editor-clip-evidence.ts";
import type { TimelineCaption } from "./editor-core.ts";
import type { CaptionConceptInput } from "./editor-proposal-orchestrator.ts";

const BASE_VISUAL_TOPICS = [
  {
    id: "doctor",
    label: "a doctor talking with a patient in a clinic",
    title: "医生问诊",
    keywords: ["医生", "医师", "问诊", "就诊", "患者", "咨询", "门诊", "主诉", "症状", "病史", "体征"],
  },
  {
    id: "physical-exam",
    label: "a clinician performing a physical examination of a patient",
    title: "体格检查",
    keywords: ["查体", "体格检查", "视诊", "触诊", "叩诊", "嗅诊", "视触叩听"],
  },
  {
    id: "anatomy",
    label: "a medical anatomy illustration of a human organ",
    title: "人体结构",
    keywords: ["心脏", "肺", "肝", "肾", "血管", "器官", "组织", "细胞", "人体", "眼", "口腔", "皮肤", "骨骼", "神经", "肿瘤", "癌"],
  },
  {
    id: "medicine",
    label: "medicine pills treatment or vaccination",
    title: "药物治疗",
    keywords: ["药", "用药", "治疗", "疫苗", "注射", "剂量", "服用", "疗法", "手段", "处方", "抗生素"],
  },
  {
    id: "test",
    label: "a medical examination laboratory test or health report",
    title: "检查报告",
    keywords: ["检查", "化验", "报告", "指标", "检测", "筛查", "诊断", "影像", "血压", "血糖", "核磁", "ct", "超声", "检验"],
  },
  {
    id: "exercise",
    label: "healthy exercise walking or rehabilitation training",
    title: "运动康复",
    keywords: ["运动", "锻炼", "步行", "康复", "训练", "活动", "跑步", "拉伸", "力量", "有氧"],
  },
  {
    id: "food",
    label: "healthy food nutrition vegetables and fruit",
    title: "饮食营养",
    keywords: ["饮食", "营养", "蔬菜", "水果", "食物", "摄入", "盐", "糖", "蛋白质", "脂肪", "维生素", "热量"],
  },
  {
    id: "lifestyle",
    label: "healthy daily lifestyle sleep and self care",
    title: "健康生活",
    keywords: ["生活", "睡眠", "作息", "戒烟", "饮酒", "预防", "健康", "习惯", "压力", "情绪", "休息", "风险"],
  },
  {
    id: "city-night",
    label: "a city street at night with buildings and lights",
    title: "城市夜景",
    keywords: ["城市", "夜晚", "夜景", "夜色", "街道", "霓虹", "高楼"],
  },
  {
    id: "campus-activity",
    label: "students taking part in an activity on a school campus",
    title: "校园活动",
    keywords: ["校园", "学校", "活动", "运动会", "学生", "操场", "课堂"],
  },
  {
    id: "high-energy-ending",
    label: "a high-energy celebration or lively event finale",
    title: "高能量收尾",
    keywords: ["结束", "结尾", "高潮", "高能量", "庆祝", "欢呼", "收尾"],
  },
  {
    id: "hospital",
    label: "a hospital room medical equipment or surgery",
    title: "医院设备",
    keywords: ["医院", "住院", "手术", "设备", "监护", "急诊", "病房", "仪器", "手术室", "救护", "听诊"],
  },
] as const;

export const EDITOR_VISUAL_TOPICS = CLIP_TEST_ENABLED ? [...BASE_VISUAL_TOPICS, ...[{"id":"auscultation","label":"a clinician using a stethoscope to listen to a patient's chest","title":"胸部听诊","keywords":["听诊","听呼吸"]},{"id":"blood-pressure","label":"a clinician measuring blood pressure with a cuff on a patient's upper arm","title":"测量血压","keywords":["血压"]},{"id":"xray-reading","label":"a doctor looking at an X-ray image on a light box","title":"阅片","keywords":["阅片","胸片"]},{"id":"shoulder-exam","label":"a clinician testing a patient's shoulder and arm movement","title":"肩臂活动检查","keywords":["肩","关节活动"]},{"id":"care","label":"a doctor shaking hands with a patient and offering emotional support","title":"握手关怀","keywords":["握手","关怀"]},{"id":"non-procedure","label":"an anatomy diagram or close-up of an eye nose or knee with no clinical procedure","title":"非操作示意图","keywords":[]},{"id":"text-only","label":"an educational slide containing only text and no people or clinical procedure","title":"文字页面","keywords":[]},{"id":"unrelated","label":"an unrelated scene with no medical procedure","title":"无关画面","keywords":[]}]] as const : BASE_VISUAL_TOPICS;

export function editorTopicsForTextV1(text: string) {
  const normalized = text.toLowerCase();
  return EDITOR_VISUAL_TOPICS
    .map((topic) => {
      const hits = topic.keywords.filter((keyword) => normalized.includes(keyword));
      const score = hits.reduce((total, keyword) => total + Math.max(1, keyword.length / 2), 0);
      return { topic, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
}

export function deriveEditorCaptionConceptsV1(
  captions: readonly TimelineCaption[],
): readonly CaptionConceptInput[] {
  return Object.freeze(captions.map((caption) => Object.freeze({
    captionId: caption.id,
    concepts: Object.freeze(editorTopicsForTextV1(caption.text).map((item) => item.topic.title)),
  })));
}
