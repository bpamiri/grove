import { useState, useCallback, useMemo, useRef, useEffect, lazy, Suspense } from "react";
import { useWebSocket, type WsMessage } from "./hooks/useWebSocket";

import { useTasks, type Task } from "./hooks/useTasks";
import { useSkills } from "./hooks/useSkills";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { usePersistedState } from "./hooks/usePersistedState";
import { useChat } from "./hooks/useChat";
import Sidebar from "./components/Sidebar";
import TaskList from "./components/TaskList";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import Dashboard from "./components/Dashboard";

const DagEditor = lazy(() => import("./components/DagEditor"));

export type StatusFilter = "all" | "active" | "failed" | "done" | "closed";

type View = "tasks" | "settings" | "dashboard" | "dag";
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

function useDragResize(initial: number, min: number, max: number, direction: "left" | "right", storageKey?: string) {
  const [width, setWidth] = usePersistedState(storageKey, initial, localStorage);
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
  }, [width, min, max, direction, setWidth]);

  return { width, onMouseDown };
}

export default function App() {
  const [view, setView] = usePersistedState<View>("grove-active-view", "tasks", sessionStorage);
  const [mobileTab, setMobileTab] = usePersistedState<MobileTab>("grove-mobile-tab", "tasks", sessionStorage);
  const isMobile = useIsMobile();
  const [lastWsMsg, setLastWsMsg] = useState<WsMessage | null>(null);
  const [wsMessages, setWsMessages] = useState<WsMessage[]>([]);
  const taskState = useTasks();
  const skillsState = useSkills();
  const { connected, send } = useWebSocket({
    onMessage: useCallback((msg: WsMessage) => {
      taskState.handleWsMessage(msg);
      chatState.handleWsMessage(msg);
      skillsState.handleWsMessage(msg);
      setLastWsMsg(msg);
      setWsMessages(prev => [...prev.slice(-50), msg]);
    }, []),
  });
  const chatState = useChat(send);

  const sidebar = useDragResize(240, 160, 400, "left", "grove-sidebar-width");
  const chat = useDragResize(320, 200, 600, "right", "grove-chat-width");

  const [statusFilter, setStatusFilter] = useLocalStorage<StatusFilter>("grove-status-filter", "active");

  /** Apply status filter to a task list */
  const applyStatusFilter = useCallback((tasks: Task[], filter: StatusFilter) => {
    if (filter === "active") return tasks.filter(t => ["draft", "queued", "active"].includes(t.status));
    if (filter === "failed") return tasks.filter(t => t.status === "failed");
    if (filter === "done") return tasks.filter(t => t.status === "completed");
    if (filter === "closed") return tasks.filter(t => t.status === "closed");
    // "all" shows everything except closed (like completed, they're dismissed)
    return tasks.filter(t => t.status !== "closed");
  }, []);

  /** Tasks filtered by status (for counts), then further by selected tree (for display) */
  const statusFiltered = useMemo(() => applyStatusFilter(taskState.tasks, statusFilter), [taskState.tasks, statusFilter, applyStatusFilter]);
  const displayedTasks = useMemo(() => {
    if (!taskState.selectedTree) return statusFiltered;
    return statusFiltered.filter(t => t.tree_id === taskState.selectedTree);
  }, [statusFiltered, taskState.selectedTree]);

  const selectedTreeName = useMemo(() => {
    if (!taskState.selectedTree) return null;
    return taskState.trees.find(t => t.id === taskState.selectedTree)?.name ?? null;
  }, [taskState.selectedTree, taskState.trees]);

  /** Per-tree task counts reflecting the active status filter */
  const treeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of statusFiltered) {
      const key = t.tree_id ?? "__none__";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [statusFiltered]);

  if (isMobile) {
    return (
      <div className="flex flex-col fixed inset-0 overflow-hidden">
        {/* Mobile content area */}
        <div className="flex-1 overflow-y-auto">
          {mobileTab === "trees" && (
            <Sidebar
              trees={taskState.trees}
              status={taskState.status}
              taskCount={statusFiltered.length}
              treeCounts={treeCounts}
              selectedTree={taskState.selectedTree}
              onSelectTree={(id) => {
                taskState.setSelectedTree(id);
                setView("tasks");
                setMobileTab("tasks");
              }}
              connected={connected}
              onSettingsClick={() => { setView("settings"); setMobileTab("tasks"); }}
              onDashboardClick={() => { setView("dashboard"); setMobileTab("tasks"); }}
              onDagClick={() => { setView("dag"); setMobileTab("tasks"); }}
            />
          )}
          {mobileTab === "tasks" && (
            view === "tasks" ? (
              <TaskList
                tasks={displayedTasks}
                trees={taskState.trees}
                paths={taskState.paths}
                getActivity={taskState.getActivity}
                getActivityLog={taskState.getActivityLog}
                loadActivityLog={taskState.loadActivityLog}
                onRefresh={taskState.refresh}
                send={send}
                wsMessage={lastWsMsg}
                filter={statusFilter}
                onFilterChange={setStatusFilter}
                selectedTreeName={selectedTreeName}
                selectedTree={taskState.selectedTree}
                allTasks={taskState.tasks}
              />
            ) : view === "dag" ? (
              <Suspense fallback={<div className="text-zinc-500 p-4">Loading DAG editor...</div>}>
                <div className="h-[500px]">
                  <DagEditor onSelectTask={(id) => { taskState.setSelectedTree(null); setView("tasks"); }} treeId={taskState.selectedTree} />
                </div>
              </Suspense>
            ) : view === "dashboard" ? (
              <Dashboard wsMessages={wsMessages} status={taskState.status} trees={taskState.trees} selectedTree={taskState.selectedTree} />
            ) : (
              <Settings
                trees={taskState.trees}
                status={taskState.status}
                paths={taskState.paths}
                onRefresh={taskState.refresh}
                skills={skillsState.skills}
                skillsLoading={skillsState.loading}
                onInstallSkill={skillsState.install}
                onRemoveSkill={skillsState.remove}
              />
            )
          )}
          {mobileTab === "chat" && (
            <Chat
              messages={chatState.messages}
              onSend={chatState.sendMessage}
              onReset={chatState.clearMessages}
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
          taskCount={statusFiltered.length}
          treeCounts={treeCounts}
          selectedTree={taskState.selectedTree}
          onSelectTree={(id) => {
            taskState.setSelectedTree(id);
            setView("tasks");
          }}
          connected={connected}
          onSettingsClick={() => setView("settings")}
          onDashboardClick={() => { setView("dashboard"); }}
          onDagClick={() => { setView("dag"); }}
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
            tasks={displayedTasks}
            trees={taskState.trees}
            paths={taskState.paths}
            getActivity={taskState.getActivity}
            getActivityLog={taskState.getActivityLog}
            loadActivityLog={taskState.loadActivityLog}
            onRefresh={taskState.refresh}
            send={send}
            wsMessage={lastWsMsg}
            filter={statusFilter}
            onFilterChange={setStatusFilter}
            selectedTreeName={selectedTreeName}
            selectedTree={taskState.selectedTree}
            allTasks={taskState.tasks}
          />
        ) : view === "dag" ? (
          <Suspense fallback={<div className="text-zinc-500 p-4">Loading DAG editor...</div>}>
            <div className="h-[500px]">
              <DagEditor onSelectTask={(id) => { taskState.setSelectedTree(null); setView("tasks"); }} />
            </div>
          </Suspense>
        ) : view === "dashboard" ? (
          <Dashboard wsMessages={wsMessages} status={taskState.status} />
        ) : (
          <Settings
            trees={taskState.trees}
            status={taskState.status}
            paths={taskState.paths}
            onRefresh={taskState.refresh}
            skills={skillsState.skills}
            skillsLoading={skillsState.loading}
            onInstallSkill={skillsState.install}
            onRemoveSkill={skillsState.remove}
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
          onReset={chatState.clearMessages}
          bottomRef={chatState.bottomRef}
          connected={connected}
          thinking={chatState.thinking}
        />
      </div>
    </div>
  );
}
