import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket, type WsMessage } from "./hooks/useWebSocket";

import { useTasks } from "./hooks/useTasks";
import { useChat } from "./hooks/useChat";
import Sidebar from "./components/Sidebar";
import TaskList from "./components/TaskList";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import Dashboard from "./components/Dashboard";

type View = "tasks" | "settings" | "dashboard";
type MobileTab = "trees" | "tasks" | "chat";

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return mobile;
}

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
  const [mobileTab, setMobileTab] = useState<MobileTab>("tasks");
  const isMobile = useIsMobile();
  const [lastWsMsg, setLastWsMsg] = useState<WsMessage | null>(null);
  const [wsMessages, setWsMessages] = useState<WsMessage[]>([]);
  const taskState = useTasks();
  const { connected, send } = useWebSocket({
    onMessage: useCallback((msg: WsMessage) => {
      taskState.handleWsMessage(msg);
      chatState.handleWsMessage(msg);
      setLastWsMsg(msg);
      setWsMessages(prev => [...prev.slice(-50), msg]);
    }, []),
  });
  const chatState = useChat(send);

  const sidebar = useDragResize(240, 160, 400, "left");
  const chat = useDragResize(320, 200, 600, "right");

  const activeTaskCount = taskState.tasks.filter(t =>
    ["draft", "queued", "active"].includes(t.status)
  ).length || taskState.tasks.length;

  if (isMobile) {
    return (
      <div className="flex flex-col fixed inset-0 overflow-hidden">
        {/* Mobile content area */}
        <div className="flex-1 overflow-y-auto">
          {mobileTab === "trees" && (
            <Sidebar
              trees={taskState.trees}
              status={taskState.status}
              taskCount={activeTaskCount}
              selectedTree={taskState.selectedTree}
              onSelectTree={(id) => {
                taskState.setSelectedTree(id);
                setView("tasks");
                setMobileTab("tasks");
              }}
              connected={connected}
              onSettingsClick={() => { setView("settings"); setMobileTab("tasks"); }}
              onDashboardClick={() => { setView("dashboard"); setMobileTab("tasks"); }}
            />
          )}
          {mobileTab === "tasks" && (
            view === "tasks" ? (
              <TaskList
                tasks={taskState.tasks}
                trees={taskState.trees}
                paths={taskState.paths}
                getActivity={taskState.getActivity}
                getActivityLog={taskState.getActivityLog}
                loadActivityLog={taskState.loadActivityLog}
                onRefresh={taskState.refresh}
                send={send}
                wsMessage={lastWsMsg}
              />
            ) : view === "dashboard" ? (
              <Dashboard wsMessages={wsMessages} status={taskState.status} />
            ) : (
              <Settings
                trees={taskState.trees}
                status={taskState.status}
                onRefresh={taskState.refresh}
              />
            )
          )}
          {mobileTab === "chat" && (
            <Chat
              messages={chatState.messages}
              onSend={chatState.sendMessage}
              bottomRef={chatState.bottomRef}
              connected={connected}
              thinking={chatState.thinking}
            />
          )}
        </div>

        {/* Mobile tab bar */}
        <nav className="flex border-t border-zinc-800 bg-zinc-900">
          {([
            { id: "trees" as const, label: "Trees" },
            { id: "tasks" as const, label: "Tasks" },
            { id: "chat" as const, label: "Chat" },
          ]).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setMobileTab(tab.id)}
              className={`flex-1 py-3 text-xs font-medium uppercase tracking-wider ${
                mobileTab === tab.id
                  ? "text-emerald-400 border-t-2 border-emerald-400 -mt-px"
                  : "text-zinc-500"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="flex fixed inset-0 overflow-hidden">
      {/* Left Sidebar */}
      <div style={{ width: sidebar.width, minWidth: sidebar.width }} className="flex-shrink-0">
        <Sidebar
          trees={taskState.trees}
          status={taskState.status}
          taskCount={activeTaskCount}
          selectedTree={taskState.selectedTree}
          onSelectTree={(id) => {
            taskState.setSelectedTree(id);
            setView("tasks");
          }}
          connected={connected}
          onSettingsClick={() => setView("settings")}
          onDashboardClick={() => { setView("dashboard"); }}
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
            paths={taskState.paths}
            getActivity={taskState.getActivity}
            getActivityLog={taskState.getActivityLog}
            loadActivityLog={taskState.loadActivityLog}
            onRefresh={taskState.refresh}
            send={send}
            wsMessage={lastWsMsg}
          />
        ) : view === "dashboard" ? (
          <Dashboard wsMessages={wsMessages} status={taskState.status} />
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
          thinking={chatState.thinking}
        />
      </div>
    </div>
  );
}
