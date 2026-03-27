import { useState, useCallback, useRef } from "react";
import { useWebSocket, type WsMessage } from "./hooks/useWebSocket";
import { useTasks } from "./hooks/useTasks";
import { useChat } from "./hooks/useChat";
import Sidebar from "./components/Sidebar";
import TaskList from "./components/TaskList";
import Chat from "./components/Chat";
import Settings from "./components/Settings";

type View = "tasks" | "settings";

function useDragResize(initial: number, min: number, max: number, direction: "left" | "right") {
  const [width, setWidth] = useState(initial);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      const newW = direction === "left"
        ? startW.current + delta
        : startW.current - delta;
      setWidth(Math.max(min, Math.min(max, newW)));
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [width, min, max, direction]);

  return { width, onMouseDown };
}

export default function App() {
  const [view, setView] = useState<View>("tasks");
  const taskState = useTasks();
  const { connected, send } = useWebSocket({
    onMessage: useCallback((msg: WsMessage) => {
      taskState.handleWsMessage(msg);
      chatState.handleWsMessage(msg);
    }, []),
  });
  const chatState = useChat(send);

  const sidebar = useDragResize(240, 160, 400, "left");
  const chat = useDragResize(320, 200, 600, "right");

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left Sidebar */}
      <div style={{ width: sidebar.width, minWidth: sidebar.width }} className="flex-shrink-0">
        <Sidebar
          trees={taskState.trees}
          status={taskState.status}
          selectedTree={taskState.selectedTree}
          onSelectTree={(id) => {
            taskState.setSelectedTree(id);
            setView("tasks");
          }}
          connected={connected}
          view={view}
          onViewChange={setView}
        />
      </div>

      {/* Drag handle: sidebar ↔ center */}
      <div
        onMouseDown={sidebar.onMouseDown}
        className="w-1 flex-shrink-0 bg-zinc-800 hover:bg-emerald-500/40 cursor-col-resize transition-colors"
      />

      {/* Center */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        {view === "tasks" ? (
          <TaskList
            tasks={taskState.tasks}
            trees={taskState.trees}
            getActivity={taskState.getActivity}
            getActivityLog={taskState.getActivityLog}
            onRefresh={taskState.refresh}
          />
        ) : (
          <Settings
            trees={taskState.trees}
            status={taskState.status}
            onRefresh={taskState.refresh}
          />
        )}
      </main>

      {/* Drag handle: center ↔ chat */}
      <div
        onMouseDown={chat.onMouseDown}
        className="w-1 flex-shrink-0 bg-zinc-800 hover:bg-emerald-500/40 cursor-col-resize transition-colors"
      />

      {/* Right: Chat */}
      <div style={{ width: chat.width, minWidth: chat.width }} className="flex-shrink-0 flex flex-col">
        <Chat
          messages={chatState.messages}
          onSend={chatState.sendMessage}
          bottomRef={chatState.bottomRef}
          connected={connected}
        />
      </div>
    </div>
  );
}
