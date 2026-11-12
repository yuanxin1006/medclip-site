import EditorStudio from "./EditorStudio";
import visual from "./EditorVisual.module.css";
import EditorHeaderOffset from "./EditorHeaderOffset";

export default function EditorPage() {
  return <div className={visual.scope} data-editor-layout><EditorStudio /><EditorHeaderOffset /></div>;
}
