"use client";

import { useLayoutEffect } from "react";

/** Measure only the navigation layout; editor state and DOM remain in place. */
export default function EditorHeaderOffset() {
  useLayoutEffect(() => {
    const header = document.querySelector<HTMLElement>(".platform-header");
    const scope = document.querySelector<HTMLElement>("[data-editor-layout]");
    if (!header || !scope) return;
    const update = (height = header.offsetHeight) => scope.style.setProperty("--editor-nav-height", `${height}px`);
    update();
    const observer = new ResizeObserver(([entry]) => update(entry.borderBoxSize[0]?.blockSize ?? header.offsetHeight));
    observer.observe(header);
    // Opening the inline editor replaces a long form. Do not inherit that
    // form's scroll offset and start halfway down the newly opened workspace.
    const studio = scope.querySelector(".editor-studio");
    let editing = false;
    const onModeChange = () => {
      const next = studio?.classList.contains("editor-active") ?? false;
      if (next && !editing && document.scrollingElement) document.scrollingElement.scrollTop = 0;
      editing = next;
    };
    const modeObserver = new MutationObserver(onModeChange);
    if (studio) modeObserver.observe(studio, { attributes: true, attributeFilter: ["class"] });
    onModeChange();
    return () => {
      observer.disconnect();
      modeObserver.disconnect();
      scope.style.removeProperty("--editor-nav-height");
    };
  }, []);
  return null;
}
