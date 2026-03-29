import { useState, useCallback, useRef, useEffect } from "react";
import { loadPaneSizes, savePaneSizes, clampWidth, type PaneSizes } from "../lib/pane-storage";

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 480;
const CHAT_MIN = 240;
const CHAT_MAX = 560;

export function usePaneSizes() {
  const [sizes, setSizes] = useState<PaneSizes>(loadPaneSizes);
  const dragging = useRef<"sidebar" | "chat" | null>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback(
    (pane: "sidebar" | "chat", e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = pane;
      startX.current = e.clientX;
      startWidth.current = pane === "sidebar" ? sizes.sidebar : sizes.chat;
    },
    [sizes],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const pane = dragging.current;

      setSizes((prev) => {
        const isChat = pane === "chat";
        // Chat handle: dragging left increases chat width (negative delta = wider)
        const raw = startWidth.current + (isChat ? -delta : delta);
        const [min, max] = isChat ? [CHAT_MIN, CHAT_MAX] : [SIDEBAR_MIN, SIDEBAR_MAX];
        const clamped = clampWidth(raw, min, max);
        return { ...prev, [pane]: clamped };
      });
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      // Persist on drag end
      setSizes((current) => {
        savePaneSizes(current);
        return current;
      });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return { sizes, onMouseDown };
}
